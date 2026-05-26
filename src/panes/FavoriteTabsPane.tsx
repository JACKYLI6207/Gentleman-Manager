import { computed, defineComponent, onMounted, type PropType } from 'vue'
import { storeToRefs } from 'pinia'
import { NButton, NEmpty, NIcon, useMessage } from 'naive-ui'
import { PhStar, PhTrash } from '@phosphor-icons/vue'
import { useStore } from '../store.ts'
import { searchTabBookmarkKindLabel, type SearchTabBookmark } from './searchTabBookmarkTypes.ts'
import { open, save } from '@tauri-apps/plugin-dialog'
import { commands } from '../bindings.ts'

type FavoriteTabExportFile = {
  format: 'gentleman-manager.favorite-tab.v1'
  exportedAt: string
  bookmark: SearchTabBookmark
}

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
    const message = useMessage()
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

    function isSearchTabBookmark(value: unknown): value is SearchTabBookmark {
      if (typeof value !== 'object' || value === null) {
        return false
      }
      const item = value as SearchTabBookmark
      return (
        typeof item.id === 'string' &&
        typeof item.sourceTabId === 'string' &&
        typeof item.savedAt === 'string' &&
        typeof item.title === 'string' &&
        typeof item.tabState === 'object' &&
        item.tabState !== null
      )
    }

    function isFavoriteTabExportFile(value: unknown): value is FavoriteTabExportFile {
      if (typeof value !== 'object' || value === null) {
        return false
      }
      const file = value as FavoriteTabExportFile
      return (
        file.format === 'gentleman-manager.favorite-tab.v1' &&
        typeof file.exportedAt === 'string' &&
        isSearchTabBookmark(file.bookmark)
      )
    }

    function normalizeDialogPath(value: string | string[] | null): string | null {
      if (value === null) {
        return null
      }
      if (Array.isArray(value)) {
        return value[0] ?? null
      }
      return value
    }

    function safeFavoriteTabExportFilename(title: string) {
      const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim()
      return `${safeTitle || 'favorite-tab'}.gm-favorite-tab.json`
    }

    function ensureFavoriteTabExportExtension(path: string) {
      return path.toLocaleLowerCase().endsWith('.json') ? path : `${path}.gm-favorite-tab.json`
    }

    async function exportFavoriteTab(event: MouseEvent, bookmark: SearchTabBookmark) {
      event.stopPropagation()
      const selectedPath = await save({
        defaultPath: safeFavoriteTabExportFilename(bookmark.title),
        filters: [{ name: 'Gentleman Manager 收藏分頁', extensions: ['json'] }],
      })
      if (selectedPath === null) {
        return
      }
      const result = await commands.writeSnapshotExportFile(
        ensureFavoriteTabExportExtension(selectedPath),
        JSON.stringify(
          {
            format: 'gentleman-manager.favorite-tab.v1',
            exportedAt: new Date().toISOString(),
            bookmark,
          } satisfies FavoriteTabExportFile,
          null,
          2,
        ),
      )
      if (result.status === 'error') {
        console.error(result.error)
        message.error(result.error.err_message)
        return
      }
      message.success('已導出收藏分頁')
    }

    async function importFavoriteTab() {
      const selectedPath = normalizeDialogPath(
        await open({
          multiple: false,
          filters: [{ name: 'Gentleman Manager 收藏分頁', extensions: ['json'] }],
        }),
      )
      if (selectedPath === null) {
        return
      }
      const result = await commands.readSnapshotExportFile(selectedPath)
      if (result.status === 'error') {
        console.error(result.error)
        message.error(result.error.err_message)
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(result.data)
      } catch (err) {
        console.error(err)
        message.error('收藏分頁存檔格式錯誤，無法載入')
        return
      }
      if (!isFavoriteTabExportFile(parsed)) {
        message.error('這不是有效的 Gentleman Manager 收藏分頁存檔')
        return
      }
      store.upsertFavoriteSearchTab(parsed.bookmark)
      message.success(`已載入收藏分頁：${parsed.bookmark.title}`)
    }

    return () => (
      <div class="h-full flex flex-col">
        {isEmpty.value ? (
          <div class="flex-1 flex flex-col gap-3 items-center justify-center p-4">
            <NEmpty description="尚無收藏分頁。在「漫畫搜尋」搜尋結果分頁標題前點星星即可加入。" />
            <NButton size="small" secondary onClick={() => void importFavoriteTab()}>
              分頁載入
            </NButton>
          </div>
        ) : (
          <>
            <div class="px-3 pt-2 pb-1 flex items-center justify-between gap-3">
              <span class="text-sm opacity-80">共 {favoriteSearchTabs.value.length} 個分頁</span>
              <NButton size="tiny" secondary onClick={() => void importFavoriteTab()}>
                分頁載入
              </NButton>
            </div>
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
                    secondary
                    class="shrink-0"
                    title="導出收藏分頁"
                    onClick={(event: MouseEvent) => void exportFavoriteTab(event, bookmark)}>
                    導出
                  </NButton>
                  <NButton
                    size="tiny"
                    quaternary
                    class="shrink-0"
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
