import { computed, defineComponent, onMounted, PropType, watch } from 'vue'
import { useStore } from '../store.ts'
import { commands, events } from '../bindings.ts'
import { path } from '@tauri-apps/api'
import { NEmpty, NButton, NDropdown } from 'naive-ui'
import DownloadButton from '../components/DownloadButton.tsx'
import cardStyles from '../components/ComicCard.module.css'
import { extractComicSearchName } from '../comicSearchName.ts'

export type ComicDetailSearchMode = 'global' | 'category' | 'snapshot'

export default defineComponent({
  name: 'ComicPane',
  props: {
    searchByTag: {
      type: Function as PropType<(tagName: string, page: number) => Promise<void>>,
      required: true,
    },
    searchFromComicDetail: {
      type: Function as PropType<
        (title: string, category: string, mode: ComicDetailSearchMode) => Promise<void>
      >,
      required: true,
    },
    hasComicCategorySnapshot: {
      type: Function as PropType<(category: string) => boolean>,
      required: true,
    },
  },
  setup(props) {
    const store = useStore()
    console.log('ComicPane setup')

    const cover = computed<string | undefined>(() =>
      store.pickedComic ? store.covers.get(store.pickedComic.id) : undefined,
    )

    const searchKeywordPreview = computed(() =>
      store.pickedComic ? extractComicSearchName(store.pickedComic.title) : '',
    )

    const snapshotSearchAvailable = computed(() =>
      store.pickedComic ? props.hasComicCategorySnapshot(store.pickedComic.category) : false,
    )

    const comicSearchOptions = computed(() => [
      { label: '全站搜索', key: 'global' },
      { label: '分類搜索', key: 'category' },
      {
        label: '快照搜索',
        key: 'snapshot',
        disabled: !snapshotSearchAvailable.value,
      },
    ])

    watch(
      () => store.pickedComic,
      async () => {
        console.log('pickedComic changed')
        if (store.pickedComic === undefined) {
          return
        }

        if (cover.value === undefined) {
          await store.loadCover(store.pickedComic.id, store.pickedComic.cover)
        }
      },
    )

    onMounted(async () => {
      await events.downloadTaskEvent.listen(({ payload: downloadTaskEvent }) => {
        if (downloadTaskEvent.state !== 'Completed' || store.pickedComic === undefined) {
          return
        }
        store.pickedComic.isDownloaded = true
      })
    })

    async function showComicDirInFileManager() {
      if (store.config === undefined || store.pickedComic === undefined) {
        return
      }

      const comicDir = await path.join(store.config.downloadDir, store.pickedComic.title)

      const result = await commands.showPathInFileManager(comicDir)
      if (result.status === 'error') {
        console.error(result.error)
      }
    }

    function onComicSearchSelect(key: string | number) {
      if (store.pickedComic === undefined) {
        return
      }
      const mode = String(key) as ComicDetailSearchMode
      if (mode === 'snapshot' && !snapshotSearchAvailable.value) {
        return
      }
      void props.searchFromComicDetail(store.pickedComic.title, store.pickedComic.category, mode)
    }

    return () => {
      if (store.pickedComic === undefined) {
        return <NEmpty class="pt-2" description="請先選擇漫畫(漫畫搜尋)" />
      }

      return (
        <div class="flex flex-col pl-2 h-full">
          <span class="font-bold text-xl box-border pt-2 px-2">{store.pickedComic.title}</span>
          <div class="flex box-border px-2 gap-4 items-start">
            <img class="w-50 shrink-0 object-contain" src={cover.value} alt="" />
            <div class="flex flex-col w-50 shrink-0 min-w-0">
              <span>ID：{store.pickedComic.id}</span>
              <span>分類：{store.pickedComic.category}</span>
              <span>頁數：{store.pickedComic.imageCount}P</span>
              <div class="flex flex-col gap-2 mt-2 self-start w-full max-w-50">
                {store.pickedComic.isDownloaded && (
                  <NButton size="small" onClick={showComicDirInFileManager}>
                    開啟目錄
                  </NButton>
                )}
                <NButton
                  size="small"
                  type="primary"
                  class={cardStyles.detailButton}
                  onClick={() => void store.prepareAndStartReading(store.pickedComic!.id)}>
                  閱讀
                </NButton>
                <DownloadButton
                  size="small"
                  type="primary"
                  comicId={store.pickedComic.id}
                  comicDownloaded={store.pickedComic.isDownloaded === true}
                  idleLabel="下載"
                />
                <NDropdown
                  trigger="click"
                  placement="bottom"
                  options={comicSearchOptions.value}
                  onSelect={onComicSearchSelect}>
                  <NButton
                    size="small"
                    type="primary"
                    class={cardStyles.detailButton}
                    title={
                      searchKeywordPreview.value !== ''
                        ? `以「${searchKeywordPreview.value}」搜索`
                        : '搜索'
                    }>
                    搜索
                  </NButton>
                </NDropdown>
              </div>
            </div>
          </div>

          <div class="box-border px-2">
            <div class="font-bold">標籤</div>
            <div class="flex flex-wrap gap-1">
              {store.pickedComic.tags.map((tag) => (
                <NButton
                  key={tag.url}
                  round
                  size="tiny"
                  class="hover:scale-110 transition-transform duration-100"
                  onClick={() => props.searchByTag(tag.name, 1)}>
                  {tag.name}
                </NButton>
              ))}
            </div>
          </div>

          <div class="break-all box-border px-2" v-html={store.pickedComic.intro} />
        </div>
      )
    }
  },
})
