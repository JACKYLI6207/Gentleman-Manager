import { computed, defineComponent, onMounted, type PropType } from 'vue'
import { storeToRefs } from 'pinia'
import { NButton, NEmpty, NIcon } from 'naive-ui'
import { PhStar, PhTrash } from '@phosphor-icons/vue'
import { useStore } from '../store.ts'
import { searchTabBookmarkKindLabel, type SearchTabBookmark } from './searchTabBookmarkTypes.ts'

export default defineComponent({
  name: 'FavoriteTabsPane',
  props: {
    onOpenBookmark: {
      type: Function as PropType<(bookmark: SearchTabBookmark) => void>,
      required: true,
    },
  },
  setup(props) {
    const store = useStore()
    const { favoriteSearchTabs } = storeToRefs(store)

    const isEmpty = computed(() => favoriteSearchTabs.value.length === 0)

    onMounted(() => {
      store.reloadFavoriteSearchTabs()
    })

    function formatSavedAt(iso: string) {
      try {
        const d = new Date(iso)
        if (Number.isNaN(d.getTime())) {
          return ''
        }
        return d.toLocaleString()
      } catch {
        return ''
      }
    }

    return () => (
      <div class="h-full flex flex-col">
        {isEmpty.value ? (
          <div class="flex-1 flex items-center justify-center p-4">
            <NEmpty description="尚無收藏分頁。在「漫畫搜尋」搜尋結果分頁標題前點星星即可加入。" />
          </div>
        ) : (
          <>
            <div class="px-3 pt-2 pb-1 text-sm opacity-80">共 {favoriteSearchTabs.value.length} 個分頁</div>
            <ul class="flex-1 min-h-0 overflow-auto px-2 pb-2 list-none m-0">
              {favoriteSearchTabs.value.map((bookmark) => {
                const kindLabel = searchTabBookmarkKindLabel(bookmark.tabState.searchSource)
                return (
                <li
                  key={bookmark.id}
                  class="flex items-center gap-2 px-2 py-2 rounded-md hover:bg-[rgba(255,255,255,0.06)] cursor-pointer group border border-transparent hover:border-[var(--n-divider-color)]"
                  onClick={() => props.onOpenBookmark(bookmark)}>
                  <NIcon size={18} class="shrink-0 text-amber-400">
                    <PhStar weight="fill" />
                  </NIcon>
                  <div class="flex-1 min-w-0">
                    <div
                      class="text-sm font-medium truncate flex items-center gap-1.5 min-w-0"
                      title={bookmark.title}>
                      {kindLabel !== null && (
                        <span class="shrink-0 text-xs font-normal px-1.5 py-0.5 rounded bg-[rgba(255,255,255,0.1)] text-[var(--n-text-color-3)]">
                          {kindLabel}
                        </span>
                      )}
                      <span class="truncate">{bookmark.title}</span>
                    </div>
                    {formatSavedAt(bookmark.savedAt) !== '' && (
                      <div class="text-xs opacity-60 mt-0.5">收藏於 {formatSavedAt(bookmark.savedAt)}</div>
                    )}
                  </div>
                  <NButton
                    size="tiny"
                    quaternary
                    class="opacity-0 group-hover:opacity-100 shrink-0"
                    title="從收藏分頁移除"
                    onClick={(e: MouseEvent) => {
                      e.stopPropagation()
                      store.removeFavoriteSearchTabById(bookmark.id)
                    }}>
                    {{
                      icon: () => (
                        <NIcon size={16}>
                          <PhTrash />
                        </NIcon>
                      ),
                    }}
                  </NButton>
                </li>
                )
              })}
            </ul>
          </>
        )}
      </div>
    )
  },
})
