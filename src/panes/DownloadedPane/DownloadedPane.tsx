import { computed, defineComponent, ref, watch } from 'vue'
import { NPagination } from 'naive-ui'
import { useStore } from '../../store.ts'
import { Comic, commands } from '../../bindings.ts'
import DownloadedComicCard from './components/DownloadedComicCard.tsx'

export default defineComponent({
  name: 'DownloadedPane',
  setup() {
    const store = useStore()

    const comicCardContainer = ref<HTMLElement>()

    const PAGE_SIZE = 20
    // 已下載的漫畫
    const downloadedComics = ref<Comic[]>([])
    // 當前頁碼
    const currentPage = ref<number>(1)
    // 總頁數
    const pageCount = computed<number>(() => {
      if (downloadedComics.value.length === 0) {
        return 1
      }
      return Math.ceil(downloadedComics.value.length / PAGE_SIZE)
    })
    // 當前頁的漫畫
    const currentPageComics = computed(() => {
      const start = (currentPage.value - 1) * PAGE_SIZE
      const end = start + PAGE_SIZE
      return downloadedComics.value.slice(start, end)
    })

    watch(currentPage, () => {
      if (comicCardContainer.value !== undefined) {
        comicCardContainer.value.scrollTo({ top: 0, behavior: 'instant' })
      }
    })

    // 監聽標籤頁變化，更新下載的漫畫列表
    watch(
      () => store.currentTabName,
      async () => {
        if (store.currentTabName !== 'downloaded') {
          return
        }

        const result = await commands.getDownloadedComics()
        if (result.status === 'error') {
          console.error(result.error)
          return
        }
        downloadedComics.value = result.data
      },
      { immediate: true },
    )

    return () => (
      <div class="h-full flex flex-col">
        <div class="flex flex-col overflow-auto">
          <div ref={comicCardContainer} class="flex flex-col gap-row-2 overflow-auto p-2">
            {currentPageComics.value.map((comic) => (
              <DownloadedComicCard key={comic.id} comic={comic} />
            ))}
          </div>
        </div>
        <NPagination
          class="p-2 mt-auto"
          page={currentPage.value}
          pageCount={pageCount.value}
          onUpdate:page={(page) => (currentPage.value = page)}
        />
      </div>
    )
  },
})
