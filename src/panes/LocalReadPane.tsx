import {
  computed,
  defineComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  Teleport,
  type ComponentPublicInstance,
} from 'vue'
import { open } from '@tauri-apps/plugin-dialog'
import {
  commands,
  LocalReaderPage,
  LocalReaderPages,
  LocalReaderSource,
} from '../bindings.ts'
import { useReaderFullscreen } from '../composables/useReaderFullscreen.ts'
import {
  cancelFolderListMode,
  formatSourceProgressLabel,
  getSourceRecord,
  getSavedReadPageOneBased,
  loadFolderSourceProgress,
  markSourceOpened,
  saveSourceReadPage,
  setCurrentFolderPath,
} from '../localReadStore.ts'
import {
  computeContentRatio,
  computeVisiblePageIndex,
  getPageTopInScroller,
  seekToContentRatio,
} from '../readerProgressMath.ts'
import { NButton, NEmpty, NInput, NSlider, useMessage } from 'naive-ui'
import styles from './ComicReadPane.module.css'
import localStyles from './LocalReadPane.module.css'

const PREFETCH_ROOT_MARGIN = '800px 0px'
const FOLDER_MAX_CONCURRENT_LOADS = 4
const ZIP_MAX_CONCURRENT_LOADS = 2
const NEIGHBOR_PRELOAD_RADIUS = 3
const SLIDER_SCALE = 1000

function isZipPath(path: string): boolean {
  const lower = path.toLowerCase()
  return lower.endsWith('.zip') || lower.endsWith('.cbz')
}

function normalizeDialogPath(selected: string | string[] | null): string | null {
  if (selected === null) return null
  if (Array.isArray(selected)) return selected[0] ?? null
  return selected
}

const TEXT = {
  openFail: '無法開啟此檔案或資料夾',
  folderFail: '無法讀取資料夾',
  folderEmpty: '此資料夾內沒有可閱讀的 ZIP 或圖片子資料夾',
  pickChapter: '請選擇要閱讀的篇章',
  cancel: '取消',
  folderKind: '資料夾',
  title: '本地閱讀',
  empty: '從本地 ZIP 或資料夾開啟漫畫',
  openZip: '開啟 ZIP 檔',
  openFolder: '開啟資料夾',
  folderHint: '資料夾模式會列出目錄內所有 ZIP 或子資料夾，選擇後開始閱讀。',
  close: '關閉',
  loadFail: '載入失敗',
  prevBook: '上一本',
  nextBook: '下一本',
  fullscreen: '全視窗',
  windowMode: '視窗模式',
  pageCounter: (current: number, total: number) => `${current}/${total}`,
  loadPercent: (pct: number) => `${pct}%`,
  pageJumpInvalid: '頁碼無效',
} as const

export default defineComponent({
  name: 'LocalReadPane',
  setup() {
    const message = useMessage()
    const { isFullscreen, toggleFullscreen, exitFullscreen } = useReaderFullscreen()

    const readerPages = ref<LocalReaderPage[]>([])
    const readerTitle = ref('')
    const readingActive = ref(false)
    const pickingSource = ref(false)
    const sourceListMode = ref(false)
    const folderLabel = ref('')
    const folderSources = ref<LocalReaderSource[]>([])
    const currentSourceIndex = ref(-1)
    const currentSourcePath = ref('')
    const currentPageIndex = ref(0)
    const sliderValue = ref(0)
    const pageSrcMap = ref<Map<number, string>>(new Map())
    const loadingIndices = ref<Set<number>>(new Set())
    const failedIndices = ref<Set<number>>(new Set())
    const scrollStreamRef = ref<HTMLElement | null>(null)
    const thumbStripRef = ref<HTMLElement | null>(null)
    const pageInputRef = ref<{ focus: () => void; select: () => void } | null>(null)
    const readerSessionId = ref(0)
    const activeLoads = ref(0)
    const sliderSeeking = ref(false)
    const pageInputEditing = ref(false)
    const pageInputDraft = ref('')

    let loadQueue: number[] = []
    let priorityLoadQueue: number[] = []
    let saveTimer: ReturnType<typeof setTimeout> | undefined
    let scrollPrioritizeTimer: ReturnType<typeof setTimeout> | undefined
    let observer: IntersectionObserver | undefined
    let scrollSyncFromCode = false
    let backgroundExpandCenter = 0
    let backgroundExpandCursor = 0
    /** 還原後鎖定頁碼，直到使用者主動捲動 */
    let pinnedPageIndex: number | null = null

    const totalPages = computed(() => readerPages.value.length)
    const currentPage = computed(() => currentPageIndex.value + 1)
    const currentPageMeta = computed(() => readerPages.value[currentPageIndex.value])
    const currentFilename = computed(() => currentPageMeta.value?.caption ?? '')

    const loadPercent = computed(() => {
      const total = totalPages.value
      if (total <= 0) return 0
      return Math.min(100, Math.round((pageSrcMap.value.size / total) * 100))
    })

    const inFolderReading = computed(
      () => sourceListMode.value && folderSources.value.length > 0 && readingActive.value,
    )
    const hasPrevBook = computed(() => inFolderReading.value && currentSourceIndex.value > 0)
    const hasNextBook = computed(
      () =>
        inFolderReading.value &&
        currentSourceIndex.value >= 0 &&
        currentSourceIndex.value < folderSources.value.length - 1,
    )

    const hasPrevPage = computed(() => currentPageIndex.value > 0)
    const hasNextPage = computed(() => currentPageIndex.value < totalPages.value - 1)

    function revokeAllBlobUrls() {
      for (const url of pageSrcMap.value.values()) {
        URL.revokeObjectURL(url)
      }
      pageSrcMap.value = new Map()
    }

    function closeZipSession() {
      void commands.closeLocalReaderZipSession()
    }

    function stopSaveTimer() {
      if (saveTimer !== undefined) {
        clearTimeout(saveTimer)
        saveTimer = undefined
      }
    }

    function stopScrollPrioritizeTimer() {
      if (scrollPrioritizeTimer !== undefined) {
        clearTimeout(scrollPrioritizeTimer)
        scrollPrioritizeTimer = undefined
      }
    }

    function clearReaderContent() {
      stopSaveTimer()
      stopScrollPrioritizeTimer()
      observer?.disconnect()
      observer = undefined
      readerSessionId.value += 1
      revokeAllBlobUrls()
      loadingIndices.value = new Set()
      failedIndices.value = new Set()
      activeLoads.value = 0
      loadQueue = []
      priorityLoadQueue = []
      backgroundExpandCenter = 0
      backgroundExpandCursor = 0
      pinnedPageIndex = null
      pageInputEditing.value = false
      closeZipSession()
    }

    function scheduleSavePosition() {
      stopSaveTimer()
      saveTimer = setTimeout(() => saveReadingPosition(), 400)
    }

    function saveReadingPosition() {
      if (!readingActive.value || !currentSourcePath.value) return
      saveSourceReadPage(
        currentSourcePath.value,
        currentPage.value,
        totalPages.value,
      )
    }

    function releasePinnedPage() {
      pinnedPageIndex = null
    }

    function onUserScrollIntent() {
      releasePinnedPage()
    }

    function syncProgressFromScroll() {
      const root = scrollStreamRef.value
      const total = totalPages.value
      if (!root || total <= 0) return
      const pageIndex = computeVisiblePageIndex(root)
      currentPageIndex.value = pageIndex
      if (!sliderSeeking.value) {
        sliderValue.value = Math.round(computeContentRatio(root, total, pageIndex) * SLIDER_SCALE)
      }
      syncThumbStripScroll()
    }

    function syncThumbStripScroll() {
      const strip = thumbStripRef.value
      if (!strip) return
      const item = strip.querySelector<HTMLElement>(`[data-thumb-index="${currentPageIndex.value}"]`)
      item?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
    }

    function onStreamScroll() {
      if (!readingActive.value || scrollSyncFromCode) return
      if (pinnedPageIndex !== null) {
        currentPageIndex.value = pinnedPageIndex
        updateSliderFromPageIndex(pinnedPageIndex)
        syncThumbStripScroll()
        return
      }
      syncProgressFromScroll()
      scheduleSavePosition()
      stopScrollPrioritizeTimer()
      scrollPrioritizeTimer = setTimeout(() => {
        scrollPrioritizeTimer = undefined
        const root = scrollStreamRef.value
        if (!root) return
        prioritizePageLoad(computeVisiblePageIndex(root))
      }, 120)
    }

    function maxConcurrentLoads() {
      return isZipPath(currentSourcePath.value) ? ZIP_MAX_CONCURRENT_LOADS : FOLDER_MAX_CONCURRENT_LOADS
    }

    function canStartLoad(index: number): boolean {
      return !pageSrcMap.value.has(index) && !loadingIndices.value.has(index)
    }

    function isQueuedForLoad(index: number): boolean {
      return priorityLoadQueue.includes(index) || loadQueue.includes(index)
    }

    function pumpLoadQueue() {
      while (activeLoads.value < maxConcurrentLoads()) {
        let index = priorityLoadQueue.shift()
        while (index !== undefined && !canStartLoad(index) && priorityLoadQueue.length > 0) {
          index = priorityLoadQueue.shift()
        }
        if (index === undefined) {
          index = loadQueue.shift()
          while (index !== undefined && !canStartLoad(index) && loadQueue.length > 0) {
            index = loadQueue.shift()
          }
        }
        if (index === undefined) {
          scheduleBackgroundLoads()
          return
        }
        if (!canStartLoad(index)) continue
        void loadPage(index)
      }
    }

    function enqueueBackgroundPage(index: number) {
      if (!readingActive.value || !canStartLoad(index) || isQueuedForLoad(index)) return
      if (failedIndices.value.has(index)) {
        const nextFailed = new Set(failedIndices.value)
        nextFailed.delete(index)
        failedIndices.value = nextFailed
      }
      loadQueue.push(index)
    }

    function scheduleBackgroundLoads() {
      const total = totalPages.value
      if (total <= 0 || priorityLoadQueue.length > 0 || activeLoads.value > 0) return
      const order = orderIndicesFromCenter(backgroundExpandCenter)
      while (backgroundExpandCursor < order.length) {
        const index = order[backgroundExpandCursor]!
        backgroundExpandCursor += 1
        if (!canStartLoad(index)) continue
        enqueueBackgroundPage(index)
        pumpLoadQueue()
        return
      }
    }

    function resetBackgroundExpand(center: number) {
      backgroundExpandCenter = center
      backgroundExpandCursor = 0
      loadQueue = loadQueue.filter((i) => canStartLoad(i) && !priorityLoadQueue.includes(i))
    }

    function orderIndicesFromCenter(center: number): number[] {
      const total = totalPages.value
      const ordered: number[] = []
      const seen = new Set<number>()
      for (let d = 0; d < total; d++) {
        for (const offset of [-d, d]) {
          const i = center + offset
          if (i < 0 || i >= total || seen.has(i)) continue
          seen.add(i)
          ordered.push(i)
        }
      }
      return ordered
    }

    function prioritizePageLoad(center: number, radius?: number) {
      const total = totalPages.value
      if (total <= 0) return
      let ordered = orderIndicesFromCenter(center).filter((i) => canStartLoad(i))
      if (radius !== undefined) {
        ordered = ordered.filter((i) => Math.abs(i - center) <= radius)
      }
      if (ordered.length === 0) return
      const drop = new Set(ordered)
      loadQueue = loadQueue.filter((i) => !drop.has(i))
      priorityLoadQueue = [...ordered, ...priorityLoadQueue.filter((i) => !drop.has(i))]
      resetBackgroundExpand(center)
      for (const i of ordered) {
        if (failedIndices.value.has(i)) {
          const nextFailed = new Set(failedIndices.value)
          nextFailed.delete(i)
          failedIndices.value = nextFailed
        }
      }
      pumpLoadQueue()
    }

    async function loadPage(index: number) {
      const session = readerSessionId.value
      const page = readerPages.value[index]
      if (!readingActive.value || page === undefined || pageSrcMap.value.has(index)) return

      const nextLoading = new Set(loadingIndices.value)
      nextLoading.add(index)
      loadingIndices.value = nextLoading
      activeLoads.value += 1

      const result = await commands.getLocalReaderImage(page.pageId)
      activeLoads.value -= 1

      const doneLoading = new Set(loadingIndices.value)
      doneLoading.delete(index)
      loadingIndices.value = doneLoading

      if (session !== readerSessionId.value || !readingActive.value) {
        pumpLoadQueue()
        return
      }

      if (result.status === 'error') {
        console.error(result.error)
        const nextFailed = new Set(failedIndices.value)
        nextFailed.add(index)
        failedIndices.value = nextFailed
        pumpLoadQueue()
        return
      }

      const blob = new Blob([new Uint8Array(result.data)])
      const src = URL.createObjectURL(blob)
      const nextMap = new Map(pageSrcMap.value)
      nextMap.set(index, src)
      pageSrcMap.value = nextMap
      pumpLoadQueue()
      scheduleBackgroundLoads()
    }

    function updateSliderFromPageIndex(pageIndex: number) {
      const total = totalPages.value
      if (total <= 1) {
        sliderValue.value = 0
        return
      }
      sliderValue.value = Math.round((pageIndex / (total - 1)) * SLIDER_SCALE)
    }

    function scrollToPageIndex(
      pageIndex: number,
      smooth = false,
      options?: { skipSave?: boolean },
    ) {
      const root = scrollStreamRef.value
      if (!root) return
      scrollSyncFromCode = true
      currentPageIndex.value = pageIndex
      updateSliderFromPageIndex(pageIndex)
      const top = getPageTopInScroller(root, pageIndex)
      root.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' })
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollSyncFromCode = false
          syncThumbStripScroll()
        })
      })
      if (!options?.skipSave) {
        scheduleSavePosition()
      }
    }

    function goToPage(index: number) {
      const total = totalPages.value
      if (total <= 0) return
      const next = Math.min(Math.max(0, index), total - 1)
      releasePinnedPage()
      prioritizePageLoad(next)
      scrollToPageIndex(next)
    }

    function goPrevPage() {
      if (hasPrevPage.value) goToPage(currentPageIndex.value - 1)
    }

    function goNextPage() {
      if (hasNextPage.value) goToPage(currentPageIndex.value + 1)
    }

    async function startPageInputEdit() {
      pageInputDraft.value = String(currentPage.value)
      pageInputEditing.value = true
      await nextTick()
      pageInputRef.value?.focus()
      pageInputRef.value?.select()
    }

    function commitPageInput() {
      if (!pageInputEditing.value) return
      const parsed = Number.parseInt(pageInputDraft.value.trim(), 10)
      pageInputEditing.value = false
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > totalPages.value) {
        message.warning(TEXT.pageJumpInvalid)
        return
      }
      goToPage(parsed - 1)
    }

    function onSliderUpdate(value: number) {
      sliderSeeking.value = true
      sliderValue.value = value
      const root = scrollStreamRef.value
      const total = totalPages.value
      if (!root || total <= 0) return
      scrollSyncFromCode = true
      const pageIndex = seekToContentRatio(root, total, value / SLIDER_SCALE)
      currentPageIndex.value = pageIndex
      syncThumbStripScroll()
      scrollSyncFromCode = false
    }

    function onSliderCommit() {
      sliderSeeking.value = false
      releasePinnedPage()
      const root = scrollStreamRef.value
      const total = totalPages.value
      if (!root || total <= 0) return
      scrollSyncFromCode = true
      const pageIndex = seekToContentRatio(root, total, sliderValue.value / SLIDER_SCALE)
      currentPageIndex.value = pageIndex
      scrollSyncFromCode = false
      prioritizePageLoad(pageIndex)
      syncThumbStripScroll()
      scheduleSavePosition()
    }

    function setupObserver() {
      observer?.disconnect()
      const root = scrollStreamRef.value
      if (!root) return
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue
            const index = Number((entry.target as HTMLElement).dataset.index)
            if (!Number.isNaN(index)) {
              prioritizePageLoad(index, NEIGHBOR_PRELOAD_RADIUS)
            }
          }
        },
        { root, rootMargin: PREFETCH_ROOT_MARGIN, threshold: 0 },
      )
    }

    function setPageRef(index: number, el: Element | ComponentPublicInstance | null) {
      const node = el instanceof HTMLElement ? el : (el as ComponentPublicInstance | null)?.$el
      if (node instanceof HTMLElement) {
        observer?.observe(node)
      }
    }

    function resolveInitialPageIndex(): number {
      const total = totalPages.value
      if (total <= 0) return 0
      if (!currentSourcePath.value) return 0
      const pageOneBased = getSavedReadPageOneBased(currentSourcePath.value)
      return Math.min(Math.max(0, pageOneBased - 1), total - 1)
    }

    async function scrollToSavedPage(pageIndex: number) {
      for (let attempt = 0; attempt < 12; attempt++) {
        await nextTick()
        scrollToPageIndex(pageIndex, false, { skipSave: true })
        const root = scrollStreamRef.value
        if (!root) return
        const top = getPageTopInScroller(root, pageIndex)
        if (Math.abs(root.scrollTop - top) <= 8) return
      }
    }

    async function activateReader() {
      if (!readingActive.value || totalPages.value === 0) return
      const start = resolveInitialPageIndex()
      pinnedPageIndex = start
      currentPageIndex.value = start
      scrollSyncFromCode = true
      await nextTick()
      await nextTick()
      setupObserver()
      prioritizePageLoad(start)
      await scrollToSavedPage(start)
      updateSliderFromPageIndex(start)
      scrollSyncFromCode = false
    }

    async function startReading(pages: LocalReaderPages) {
      clearReaderContent()
      readerTitle.value = pages.title
      readerPages.value = pages.pages
      pickingSource.value = false
      readingActive.value = true
      if (currentSourcePath.value) {
        markSourceOpened(currentSourcePath.value, pages.pages.length)
      }
      await activateReader()
    }

    async function openSourceFromList(path: string, index: number) {
      saveReadingPosition()
      currentSourceIndex.value = index
      currentSourcePath.value = path
      const result = await commands.loadLocalReaderPages(path)
      if (result.status === 'error') {
        message.error(result.error.err_message || TEXT.openFail)
        console.error(result.error)
        return
      }
      await startReading(result.data)
    }

    async function openSourcePath(path: string, index = -1) {
      if (index >= 0) {
        await openSourceFromList(path, index)
        return
      }
      currentSourceIndex.value = -1
      currentSourcePath.value = path
      const result = await commands.loadLocalReaderPages(path)
      if (result.status === 'error') {
        message.error(result.error.err_message || TEXT.openFail)
        console.error(result.error)
        return
      }
      await startReading(result.data)
    }

    async function openZipFile() {
      const selected = normalizeDialogPath(
        await open({
          multiple: false,
          filters: [{ name: 'ZIP / CBZ', extensions: ['zip', 'cbz'] }],
        }),
      )
      if (selected === null) return
      sourceListMode.value = false
      folderSources.value = []
      await openSourcePath(selected)
    }

    function showFolderSourceList(selected: string, sources: LocalReaderSource[]) {
      clearReaderContent()
      readingActive.value = false
      readerPages.value = []
      sourceListMode.value = true
      setCurrentFolderPath(selected)
      loadFolderSourceProgress(selected)
      folderLabel.value = selected.split(/[/\\]/).pop() ?? selected
      readerTitle.value = folderLabel.value
      pickingSource.value = true
      folderSources.value = sources
      currentSourceIndex.value = -1
      currentSourcePath.value = ''
    }

    async function openFolder() {
      const selected = normalizeDialogPath(await open({ directory: true, multiple: false }))
      if (selected === null) return
      const sourcesResult = await commands.listLocalReaderSources(selected)
      if (sourcesResult.status === 'error') {
        message.error(sourcesResult.error.err_message || TEXT.folderFail)
        console.error(sourcesResult.error)
        return
      }
      const sources = sourcesResult.data
      if (sources.length === 0) {
        message.warning(TEXT.folderEmpty)
        return
      }
      showFolderSourceList(selected, sources)
    }

    async function goToAdjacentSource(delta: number) {
      saveReadingPosition()
      const nextIndex = currentSourceIndex.value + delta
      const source = folderSources.value[nextIndex]
      if (source === undefined) return
      await openSourceFromList(source.path, nextIndex)
    }

    function cancelFromFolderList() {
      clearReaderContent()
      cancelFolderListMode()
      pickingSource.value = false
      sourceListMode.value = false
      readingActive.value = false
      readerPages.value = []
      readerTitle.value = ''
      folderLabel.value = ''
      folderSources.value = []
      currentSourceIndex.value = -1
      currentSourcePath.value = ''
      exitFullscreen()
    }

    function resetAll() {
      clearReaderContent()
      readingActive.value = false
      readerPages.value = []
      readerTitle.value = ''
      pickingSource.value = false
      sourceListMode.value = false
      folderLabel.value = ''
      folderSources.value = []
      currentSourceIndex.value = -1
      currentSourcePath.value = ''
      currentPageIndex.value = 0
      sliderValue.value = 0
      exitFullscreen()
    }

    function closeReading() {
      saveReadingPosition()
      clearReaderContent()
      readingActive.value = false
      readerPages.value = []
      currentSourcePath.value = ''

      if (sourceListMode.value && folderSources.value.length > 0) {
        pickingSource.value = true
        readerTitle.value = folderLabel.value
        exitFullscreen()
        return
      }

      resetAll()
    }

    function onKeyDown(e: KeyboardEvent) {
      if (!readingActive.value || pageInputEditing.value) return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault()
          goPrevPage()
          break
        case 'ArrowRight':
          e.preventDefault()
          goNextPage()
          break
        case 'ArrowUp':
        case 'PageUp': {
          e.preventDefault()
          const root = scrollStreamRef.value
          if (root) root.scrollBy({ top: -root.clientHeight * 0.9, behavior: 'smooth' })
          break
        }
        case 'ArrowDown':
        case 'PageDown': {
          e.preventDefault()
          const root = scrollStreamRef.value
          if (root) root.scrollBy({ top: root.clientHeight * 0.9, behavior: 'smooth' })
          break
        }
        default:
          break
      }
    }

    onMounted(() => {
      window.addEventListener('keydown', onKeyDown)
    })

    onBeforeUnmount(() => {
      window.removeEventListener('keydown', onKeyDown)
      stopSaveTimer()
      stopScrollPrioritizeTimer()
      saveReadingPosition()
      resetAll()
      observer?.disconnect()
    })

    function renderThumbStrip() {
      const pages = readerPages.value
      const active = currentPageIndex.value
      return (
        <div ref={thumbStripRef} class={localStyles.thumbStrip}>
          {pages.map((page, index) => {
            const src = pageSrcMap.value.get(index)
            const isActive = index === active
            return (
              <button
                key={`${readerSessionId.value}-thumb-${index}`}
                type="button"
                class={[localStyles.thumbItem, isActive ? localStyles.thumbItemActive : '']}
                data-thumb-index={index}
                title={page.caption}
                onClick={() => goToPage(index)}>
                {src !== undefined ? (
                  <img class={localStyles.thumbImg} src={src} alt="" draggable={false} />
                ) : (
                  <span class={localStyles.thumbPlaceholder}>{index + 1}</span>
                )}
              </button>
            )
          })}
        </div>
      )
    }

    function renderPageCounter() {
      if (pageInputEditing.value) {
        return (
          <NInput
            ref={pageInputRef}
            class={localStyles.meeyaPageInput}
            size="tiny"
            value={pageInputDraft.value}
            onUpdateValue={(v) => {
              pageInputDraft.value = v
            }}
            onKeydown={(e: KeyboardEvent) => {
              if (e.key === 'Enter') commitPageInput()
              if (e.key === 'Escape') pageInputEditing.value = false
            }}
            onBlur={() => commitPageInput()}
          />
        )
      }
      return (
        <span
          class={localStyles.meeyaPageCounter}
          title="點擊輸入頁碼"
          onClick={() => void startPageInputEdit()}>
          {TEXT.pageCounter(currentPage.value, totalPages.value)}
        </span>
      )
    }

    function renderScrollStream() {
      const pages = readerPages.value
      const fullscreen = isFullscreen.value
      return (
        <div class={[localStyles.streamWrap, fullscreen ? localStyles.readerFullscreenStream : '']}>
          <div class={localStyles.meeyaTopBar}>
            <span class={localStyles.meeyaTopItem}>
              {TEXT.pageCounter(currentPage.value, totalPages.value)}
            </span>
            <span class={localStyles.meeyaTopItem}>{TEXT.loadPercent(loadPercent.value)}</span>
            <span class={localStyles.meeyaTopItem}>{currentFilename.value}</span>
          </div>
          <div
            ref={scrollStreamRef}
            class={localStyles.scrollStream}
            onScroll={onStreamScroll}
            onWheel={onUserScrollIntent}
            onPointerdown={onUserScrollIntent}>
            <div key={readerSessionId.value}>
              {pages.map((page, index) => {
                const src = pageSrcMap.value.get(index)
                const failed = failedIndices.value.has(index)
                return (
                  <div
                    key={`${readerSessionId.value}-${index}`}
                    ref={(el) => setPageRef(index, el)}
                    data-index={index}
                    class={[localStyles.streamPage, styles.readerPage]}>
                    {src !== undefined ? (
                      <img
                        class={localStyles.streamImage}
                        src={src}
                        alt={page.caption}
                        draggable={false}
                      />
                    ) : failed ? (
                      <div class={localStyles.streamLoadFail}>{TEXT.loadFail}</div>
                    ) : (
                      <div class={localStyles.streamPlaceholder} />
                    )}
                  </div>
                )
              })}
            </div>
          </div>
          {!fullscreen && renderThumbStrip()}
        </div>
      )
    }

    function renderBottomBar() {
      const total = totalPages.value
      const maxSlider = Math.max(1, SLIDER_SCALE)
      return (
        <div class={localStyles.meeyaBottomBar}>
          <NButton
            class={localStyles.meeyaNavBtn}
            size="tiny"
            disabled={!hasPrevBook.value}
            onClick={() => void goToAdjacentSource(-1)}
            title={TEXT.prevBook}>
            |◀
          </NButton>
          <NButton
            class={localStyles.meeyaNavBtn}
            size="tiny"
            disabled={!hasPrevPage.value}
            onClick={goPrevPage}
            title="上一頁">
            ◀
          </NButton>
          <div
            class={localStyles.meeyaSliderWrap}
            onPointerup={onSliderCommit}
            onMouseup={onSliderCommit}>
            <NSlider
              class={localStyles.meeyaSlider}
              min={0}
              max={maxSlider}
              step={1}
              disabled={total <= 1}
              value={sliderValue.value}
              onUpdateValue={onSliderUpdate}
            />
            {renderPageCounter()}
          </div>
          <NButton
            class={localStyles.meeyaNavBtn}
            size="tiny"
            disabled={!hasNextPage.value}
            onClick={goNextPage}
            title="下一頁">
            ▶
          </NButton>
          <NButton
            class={localStyles.meeyaNavBtn}
            size="tiny"
            disabled={!hasNextBook.value}
            onClick={() => void goToAdjacentSource(1)}
            title={TEXT.nextBook}>
            ▶|
          </NButton>
        </div>
      )
    }

    function renderReaderChrome() {
      return (
        <div class={localStyles.readerChrome}>
          <div class={localStyles.readerChromeTitle} title={readerTitle.value}>
            {readerTitle.value}
          </div>
          <NButton size="tiny" onClick={toggleFullscreen}>
            {isFullscreen.value ? TEXT.windowMode : TEXT.fullscreen}
          </NButton>
          <NButton size="tiny" onClick={closeReading}>
            {TEXT.close}
          </NButton>
        </div>
      )
    }

    function renderActiveReader() {
      const shellClass = isFullscreen.value
        ? [localStyles.readerShell, styles.readerFullscreen]
        : localStyles.readerShell

      const content = (
        <div class={shellClass}>
          {renderReaderChrome()}
          <div class={localStyles.splitPane}>{renderScrollStream()}</div>
          {!isFullscreen.value && renderBottomBar()}
        </div>
      )

      if (isFullscreen.value) {
        return <Teleport to="body">{content}</Teleport>
      }
      return content
    }

    return () => {
      if (pickingSource.value) {
        return (
          <div class="flex flex-col h-full min-h-0">
            <div class="shrink-0 px-2 py-2 border-0 border-b border-solid border-[var(--n-divider-color)]">
              <div class="font-bold text-base">
                {readerTitle.value}
                <span class="font-normal text-sm opacity-70 ml-2">{TEXT.pickChapter}</span>
              </div>
              <NButton size="small" class="mt-2" onClick={cancelFromFolderList}>
                {TEXT.cancel}
              </NButton>
            </div>
            <div class="flex-1 min-h-0 overflow-auto p-2 flex flex-col gap-2">
              {folderSources.value.map((source, index) => {
                const opened = getSourceRecord(source.path).opened
                const progressLabel = formatSourceProgressLabel(source.path)
                return (
                  <NButton
                    key={source.path}
                    block
                    class={localStyles.sourceBtn}
                    onClick={() => void openSourceFromList(source.path, index)}>
                    <div class={localStyles.sourceBtnInner}>
                      <div class={localStyles.sourceTitleRow}>
                        {opened && (
                          <span class={localStyles.openedDot} title="已開啟過">
                            ●
                          </span>
                        )}
                        <span>{source.label}</span>
                        <span class={localStyles.sourceKind}>
                          {source.kind === 'zip' ? 'ZIP' : TEXT.folderKind}
                        </span>
                      </div>
                      {progressLabel && (
                        <span class={localStyles.sourceProgress}>{progressLabel}</span>
                      )}
                    </div>
                  </NButton>
                )
              })}
            </div>
          </div>
        )
      }

      if (!readingActive.value) {
        return (
          <div class="flex flex-col h-full min-h-0">
            <div class="shrink-0 px-2 py-2 border-0 border-b border-solid border-[var(--n-divider-color)]">
              <div class="font-bold text-base opacity-60">{TEXT.title}</div>
            </div>
            <div class="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 p-4">
              <NEmpty description={TEXT.empty} />
              <div class="flex flex-wrap gap-2 justify-center">
                <NButton type="primary" onClick={() => void openZipFile()}>
                  {TEXT.openZip}
                </NButton>
                <NButton onClick={() => void openFolder()}>{TEXT.openFolder}</NButton>
              </div>
              <div class="text-xs opacity-60 max-w-md text-center">{TEXT.folderHint}</div>
            </div>
          </div>
        )
      }

      return renderActiveReader()
    }
  },
})
