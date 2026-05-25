import { computed, defineComponent, onMounted, type PropType } from 'vue'
import { storeToRefs } from 'pinia'
import { NButton, NDropdown, NEmpty, NIcon, NPagination } from 'naive-ui'
import { useStore } from '../store.ts'
import ComicCard from '../components/ComicCard.tsx'
import GridColsIcon from '../components/GridColsIcon.tsx'
import { PhListBullets } from '@phosphor-icons/vue'
import { useLocalComicBrowseList } from '../composables/useLocalComicBrowseList.ts'
import {
  PAGE_SIZE_OPTIONS,
  SEARCH_LAYOUT_OPTIONS,
  type SearchResultLayout,
} from '../comicBrowseLayout.ts'
import { SEARCH_SORT_OPTIONS, type SearchSortOrder } from '../utils.ts'

export default defineComponent({
  name: 'FavoriteComicsPane',
  props: {
    searchByTag: {
      type: Function as PropType<(tagName: string, page: number) => Promise<void>>,
      required: true,
    },
  },
  setup(props) {
    const store = useStore()
    const { favoriteComics } = storeToRefs(store)

    const browse = useLocalComicBrowseList(favoriteComics)

    const isEmpty = computed(() => favoriteComics.value.length === 0)

    onMounted(() => {
      store.reloadFavoriteComics()
    })

    return () => (
      <div class="h-full flex flex-col gap-2 relative">
        {isEmpty.value ? (
          <div class="flex-1 flex items-center justify-center p-4">
            <NEmpty description="尚無收藏。在「漫畫搜尋」結果的封面右上角點星星即可加入。" />
          </div>
        ) : (
          <>
            <div class="flex items-center gap-2 px-2 pt-2">
              <span class="text-sm opacity-80">共 {favoriteComics.value.length} 本</span>
              <div class="ml-auto flex items-center gap-1 shrink-0">
                <NDropdown
                  trigger="click"
                  placement="bottom-end"
                  options={SEARCH_LAYOUT_OPTIONS.map((o) => ({
                    key: o.key,
                    label: o.label,
                  }))}
                  onSelect={(key) => browse.setSearchResultLayout(key as SearchResultLayout)}>
                  <NButton
                    size="small"
                    title={browse.layoutOptionLabel(browse.searchResultLayout.value)}>
                    {{
                      icon: () => (
                        <NIcon size={18}>
                          {browse.isGridSearchLayout(browse.searchResultLayout.value) ? (
                            <GridColsIcon cols={browse.gridColsNumber(browse.searchResultLayout.value)} />
                          ) : (
                            <PhListBullets />
                          )}
                        </NIcon>
                      ),
                    }}
                  </NButton>
                </NDropdown>
              </div>
            </div>
            <div
              ref={browse.comicListScrollArea}
              class="relative flex flex-col overflow-auto flex-1 min-h-0"
              onScroll={browse.onComicListScroll}>
              <div
                data-comic-list
                class={
                  browse.isGridSearchLayout(browse.searchResultLayout.value)
                    ? `grid ${browse.gridColsClass(browse.searchResultLayout.value)} gap-2 p-2 items-stretch`
                    : 'flex flex-col gap-row-2 p-2'
                }>
                {browse.visibleComics.value.map((comic, index) => (
                  <ComicCard
                    key={comic.id}
                    layout={browse.comicCardLayout(browse.searchResultLayout.value)}
                    comicId={comic.id}
                    comicTitle={comic.title}
                    comicTitleHtml={comic.titleHtml}
                    comicCover={comic.cover}
                    comicAdditionalInfo={comic.additionalInfo}
                    comicDownloaded={comic.isDownloaded}
                    idleDownloadLabel="下載"
                    showDetailButton={true}
                    showReadButton={true}
                    showTags={true}
                    showFavoriteButton={true}
                    favorited={store.isFavoriteComic(comic.id)}
                    onToggleFavorite={() => store.toggleFavoriteComic(comic)}
                    searchByTag={props.searchByTag}
                    enableCoverLoad={index < browse.coverLoadLimit.value}
                    enableTagLoad={index < browse.coverLoadLimit.value}
                  />
                ))}
              </div>
            </div>
            <div class="flex items-center gap-2 p-2 mt-auto box-border flex-wrap w-full">
              <div class="flex items-center gap-1 shrink-0">
                <NPagination
                  page={browse.viewPage.value}
                  pageCount={browse.displayPageCount.value}
                  pageSlot={9}
                  onUpdate:page={(page) => browse.goToViewPage(page)}
                />
              </div>
              <div class="flex-1 min-w-2" />
              <NDropdown
                trigger="click"
                options={SEARCH_SORT_OPTIONS.map((o) => ({ label: o.label, key: o.key }))}
                onSelect={(key) => browse.onSortChange(key as SearchSortOrder)}>
                <NButton size="small" class="whitespace-nowrap">
                  {browse.sortButtonLabel.value}
                </NButton>
              </NDropdown>
              <NDropdown
                trigger="click"
                options={PAGE_SIZE_OPTIONS.map((n) => ({ label: String(n), key: n }))}
                onSelect={(key) => browse.onPageSizeChange(key as number)}>
                <NButton size="small" class="whitespace-nowrap">
                  {browse.pageSizeButtonLabel.value}
                </NButton>
              </NDropdown>
            </div>
          </>
        )}
      </div>
    )
  },
})
