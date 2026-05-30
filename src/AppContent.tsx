import { defineComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useStore } from './store.ts'
import { commands, events } from './bindings.ts'
import { useMessage, NTabs, NTabPane, NIcon } from 'naive-ui'
import SearchPane from './panes/SearchPane.tsx'
import FavoritesPane from './panes/FavoritesPane.tsx'
import ComicPane from './panes/ComicPane.tsx'
import ComicReadPane from './panes/ComicReadPane.tsx'
import LocalReadPane from './panes/LocalReadPane.tsx'
import { CurrentTabName } from './types.ts'
import { PhSidebarSimple } from '@phosphor-icons/vue'
import SettingsDialog from './dialogs/SettingsDialog.tsx'
import DownloadBatchEnqueueOverlay from './components/DownloadBatchEnqueueOverlay.tsx'
import ProgressPane from './panes/ProgressPane/ProgressPane.tsx'
import CategoryNavBar from './components/CategoryNavBar.tsx'
import FavoritesTabLabel from './components/FavoritesTabLabel.tsx'
import ReadTabLabel from './components/ReadTabLabel.tsx'
import { useReaderFullscreen } from './composables/useReaderFullscreen.ts'
import styles from './AppContent.module.css'
import {
  applyCompletedSideEffects,
  buildProgressData,
  hydratePersistedDownloadTasks,
  progressOptionsFromConfig,
} from './panes/ProgressPane/downloadTaskProgress.ts'

const SPLIT_RATIO_STORAGE_KEY = 'mainSplitLeftRatio'
const RIGHT_PANE_COLLAPSED_KEY = 'rightPaneCollapsed'
const SPLIT_MIN_RATIO = 0.2
const SPLIT_MAX_RATIO = 0.8

export default defineComponent({
  name: 'AppContent',
  setup() {
    const store = useStore()
    const { favoritesSection, readSection, currentTabName } = storeToRefs(store)
    const { isFullscreen: readerFullscreen } = useReaderFullscreen()

    const message = useMessage()

    const settingsDialogShowing = ref<boolean>(false)

    const searchPane = ref<InstanceType<typeof SearchPane>>()
    const splitRootRef = ref<HTMLElement | null>(null)
    const leftPaneRatio = ref(0.5)
    const leftPaneRatioBeforeCollapse = ref(0.5)
    const rightPaneCollapsed = ref(false)
    const isDraggingSplit = ref(false)

    function clampSplitRatio(ratio: number) {
      return Math.min(SPLIT_MAX_RATIO, Math.max(SPLIT_MIN_RATIO, ratio))
    }

    function persistSplitRatio() {
      localStorage.setItem(SPLIT_RATIO_STORAGE_KEY, String(leftPaneRatio.value))
    }

    function onSplitPointerMove(event: PointerEvent) {
      const root = splitRootRef.value
      if (root === null) {
        return
      }
      const rect = root.getBoundingClientRect()
      if (rect.width <= 0) {
        return
      }
      leftPaneRatio.value = clampSplitRatio((event.clientX - rect.left) / rect.width)
    }

    function stopSplitDrag() {
      if (!isDraggingSplit.value) {
        return
      }
      isDraggingSplit.value = false
      document.body.classList.remove(styles.splitDragging)
      document.removeEventListener('pointermove', onSplitPointerMove)
      document.removeEventListener('pointerup', stopSplitDrag)
      document.removeEventListener('pointercancel', stopSplitDrag)
      persistSplitRatio()
    }

    function onSplitPointerDown(event: PointerEvent) {
      if (rightPaneCollapsed.value) {
        return
      }
      event.preventDefault()
      isDraggingSplit.value = true
      document.body.classList.add(styles.splitDragging)
      document.addEventListener('pointermove', onSplitPointerMove)
      document.addEventListener('pointerup', stopSplitDrag)
      document.addEventListener('pointercancel', stopSplitDrag)
      onSplitPointerMove(event)
    }

    function toggleRightPane() {
      if (rightPaneCollapsed.value) {
        rightPaneCollapsed.value = false
        leftPaneRatio.value = clampSplitRatio(leftPaneRatioBeforeCollapse.value)
        localStorage.setItem(RIGHT_PANE_COLLAPSED_KEY, 'false')
        persistSplitRatio()
        return
      }
      leftPaneRatioBeforeCollapse.value = leftPaneRatio.value
      rightPaneCollapsed.value = true
      localStorage.setItem(RIGHT_PANE_COLLAPSED_KEY, 'true')
    }

    function renderRightPaneToggleIcon() {
      return (
        <NIcon size={20} class={styles.rightPaneToggleIcon}>
          <PhSidebarSimple />
        </NIcon>
      )
    }

    watch(
      () => store.config,
      async () => {
        if (store.config === undefined) {
          return
        }
        await commands.saveConfig(store.config)
        message.success('儲存設定成功')
      },
      { deep: true },
    )

    watch(
      () => store.config?.cookie,
      async (value, oldValue) => {
        if (store.config === undefined) {
          return
        }
        if (oldValue !== undefined && oldValue !== '' && value === '') {
          // 如果舊的 cookie 不為空，新的 cookie 為空，相當於退出登入
          store.userProfile = undefined
          store.config.cookie = ''
          message.success('已退出登入')
          return
        } else if (value === undefined || value === '') {
          // 如果 cookie 為空，說明用戶沒有登入
          return
        }

        const result = await commands.getUserProfile()
        if (result.status === 'error') {
          console.error(result.error)
          store.userProfile = undefined
          return
        }
        store.userProfile = result.data
        message.success('獲取使用者資訊成功')
      },
    )

    onMounted(async () => {
      // 屏蔽瀏覽器右鍵菜單
      document.oncontextmenu = (event) => {
        event.preventDefault()
      }
      const savedRatio = localStorage.getItem(SPLIT_RATIO_STORAGE_KEY)
      if (savedRatio !== null) {
        const parsed = Number.parseFloat(savedRatio)
        if (!Number.isNaN(parsed)) {
          leftPaneRatio.value = clampSplitRatio(parsed)
          leftPaneRatioBeforeCollapse.value = leftPaneRatio.value
        }
      }
      rightPaneCollapsed.value = localStorage.getItem(RIGHT_PANE_COLLAPSED_KEY) === 'true'
      // 取得設定
      store.config = await commands.getConfig()
      await hydratePersistedDownloadTasks(store)

      await events.downloadSleepingEvent.listen(async ({ payload: { comicId, remainingSec } }) => {
        store.updateProgressIndicator(comicId, `將在${remainingSec}秒後繼續下載`)
      })

      await events.downloadTaskEvent.listen(({ payload: downloadTaskEvent }) => {
        const { state, comic } = downloadTaskEvent
        if (state === 'Completed') {
          comic.isDownloaded = true
        }
        applyCompletedSideEffects(state, comic.id, store)
        store.setProgress(comic.id, buildProgressData(downloadTaskEvent, progressOptionsFromConfig(store.config)))
      })
    })

    onBeforeUnmount(() => {
      stopSplitDrag()
    })

    return () =>
      store.config !== undefined && (
        <div class="h-screen flex flex-col">
          <DownloadBatchEnqueueOverlay />
          <div
            ref={splitRootRef}
            class={styles.splitRoot}
            style={{ display: readerFullscreen.value ? 'none' : undefined }}>
            <div
              class={`${styles.splitPane} flex flex-col min-h-0`}
              style={{
                flex: rightPaneCollapsed.value ? '1 1 auto' : `0 0 ${leftPaneRatio.value * 100}%`,
                height: '100%',
              }}>
              <CategoryNavBar
                activeLabel={store.activeBrowseLabel}
                onBrowseCategory={(cateId, label) => {
                  store.currentTabName = 'search'
                  void searchPane.value?.searchByCategory(cateId, label)
                }}
                onBrowseList={(browse, label) => {
                  store.currentTabName = 'search'
                  void searchPane.value?.browseSiteList(browse, label)
                }}
                onBrowseRanking={(cateId, label) => {
                  store.currentTabName = 'search'
                  void searchPane.value?.browseRanking(cateId, label)
                }}
              />
              <NTabs
                class="flex-1 min-h-0 w-full"
                value={store.currentTabName}
                onUpdate:value={(value) => {
                  if (value === 'globalSnapshot') {
                    return
                  }
                  store.currentTabName = value as CurrentTabName
                }}
                type="line"
                size="small"
                animated>
                <NTabPane class="h-full overflow-auto p-0!" name="globalSnapshot" display-directive="show">
                  {{
                    tab: () => searchPane.value?.renderGlobalSnapshotTabControls?.() ?? <span>全站快照</span>,
                    default: () => null,
                  }}
                </NTabPane>
                <NTabPane class="h-full overflow-auto p-0!" name="search" tab="漫畫搜索" display-directive="show">
                  <SearchPane ref={searchPane} />
                </NTabPane>
                <NTabPane class="h-full overflow-auto p-0!" name="comic" tab="漫畫詳情" display-directive="show">
                  {searchPane.value && (
                    <ComicPane
                      searchByTag={searchPane.value.searchByTag}
                      searchFromComicDetail={searchPane.value.searchFromComicDetail}
                      hasComicCategorySnapshot={searchPane.value.hasComicCategorySnapshot}
                    />
                  )}
                </NTabPane>
                <NTabPane class="h-full overflow-auto p-0!" name="read" display-directive="show">
                  {{
                    tab: () => (
                      <ReadTabLabel
                        readActive={currentTabName.value === 'read'}
                        section={readSection.value}
                        onSelectSection={(section) => store.openRead(section)}
                      />
                    ),
                    default: () => (readSection.value === 'online' ? <ComicReadPane /> : <LocalReadPane />),
                  }}
                </NTabPane>
                <NTabPane class="h-full overflow-auto p-0!" name="favorites" display-directive="show">
                  {{
                    tab: () => (
                      <FavoritesTabLabel
                        favoritesActive={currentTabName.value === 'favorites'}
                        section={favoritesSection.value}
                        onSelectSection={(section) => store.openFavorites(section)}
                      />
                    ),
                    default: () => (
                      <FavoritesPane
                        section={favoritesSection.value}
                        searchByTag={async (tagName, page) => {
                          store.currentTabName = 'search'
                          await searchPane.value?.searchByTag(tagName, page)
                        }}
                        onOpenBookmarkedTab={(bookmark) => {
                          store.currentTabName = 'search'
                          searchPane.value?.openBookmarkedSearchTab(bookmark)
                        }}
                        renderScanCaches={() => searchPane.value?.renderScopedScanCachesPane() ?? null}
                      />
                    ),
                  }}
                </NTabPane>
              </NTabs>
            </div>

            {!rightPaneCollapsed.value && (
              <div
                class={[styles.splitHandle, isDraggingSplit.value && styles.splitHandleActive]}
                onPointerdown={onSplitPointerDown}
              />
            )}

            {rightPaneCollapsed.value ? (
              <div class={styles.collapsedRightPane}>
                <div class={styles.collapsedRightHeader}>
                  <button type="button" class={styles.expandRightTab} title="展開下載列表" onClick={toggleRightPane}>
                    {renderRightPaneToggleIcon()}
                  </button>
                </div>
              </div>
            ) : (
              <div class={`${styles.splitPane} flex flex-col flex-1 min-h-0 overflow-hidden`}>
                <ProgressPane
                  onOpenSettings={() => (settingsDialogShowing.value = true)}
                  onToggleRightPane={toggleRightPane}
                />
              </div>
            )}
          </div>
          <SettingsDialog
            showing={settingsDialogShowing.value}
            onUpdate:showing={(showing) => (settingsDialogShowing.value = showing)}
          />
        </div>
      )
  },
})
