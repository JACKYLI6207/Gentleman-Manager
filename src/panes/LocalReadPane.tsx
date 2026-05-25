import {
  computed,
  defineComponent,
  nextTick,
  onBeforeUnmount,
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
import { NButton, NEmpty, useMessage } from 'naive-ui'
import styles from './ComicReadPane.module.css'

const PREFETCH_ROOT_MARGIN = '600px 0px'
const FOLDER_MAX_CONCURRENT_LOADS = 4
const ZIP_MAX_CONCURRENT_LOADS = 2
const NEIGHBOR_PRELOAD_RADIUS = 3

function isZipPath(path: string): boolean {
  const lower = path.toLowerCase()
  return lower.endsWith('.zip') || lower.endsWith('.cbz')
}

function normalizeDialogPath(selected: string | string[] | null): string | null {
  if (selected === null) {
    return null
  }
  if (Array.isArray(selected)) {
    return selected[0] ?? null
  }
  return selected
}

const TEXT = {
  openFail: '\u7121\u6cd5\u958b\u555f\u6b64\u6a94\u6848\u6216\u8cc7\u6599\u593e',
  folderFail: '\u7121\u6cd5\u8b80\u53d6\u8cc7\u6599\u593e',
  folderEmpty: '\u6b64\u8cc7\u6599\u593e\u5167\u6c92\u6709\u53ef\u95b1\u8b80\u7684 ZIP \u6216\u5716\u7247\u5b50\u8cc7\u6599\u593e',
  pickChapter: '\u8acb\u9078\u64c7\u8981\u95b1\u8b80\u7684\u7bc7\u7ae0',
  cancel: '\u53d6\u6d88',
  folderKind: '\u8cc7\u6599\u593e',
  title: '\u672c\u5730\u95b1\u8b80',
  empty: '\u5f9e\u672c\u5730 ZIP \u6216\u8cc7\u6599\u593e\u958b\u555f\u6f2b\u756b',
  openZip: '\u958b\u555f ZIP \u6a94',
  openFolder: '\u958b\u555f\u8cc7\u6599\u593e',
  folderHint:
    '\u8cc7\u6599\u593e\u6a21\u5f0f\u53ef\u9078\u97d3\u6f2b\u7cfb\u5217\u76ee\u9304\uff0c\u5167\u542b\u591a\u500b ZIP \u6216\u5b50\u8cc7\u6599\u593e\u6642\u6703\u5217\u51fa\u7bc7\u7ae0\u4f9b\u9078\u64c7\u3002',
  close: '\u95dc\u9589',
  loadFail: '\u8f09\u5165\u5931\u6557\uff0c\u8acb\u5411\u4e0b\u6372\u52d5\u91cd\u8a66',
  pageCount: (n: number) => `\u5171 ${n} \u9801`,
  prevBook: '\u4e0a\u4e00\u672c',
  nextBook: '\u4e0b\u4e00\u672c',
  fullscreen: '\u5168\u8996\u7a97',
  windowMode: '\u8996\u7a97\u6a21\u5f0f',
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
    const pageSrcMap = ref<Map<number, string>>(new Map())
    const loadingIndices = ref<Set<number>>(new Set())
    const failedIndices = ref<Set<number>>(new Set())
    const pageRefs = ref<Map<number, HTMLElement>>(new Map())
    const scrollContainerRef = ref<HTMLElement | null>(null)
    const readerSessionId = ref(0)
    let observer: IntersectionObserver | undefined
    let loadQueue: number[] = []
    let activeLoads = 0

    const canNavigateBooks = computed(
      () => sourceListMode.value && folderSources.value.length > 1 && readingActive.value,
    )
    const hasPrevBook = computed(() => canNavigateBooks.value && currentSourceIndex.value > 0)
    const hasNextBook = computed(
      () =>
        canNavigateBooks.value &&
        currentSourceIndex.value >= 0 &&
        currentSourceIndex.value < folderSources.value.length - 1,
    )

    function revokeAllBlobUrls() {
      for (const url of pageSrcMap.value.values()) {
        URL.revokeObjectURL(url)
      }
      pageSrcMap.value = new Map()
    }

    function closeZipSession() {
      void commands.closeLocalReaderZipSession()
    }

    function clearReaderContent() {
      readerSessionId.value += 1
      revokeAllBlobUrls()
      loadingIndices.value = new Set()
      failedIndices.value = new Set()
      closeZipSession()
      for (const el of pageRefs.value.values()) {
        observer?.unobserve(el)
      }
      pageRefs.value = new Map()
      loadQueue = []
      activeLoads = 0
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
      exitFullscreen()
      scrollContainerRef.value?.scrollTo({ top: 0 })
    }

    function closeReading() {
      clearReaderContent()
      readingActive.value = false
      readerPages.value = []
      currentSourcePath.value = ''
      exitFullscreen()

      if (sourceListMode.value && folderSources.value.length > 0) {
        pickingSource.value = true
        readerTitle.value = folderLabel.value
        scrollContainerRef.value?.scrollTo({ top: 0 })
        return
      }

      resetAll()
    }

    function setupObserver() {
      observer?.disconnect()
      const root = scrollContainerRef.value
      if (root === null) {
        return
      }
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) {
              continue
            }
            const index = Number((entry.target as HTMLElement).dataset.index)
            if (!Number.isNaN(index)) {
              enqueueNeighbors(index)
            }
          }
        },
        { root, rootMargin: PREFETCH_ROOT_MARGIN, threshold: 0 },
      )
    }

    function primeInitialPages() {
      enqueueNeighbors(0)
    }

    function maxConcurrentLoads() {
      return isZipPath(currentSourcePath.value) ? ZIP_MAX_CONCURRENT_LOADS : FOLDER_MAX_CONCURRENT_LOADS
    }

    function enqueueNeighbors(center: number) {
      const total = readerPages.value.length
      for (let delta = -NEIGHBOR_PRELOAD_RADIUS; delta <= NEIGHBOR_PRELOAD_RADIUS; delta++) {
        const index = center + delta
        if (index >= 0 && index < total) {
          enqueuePage(index)
        }
      }
    }

    async function activateReader() {
      if (!readingActive.value || readerPages.value.length === 0) {
        return
      }
      await nextTick()
      scrollContainerRef.value?.scrollTo({ top: 0 })
      setupObserver()
      observeAllPages()
      primeInitialPages()
    }

    async function startReading(pages: LocalReaderPages) {
      clearReaderContent()
      readerTitle.value = pages.title
      readerPages.value = pages.pages
      pickingSource.value = false
      readingActive.value = true
      await activateReader()
    }

    async function openSourceFromList(path: string, index: number) {
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
      if (selected === null) {
        return
      }
      sourceListMode.value = false
      folderSources.value = []
      await openSourcePath(selected)
    }

    async function openFolder() {
      const selected = normalizeDialogPath(await open({ directory: true, multiple: false }))
      if (selected === null) {
        return
      }
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
      if (sources.length === 1) {
        sourceListMode.value = false
        folderSources.value = []
        folderLabel.value = ''
        await openSourcePath(sources[0]!.path)
        return
      }
      clearReaderContent()
      readingActive.value = false
      readerPages.value = []
      sourceListMode.value = true
      folderLabel.value = selected.split(/[/\\]/).pop() ?? selected
      readerTitle.value = folderLabel.value
      pickingSource.value = true
      folderSources.value = sources
      currentSourceIndex.value = -1
      currentSourcePath.value = ''
    }

    async function goToAdjacentSource(delta: number) {
      const nextIndex = currentSourceIndex.value + delta
      const source = folderSources.value[nextIndex]
      if (source === undefined) {
        return
      }
      await openSourceFromList(source.path, nextIndex)
    }

    function setPageRef(index: number, el: Element | ComponentPublicInstance | null) {
      const node = el instanceof HTMLElement ? el : (el as ComponentPublicInstance | null)?.$el
      if (node instanceof HTMLElement) {
        pageRefs.value.set(index, node)
        observer?.observe(node)
      } else {
        const existing = pageRefs.value.get(index)
        if (existing !== undefined) {
          observer?.unobserve(existing)
          pageRefs.value.delete(index)
        }
      }
    }

    function pumpLoadQueue() {
      while (activeLoads < maxConcurrentLoads() && loadQueue.length > 0) {
        const index = loadQueue.shift()
        if (index === undefined) {
          return
        }
        void loadPage(index)
      }
    }

    function enqueuePage(index: number) {
      if (!readingActive.value) {
        return
      }
      if (pageSrcMap.value.has(index) || loadingIndices.value.has(index) || loadQueue.includes(index)) {
        return
      }
      if (failedIndices.value.has(index)) {
        const nextFailed = new Set(failedIndices.value)
        nextFailed.delete(index)
        failedIndices.value = nextFailed
      }
      loadQueue.push(index)
      pumpLoadQueue()
    }

    async function loadPage(index: number) {
      const session = readerSessionId.value
      const page = readerPages.value[index]
      if (!readingActive.value || page === undefined || pageSrcMap.value.has(index)) {
        return
      }

      const nextLoading = new Set(loadingIndices.value)
      nextLoading.add(index)
      loadingIndices.value = nextLoading
      activeLoads += 1

      const result = await commands.getLocalReaderImage(page.pageId)
      activeLoads -= 1

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
    }

    function observeAllPages() {
      if (observer === undefined) {
        return
      }
      for (const el of pageRefs.value.values()) {
        observer.observe(el)
      }
    }

    function renderReaderHeader() {
      const pages = readerPages.value
      return (
        <div class={styles.readerHeader}>
          <div class={styles.readerHeaderTitle}>
            {readerTitle.value}
            <span class="font-normal text-sm opacity-70 ml-2">{TEXT.pageCount(pages.length)}</span>
          </div>
          <div class={styles.readerHeaderActions}>
            {canNavigateBooks.value && (
              <>
                <NButton size="small" disabled={!hasPrevBook.value} onClick={() => void goToAdjacentSource(-1)}>
                  {TEXT.prevBook}
                </NButton>
                <NButton size="small" disabled={!hasNextBook.value} onClick={() => void goToAdjacentSource(1)}>
                  {TEXT.nextBook}
                </NButton>
              </>
            )}
            <NButton size="small" onClick={toggleFullscreen}>
              {isFullscreen.value ? TEXT.windowMode : TEXT.fullscreen}
            </NButton>
            <NButton size="small" onClick={closeReading}>
              {TEXT.close}
            </NButton>
          </div>
        </div>
      )
    }

    function renderReaderBody() {
      const pages = readerPages.value
      return (
        <div ref={scrollContainerRef} class="flex-1 min-h-0 overflow-auto">
          <div key={readerSessionId.value}>
            {pages.map((page, index) => {
              const src = pageSrcMap.value.get(index)
              const failed = failedIndices.value.has(index)
              return (
                <div
                  key={`${readerSessionId.value}-${index}`}
                  ref={(el) => setPageRef(index, el)}
                  data-index={index}
                  class={styles.readerPage}>
                  {src !== undefined ? (
                    <img class="w-full block" src={src} alt={page.caption} />
                  ) : failed ? (
                    <div class="py-8 text-center opacity-60">{TEXT.loadFail}</div>
                  ) : (
                    <div class={styles.pagePlaceholder} />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )
    }

    function renderActiveReader() {
      const shellClass = isFullscreen.value
        ? ['flex flex-col h-full min-h-0', styles.readerFullscreen]
        : 'flex flex-col h-full min-h-0'

      const content = (
        <div class={shellClass}>
          {renderReaderHeader()}
          {renderReaderBody()}
        </div>
      )

      if (isFullscreen.value) {
        return <Teleport to="body">{content}</Teleport>
      }
      return content
    }

    onBeforeUnmount(() => {
      resetAll()
      observer?.disconnect()
      observer = undefined
    })

    return () => {
      if (pickingSource.value) {
        return (
          <div class="flex flex-col h-full min-h-0">
            <div class="shrink-0 px-2 py-2 border-0 border-b border-solid border-[var(--n-divider-color)]">
              <div class="font-bold text-base">
                {readerTitle.value}
                <span class="font-normal text-sm opacity-70 ml-2">{TEXT.pickChapter}</span>
              </div>
              <NButton size="small" class="mt-2" onClick={resetAll}>
                {TEXT.cancel}
              </NButton>
            </div>
            <div class="flex-1 min-h-0 overflow-auto p-2 flex flex-col gap-2">
              {folderSources.value.map((source, index) => (
                <NButton
                  key={source.path}
                  block
                  class="justify-start!"
                  onClick={() => void openSourceFromList(source.path, index)}>
                  {source.label}
                  <span class="opacity-60 ml-2 text-xs">
                    {source.kind === 'zip' ? 'ZIP' : TEXT.folderKind}
                  </span>
                </NButton>
              ))}
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
