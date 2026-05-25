import {
  defineComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  Teleport,
  watch,
  type ComponentPublicInstance,
} from 'vue'
import { useStore } from '../store.ts'
import { commands } from '../bindings.ts'
import { getReaderPages } from '../utils.ts'
import { useReaderFullscreen } from '../composables/useReaderFullscreen.ts'
import { NButton, NEmpty } from 'naive-ui'
import styles from './ComicReadPane.module.css'

const PREFETCH_ROOT_MARGIN = '600px 0px'
const MAX_CONCURRENT_LOADS = 4

export default defineComponent({
  name: 'ComicReadPane',
  setup() {
    const store = useStore()
    const { isFullscreen, toggleFullscreen, exitFullscreen } = useReaderFullscreen()
    const pageSrcMap = ref<Map<number, string>>(new Map())
    const loadingIndices = ref<Set<number>>(new Set())
    const failedIndices = ref<Set<number>>(new Set())
    const pageRefs = ref<Map<number, HTMLElement>>(new Map())
    const scrollContainerRef = ref<HTMLElement | null>(null)
    /** 遞增後會卸載整個頁面列表 DOM，並讓進行中的載圖失效 */
    const readerSessionId = ref(0)
    let observer: IntersectionObserver | undefined
    let loadQueue: number[] = []
    let activeLoads = 0

    function revokeAllBlobUrls() {
      for (const url of pageSrcMap.value.values()) {
        URL.revokeObjectURL(url)
      }
      pageSrcMap.value = new Map()
    }

    function clearReaderContent() {
      readerSessionId.value += 1
      revokeAllBlobUrls()
      loadingIndices.value = new Set()
      failedIndices.value = new Set()
      for (const el of pageRefs.value.values()) {
        observer?.unobserve(el)
      }
      pageRefs.value = new Map()
      loadQueue = []
      activeLoads = 0
    }

    function resetReaderState() {
      clearReaderContent()
      store.endReading()
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
              enqueuePage(index)
            }
          }
        },
        { root, rootMargin: PREFETCH_ROOT_MARGIN, threshold: 0 },
      )
    }

    function primeInitialPages() {
      const comic = store.pickedComic
      if (!store.readingActive || comic === undefined) {
        return
      }
      const pages = getReaderPages(comic.imgList)
      for (let i = 0; i < Math.min(3, pages.length); i++) {
        enqueuePage(i)
      }
    }

    async function activateReader() {
      if (!store.readingActive || store.pickedComic === undefined) {
        return
      }
      await nextTick()
      scrollToTop()
      setupObserver()
      observeAllPages()
      primeInitialPages()
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
      while (activeLoads < MAX_CONCURRENT_LOADS && loadQueue.length > 0) {
        const index = loadQueue.shift()
        if (index === undefined) {
          return
        }
        void loadPage(index)
      }
    }

    function enqueuePage(index: number) {
      if (!store.readingActive) {
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
      const comic = store.pickedComic
      if (!store.readingActive || comic === undefined) {
        return
      }
      const pages = getReaderPages(comic.imgList)
      const page = pages[index]
      if (page === undefined || pageSrcMap.value.has(index)) {
        return
      }

      const nextLoading = new Set(loadingIndices.value)
      nextLoading.add(index)
      loadingIndices.value = nextLoading
      activeLoads += 1

      const result = await commands.getReaderImage(comic.id, page.url)
      activeLoads -= 1

      if (session !== readerSessionId.value || !store.readingActive) {
        const doneLoading = new Set(loadingIndices.value)
        doneLoading.delete(index)
        loadingIndices.value = doneLoading
        pumpLoadQueue()
        return
      }

      const doneLoading = new Set(loadingIndices.value)
      doneLoading.delete(index)
      loadingIndices.value = doneLoading

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

    function scrollToTop() {
      scrollContainerRef.value?.scrollTo({ top: 0 })
    }

    function stopReading() {
      resetReaderState()
      exitFullscreen()
      scrollToTop()
      store.currentTabName = 'comic'
    }

    function observeAllPages() {
      if (observer === undefined) {
        return
      }
      for (const el of pageRefs.value.values()) {
        observer.observe(el)
      }
    }

    watch(
      () => store.pickedComic?.id,
      () => {
        clearReaderContent()
        void activateReader()
      },
    )

    watch(
      () => store.readingActive,
      (active) => {
        if (active) {
          void activateReader()
        }
      },
    )

    onBeforeUnmount(() => {
      resetReaderState()
      observer?.disconnect()
      observer = undefined
    })

    return () => {
      if (store.pickedComic === undefined) {
        return <NEmpty class="pt-2" description="請先選擇漫畫(漫畫詳情)" />
      }

      const pages = getReaderPages(store.pickedComic.imgList)
      if (pages.length === 0) {
        return <NEmpty class="pt-2" description="此漫畫沒有可閱讀的頁面" />
      }

      const readerHeader = store.readingActive ? (
        <div class={styles.readerHeader}>
          <div class={styles.readerHeaderTitle}>
            {store.pickedComic.title}
            <span class="font-normal text-sm opacity-70 ml-2">共 {pages.length} 頁</span>
          </div>
          <div class={styles.readerHeaderActions}>
            <NButton size="small" onClick={toggleFullscreen}>
              {isFullscreen.value ? '視窗模式' : '全視窗'}
            </NButton>
            <NButton size="small" onClick={stopReading}>
              停止閱讀
            </NButton>
          </div>
        </div>
      ) : (
        <div class={styles.readerHeader}>
          <div class={styles.readerHeaderTitle}>
            <span class="opacity-60">在線閱讀</span>
          </div>
        </div>
      )

      const readerBody = (
        <div ref={scrollContainerRef} class="flex-1 min-h-0 overflow-auto">
          {store.readingActive ? (
            <div key={`${readerSessionId.value}-${store.pickedComic.id}`}>
              {pages.map((page, index) => {
                const src = pageSrcMap.value.get(index)
                const loading = loadingIndices.value.has(index)
                const failed = failedIndices.value.has(index)
                return (
                  <div
                    key={`${readerSessionId.value}-${store.pickedComic!.id}-${index}`}
                    ref={(el) => setPageRef(index, el)}
                    data-index={index}
                    class={styles.readerPage}>
                    {src !== undefined ? (
                      <img class="w-full block" src={src} alt={page.caption} loading="lazy" />
                    ) : failed ? (
                      <div class="py-8 text-center opacity-60">載入失敗，請向下捲動重試</div>
                    ) : loading ? (
                      <div class={styles.pagePlaceholder} />
                    ) : (
                      <div class={styles.pagePlaceholder} />
                    )}
                  </div>
                )
              })}
            </div>
          ) : (
            <NEmpty class="pt-8" description="請在「漫畫詳情」點擊「閱讀」開始" />
          )}
        </div>
      )

      const shellClass = isFullscreen.value && store.readingActive
        ? ['flex flex-col h-full min-h-0', styles.readerFullscreen]
        : 'flex flex-col h-full min-h-0'

      const readerShell = (
        <div class={shellClass}>
          {readerHeader}
          {readerBody}
        </div>
      )

      if (isFullscreen.value && store.readingActive) {
        return <Teleport to="body">{readerShell}</Teleport>
      }

      return readerShell
    }
  },
})
