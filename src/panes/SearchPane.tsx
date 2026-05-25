import { computed, defineComponent, nextTick, onMounted, onUnmounted, ref, Teleport, watch } from 'vue'
import {
  NButton,
  NPagination,
  useMessage,
  NInputGroup,
  NIcon,
  NDropdown,
  NSpin,
} from 'naive-ui'
import { useStore } from '../store.ts'
import { commands, events, ComicInSearch, SearchResult } from '../bindings.ts'
import ComicCard from '../components/ComicCard.tsx'
import GridColsIcon from '../components/GridColsIcon.tsx'
import { PhListBullets, PhMagnifyingGlass } from '@phosphor-icons/vue'
import FloatLabelInput from '../components/FloatLabelInput.tsx'
import {
  extractComicId,
  parseTagSearchLink,
  SEARCH_SORT_OPTIONS,
  sortSearchComics,
  type SearchSortOrder,
} from '../utils.ts'
import { getTagLabelFromSearch } from '../koreanWebtoon.ts'
import { analyzePageCatalogDuplicates } from '../koreanTxtDuplicate.ts'
import KoreanDownloadModeDialog from '../dialogs/KoreanDownloadModeDialog.tsx'
import { enqueueComicIds } from '../utils/batchEnqueueRunner.ts'
import {
  beginDownloadBatchEnqueueProgress,
  dismissDownloadBatchEnqueueOverlay,
  isDownloadBatchEnqueueRunning,
  runSerializedDownloadBatch,
  showBatchEnqueueDone,
  showBatchEnqueueFailures,
  updateDownloadBatchEnqueueProgress,
} from '../utils/downloadBatchEnqueue.ts'
import DownloadAllConfirmDialog from '../dialogs/DownloadAllConfirmDialog.tsx'
import {
  loadSearchResultTabs,
  saveSearchResultTabs,
} from '../searchResultTabsStorage.ts'
import {
  createEmptySearchResultTab,
  formatSearchResultTabTitle,
  type SearchResultTabState,
  type SearchSource,
} from './searchResultTabTypes.ts'
import {
  buildCollectedPageResult,
  cloneTabStateForRestore,
  isScopedSearchSource,
  SCOPED_COLLECTED_PAGE_SIZE,
  type SearchTabBookmark,
} from './searchTabBookmarkTypes.ts'
import SearchResultTabBar from './SearchResultTabBar.tsx'
import {
  listCategorySearchScopes,
  listRankingScopes,
  RANKING_PERIOD_OPTIONS,
  type RankingPeriod,
} from '../categories.ts'

/** 官網列表每頁 20 本；UI 分頁依「每頁顯示」按需抓取官網頁 */
const SERVER_PAGE_SIZE = 20
const COVER_LOAD_BATCH = 20
/** 連續請求間隔，降低官網限流（韓漫模式載入全部頁時使用） */
const PAGE_FETCH_DELAY_MS = 300
const PAGE_SIZE_OPTIONS = [20, 40, 60, 80, 100] as const
const SEARCH_PAGE_SIZE_STORAGE_KEY = 'searchDisplayPageSize'
const CATEGORY_SEARCH_SCOPE_OPTIONS = listCategorySearchScopes()

const SEARCH_SCOPE_DROPDOWN_OPTIONS = [
  { type: 'divider' as const, key: 'search-scope-divider-top' },
  { label: 'API快速搜索:', key: 'search-scope-header-api', disabled: true },
  { label: '全站（不限分類）', key: 'all' },
  { type: 'divider' as const, key: 'search-scope-divider-mid' },
  { label: '慢速掃描搜索:', key: 'search-scope-header-scan', disabled: true },
  ...CATEGORY_SEARCH_SCOPE_OPTIONS.map((o) => ({
    label: o.label,
    key: String(o.cateId),
  })),
  { type: 'divider' as const, key: 'search-scope-divider-bottom' },
]

type SearchResultLayout = 'list' | 'grid4' | 'grid6' | 'grid8' | 'grid10'

const SEARCH_LAYOUT_STORAGE_KEY = 'searchResultLayout'

const SEARCH_LAYOUT_OPTIONS: { key: SearchResultLayout; label: string }[] = [
  { key: 'grid4', label: '每排 4 個' },
  { key: 'grid6', label: '每排 6 個' },
  { key: 'grid8', label: '每排 8 個' },
  { key: 'grid10', label: '每排 10 個' },
  { key: 'list', label: '列表顯示' },
]

function isGridSearchLayout(layout: SearchResultLayout): boolean {
  return layout === 'grid4' || layout === 'grid6' || layout === 'grid8' || layout === 'grid10'
}

function comicCardLayout(layout: SearchResultLayout): 'list' | 'grid' {
  return isGridSearchLayout(layout) ? 'grid' : 'list'
}

function gridColsClass(layout: SearchResultLayout): string {
  switch (layout) {
    case 'grid6':
      return 'grid-cols-6'
    case 'grid8':
      return 'grid-cols-8'
    case 'grid10':
      return 'grid-cols-10'
    default:
      return 'grid-cols-4'
  }
}

function gridColsNumber(layout: SearchResultLayout): number {
  switch (layout) {
    case 'grid6':
      return 6
    case 'grid8':
      return 8
    case 'grid10':
      return 10
    default:
      return 4
  }
}

function layoutOptionLabel(layout: SearchResultLayout): string {
  return SEARCH_LAYOUT_OPTIONS.find((o) => o.key === layout)?.label ?? '檢視模式'
}

export default defineComponent({
  name: 'SearchPane',
  setup() {
    const store = useStore()

    const message = useMessage()

    const keywordOrComicLinkInput = ref<string>('')
    const searchingKeywordOrComicLink = ref<boolean>(false)
    const tagOrLinkInput = ref<string>('')
    const searchingTagOrLink = ref<boolean>(false)
    const activeTagSearchSource = ref<'name' | 'link'>('name')
    const viewPage = ref<number>(1)
    const pageSize = ref<number>(20)
    const allSearchComics = ref<ComicInSearch[]>([])
    const sortedComics = ref<ComicInSearch[]>([])
    const sortOrder = ref<SearchSortOrder>('createDateDesc')
    const visibleComics = ref<ComicInSearch[]>([])
    let pageCache = new Map<number, SearchResult>()
    const scopedOfflineMatches = ref<ComicInSearch[]>([])
    const searchTabs = ref<SearchResultTabState[]>([])
    const activeTabId = ref<string | null>(null)
    const downloadingAll = ref<boolean>(false)
    const openingKoreanMode = ref<boolean>(false)
    const koreanModeDialogShowing = ref<boolean>(false)
    const downloadAllConfirmShowing = ref<boolean>(false)
    const downloadAllCandidates = ref<ComicInSearch[]>([])
    const koreanModeComics = ref<ComicInSearch[]>([])
    const koreanModeLoadProgress = ref<{ current: number; total: number } | null>(null)
    const koreanModeLoadCancelled = ref<boolean>(false)
    const catalogAnalysisLoading = ref<boolean>(false)
    const catalogAnalysisProgress = ref<{ current: number; total: number } | null>(null)
    const catalogAnalysisByComicId = ref<Map<number, string>>(new Map())
    const activeTagLabel = ref<string>('')
    const activeCategoryLabel = ref<string>('')
    const searchScopeCategory = ref<{ cateId: number; label: string } | null>(null)
    const searchSource = ref<SearchSource>({ type: 'keyword' })
    const rankingPeriod = ref<RankingPeriod>('Week')
    const comicListScrollArea = ref<HTMLElement>()

    const fetchingPages = ref<boolean>(false)
    const viewPageFetchProgress = ref<{ current: number; total: number } | null>(null)
    const scopedSearchProgress = ref<{
      current: number
      total: number
      matchedCount: number
      scanKind: 'category' | 'tag' | 'search'
      paused: boolean
      retryInSecs: number | null
    } | null>(null)
    let unlistenSearchScanProgress: (() => void) | undefined
    const lastCommittedViewPage = ref<number>(1)
    const totalServerPagesHint = ref<number>(1)
    const totalCountHint = ref<number>(0)
    /** 總筆數已依實際尾端下修；後續官網頁 HTML 的 <b> 不再放大 totalCountHint */
    const totalCountRefined = ref(false)
    /** 每次新搜尋遞增；用於忽略過期的並發載入 */
    const searchSession = ref<number>(0)
    let searchQueue: Promise<void> = Promise.resolve()
    const coverLoadLimit = ref<number>(COVER_LOAD_BATCH)
    const searchResultLayout = ref<SearchResultLayout>('list')

    function loadSavedPageSize() {
      const saved = localStorage.getItem(SEARCH_PAGE_SIZE_STORAGE_KEY)
      if (saved !== null) {
        const n = parseInt(saved, 10)
        if (PAGE_SIZE_OPTIONS.includes(n as (typeof PAGE_SIZE_OPTIONS)[number])) {
          pageSize.value = n
        }
      }
    }
    loadSavedPageSize()

    function loadSavedSearchLayout() {
      const saved = localStorage.getItem(SEARCH_LAYOUT_STORAGE_KEY)
      if (saved === 'list' || saved === 'grid4' || saved === 'grid6' || saved === 'grid8' || saved === 'grid10') {
        searchResultLayout.value = saved
      } else if (saved === 'grid') {
        searchResultLayout.value = 'grid4'
      }
    }
    loadSavedSearchLayout()

    function tabTitleContext() {
      return {
        searchSource: searchSource.value,
        keywordOrComicLinkInput: keywordOrComicLinkInput.value,
        tagOrLinkInput: tagOrLinkInput.value,
        activeTagSearchSource: activeTagSearchSource.value,
        activeTagLabel: activeTagLabel.value,
        activeCategoryLabel: activeCategoryLabel.value,
        searchScopeCategory: searchScopeCategory.value,
        rankingPeriod: rankingPeriod.value,
      }
    }

    function captureTabState(): SearchResultTabState {
      const existing = searchTabs.value.find((t) => t.id === activeTabId.value)
      return {
        id: activeTabId.value ?? crypto.randomUUID(),
        title: existing?.title ?? formatSearchResultTabTitle(tabTitleContext()),
        keywordOrComicLinkInput: keywordOrComicLinkInput.value,
        tagOrLinkInput: tagOrLinkInput.value,
        activeTagSearchSource: activeTagSearchSource.value,
        searchSource: searchSource.value,
        searchScopeCategory: searchScopeCategory.value,
        activeTagLabel: activeTagLabel.value,
        activeCategoryLabel: activeCategoryLabel.value,
        rankingPeriod: rankingPeriod.value,
        viewPage: viewPage.value,
        allSearchComics: allSearchComics.value,
        sortedComics: sortedComics.value,
        visibleComics: visibleComics.value,
        pageCacheEntries: [...pageCache.entries()],
        sortOrder: sortOrder.value,
        catalogAnalysisEntries: [...catalogAnalysisByComicId.value.entries()],
        totalServerPagesHint: totalServerPagesHint.value,
        totalCountHint: totalCountHint.value,
        totalCountRefined: totalCountRefined.value,
        lastCommittedViewPage: lastCommittedViewPage.value,
        searchSession: searchSession.value,
        coverLoadLimit: coverLoadLimit.value,
        searchResult: store.searchResult,
        listScrollTop: comicListScrollArea.value?.scrollTop ?? 0,
        scopedOfflineMatches:
          scopedOfflineMatches.value.length > 0 ? [...scopedOfflineMatches.value] : undefined,
      }
    }

    function restoreTabState(tab: SearchResultTabState) {
      keywordOrComicLinkInput.value = tab.keywordOrComicLinkInput
      tagOrLinkInput.value = tab.tagOrLinkInput
      activeTagSearchSource.value = tab.activeTagSearchSource
      searchSource.value = tab.searchSource
      searchScopeCategory.value = tab.searchScopeCategory
      activeTagLabel.value = tab.activeTagLabel
      activeCategoryLabel.value = tab.activeCategoryLabel
      rankingPeriod.value = tab.rankingPeriod
      viewPage.value = tab.viewPage
      allSearchComics.value = tab.allSearchComics
      sortedComics.value = tab.sortedComics
      visibleComics.value = tab.visibleComics
      pageCache = new Map(tab.pageCacheEntries)
      sortOrder.value = tab.sortOrder
      catalogAnalysisByComicId.value = new Map(tab.catalogAnalysisEntries)
      totalServerPagesHint.value = tab.totalServerPagesHint
      totalCountHint.value = tab.totalCountHint
      totalCountRefined.value = tab.totalCountRefined ?? false
      lastCommittedViewPage.value = tab.lastCommittedViewPage
      searchSession.value = tab.searchSession
      coverLoadLimit.value = tab.coverLoadLimit
      scopedOfflineMatches.value = tab.scopedOfflineMatches ?? []
      store.searchResult = synthesizeSearchResultFromTab(tab)
      store.activeBrowseLabel = tab.activeCategoryLabel
      void nextTick(() => {
        const el = comicListScrollArea.value
        if (el !== undefined) {
          el.scrollTop = tab.listScrollTop
        }
      })
    }

    function synthesizeSearchResultFromTab(tab: SearchResultTabState): SearchResult | undefined {
      if (tab.searchResult !== undefined) {
        return tab.searchResult
      }
      const comics = tab.allSearchComics.length > 0 ? tab.allSearchComics : tab.visibleComics
      if (comics.length === 0) {
        return undefined
      }
      return {
        comics,
        currentPage: tab.viewPage,
        totalPage: Math.max(1, tab.totalServerPagesHint),
        totalCount: tab.totalCountHint,
        isSearchByTag: tab.searchSource.type === 'tag',
      }
    }

    function cancelInFlightSearchUi() {
      searchSession.value++
      fetchingPages.value = false
      viewPageFetchProgress.value = null
    }

    function persistActiveTab() {
      if (activeTabId.value === null) {
        saveSearchResultTabs(searchTabs.value, activeTabId.value)
        return
      }
      const idx = searchTabs.value.findIndex((t) => t.id === activeTabId.value)
      if (idx < 0) {
        saveSearchResultTabs(searchTabs.value, activeTabId.value)
        return
      }
      const next = [...searchTabs.value]
      next[idx] = captureTabState()
      searchTabs.value = next
      saveSearchResultTabs(searchTabs.value, activeTabId.value)
    }

    /** 新搜尋會改寫共用 ref；先保存目前分頁，避免把新搜尋條件寫進舊分頁。 */
    function persistActiveTabBeforeNewSearch() {
      if (activeTabId.value !== null) {
        persistActiveTab()
      }
    }

    function restoreSavedSearchTabs() {
      const saved = loadSearchResultTabs()
      if (saved === null) {
        return
      }
      searchTabs.value = saved.tabs
      activeTabId.value = saved.activeTabId
      searchSession.value = Date.now()
      const tab = saved.tabs.find((t) => t.id === saved.activeTabId)
      if (tab !== undefined) {
        restoreTabState(tab)
        if (tab.searchResult !== undefined) {
          store.currentTabName = 'search'
        }
      }
    }

    function openNewSearchTab(title: string) {
      const tab = createEmptySearchResultTab(title, searchSession.value)
      searchTabs.value = [...searchTabs.value, tab]
      activeTabId.value = tab.id
      saveSearchResultTabs(searchTabs.value, activeTabId.value)
      // 只清空結果快取；searchSource／輸入框由呼叫端在 openNewSearchTab 之後設定。
      // 若 restoreTabState(空白分頁) 會把 searchSource 重置為 keyword，導致分類／標籤 fetch 失敗。
      clearSearchResultsForNewSearch()
      store.searchResult = undefined
    }

    function switchSearchTab(id: string) {
      if (id === activeTabId.value) {
        return
      }
      persistActiveTab()
      cancelInFlightSearchUi()
      activeTabId.value = id
      const tab = searchTabs.value.find((t) => t.id === id)
      if (tab !== undefined) {
        restoreTabState(tab)
      }
      saveSearchResultTabs(searchTabs.value, activeTabId.value)
    }

    function closeSearchTab(id: string) {
      const idx = searchTabs.value.findIndex((t) => t.id === id)
      if (idx < 0) {
        return
      }
      const wasActive = activeTabId.value === id
      const remaining = searchTabs.value.filter((t) => t.id !== id)
      searchTabs.value = remaining
      saveSearchResultTabs(searchTabs.value, activeTabId.value)
      if (!wasActive) {
        return
      }
      if (remaining.length === 0) {
        activeTabId.value = null
        store.searchResult = undefined
        restoreTabState(createEmptySearchResultTab('新搜尋', searchSession.value))
        saveSearchResultTabs([], null)
        return
      }
      const nextTab = remaining[Math.min(idx, remaining.length - 1)]!
      activeTabId.value = nextTab.id
      restoreTabState(nextTab)
    }

    function tabStateForBookmark(tabId: string): SearchResultTabState | undefined {
      if (tabId === activeTabId.value) {
        return captureTabState()
      }
      return searchTabs.value.find((t) => t.id === tabId)
    }

    function toggleSearchTabBookmark(tabId: string) {
      void runExclusiveSearch(async () => {
        let tab = tabStateForBookmark(tabId)
        if (tab === undefined) {
          return
        }

        if (isScopedSearchSource(tab.searchSource)) {
          const fullCount = tab.totalCountHint
          const offline = tab.scopedOfflineMatches ?? []
          const hasFullList = fullCount > 0 && offline.length >= fullCount
          if (!hasFullList) {
            if (tabId !== activeTabId.value) {
              message.warning('請先切換到該分頁，並等待掃描完成後再收藏')
              return
            }
            const ok = await hydrateScopedOfflineMatches(searchSession.value)
            if (!ok) {
              message.warning('無法取得完整掃描結果，請稍後再試')
              return
            }
            tab = captureTabState()
          }
        }

        store.toggleFavoriteSearchTab(tabId, tab)
      })
    }

    function openBookmarkedSearchTab(bookmark: SearchTabBookmark) {
      void runExclusiveSearch(async () => {
        if (activeTabId.value !== null) {
          persistActiveTab()
        }
        cancelInFlightSearchUi()
        clearScopedSearchProgress()
        searchSession.value = Date.now()

        const newTabId = crypto.randomUUID()
        const restored = cloneTabStateForRestore(bookmark.tabState, newTabId)
        restored.title = bookmark.title

        searchTabs.value = [...searchTabs.value, restored]
        activeTabId.value = newTabId
        restoreTabState(restored)
        saveSearchResultTabs(searchTabs.value, activeTabId.value)

        if (
          isScopedSearchSource(restored.searchSource) &&
          (restored.scopedOfflineMatches === undefined ||
            restored.scopedOfflineMatches.length === 0)
        ) {
          message.warning(
            '此收藏建立時未保存完整列表，需重新掃描；請掃描完成後再次點星星更新收藏',
          )
        }

        applySortToList()
        await goToViewPage(restored.viewPage)
        store.clearCoversForComicIds(visibleComics.value.map((c) => c.id))
        resetCoverLoadWindow()
        await nextTick()
        onComicListScroll()
      })
    }

    const sortButtonLabel = computed(
      () => SEARCH_SORT_OPTIONS.find((o) => o.key === sortOrder.value)?.label ?? '排列方式',
    )

    const pageSizeButtonLabel = computed(() => `每頁 ${pageSize.value}`)

    const displayPageCount = computed(() => {
      if (totalCountHint.value <= 0) {
        return 1
      }
      return Math.max(1, Math.ceil(totalCountHint.value / pageSize.value))
    })

    const isInitialSearchBusy = computed(
      () => searchingKeywordOrComicLink.value || searchingTagOrLink.value,
    )

    const isSearchBusy = computed(
      () =>
        isInitialSearchBusy.value ||
        fetchingPages.value ||
        isDownloadBatchEnqueueRunning(),
    )

    const isViewPageLoading = computed(() => viewPageFetchProgress.value !== null)

    const canUseKoreanDownloadMode = computed(() => {
      if (store.searchResult === undefined) {
        return false
      }
      const source = searchSource.value
      return source.type === 'keyword' || source.type === 'tag'
    })

    const hasActiveSearchResults = computed(
      () =>
        store.searchResult !== undefined ||
        visibleComics.value.length > 0 ||
        allSearchComics.value.length > 0,
    )

    const isKoreanModeLoading = computed(() => koreanModeLoadProgress.value !== null)

    const koreanModeButtonLabel = computed(() => {
      const progress = koreanModeLoadProgress.value
      if (progress === null) {
        return '韓漫下載模式'
      }
      return `取消載入 (${progress.current}/${progress.total})`
    })

    const isScopedSearchActive = computed(() => {
      const source = searchSource.value
      if (source.type === 'keyword' && source.cateId !== undefined) {
        return true
      }
      return source.type === 'tag' && source.cateId !== undefined
    })

    const isScopedScanOverlay = computed(() => {
      if (!isScopedSearchActive.value) {
        return false
      }
      // 僅在後端正在回報掃描進度時顯示全螢幕遮罩；勿用 isInitialSearchBusy，
      // 否則分類瀏覽與關鍵詞搜尋交疊時 loading 旗標可能殘留並擋住所有點擊。
      return scopedSearchProgress.value !== null
    })

    const loadingDescription = computed(() => {
      const scoped = scopedSearchProgress.value
      if (scoped !== null) {
        const listLabel =
          scoped.scanKind === 'tag'
            ? '標籤列表'
            : scoped.scanKind === 'search'
              ? '搜尋結果'
              : '分類列表'
        if (scoped.paused && scoped.retryInSecs !== null) {
          return `請求過於頻繁，${scoped.retryInSecs} 秒後從第 ${scoped.current}/${scoped.total} 頁繼續…（已找到 ${scoped.matchedCount} 本）`
        }
        return `正在掃描${listLabel} ${scoped.current}/${scoped.total} 頁（已找到 ${scoped.matchedCount} 本）`
      }
      if (isScopedSearchActive.value && isInitialSearchBusy.value) {
        return '正在準備分類掃描…'
      }
      const progress = viewPageFetchProgress.value
      if (progress !== null) {
        return `正在載入 ${progress.current}/${progress.total} 頁`
      }
      return `正在載入第 ${viewPage.value} 頁…`
    })

    onMounted(async () => {
      restoreSavedSearchTabs()
      unlistenSearchScanProgress = await events.searchScanProgressEvent.listen(
        ({ payload }) => {
          if (payload.cancelled || payload.finished) {
            scopedSearchProgress.value = null
            return
          }
          scopedSearchProgress.value = {
            current: payload.current,
            total: payload.total,
            matchedCount: payload.matchedCount,
            scanKind:
              payload.scanKind === 'tag'
                ? 'tag'
                : payload.scanKind === 'search'
                  ? 'search'
                  : 'category',
            paused: payload.paused,
            retryInSecs: payload.retryInSecs,
          }
        },
      )
    })

    onUnmounted(() => {
      persistActiveTab()
      unlistenSearchScanProgress?.()
    })

    function clearScopedSearchProgress() {
      scopedSearchProgress.value = null
    }

    function isSearchCancelledError(err: { errMessage?: string; err_message?: string }): boolean {
      const msg = err.errMessage ?? err.err_message ?? ''
      return msg.includes('已取消')
    }

    function formatInvokeError(error: unknown): string {
      if (error === null || error === undefined) {
        return '未知錯誤'
      }
      if (typeof error === 'string') {
        return error
      }
      if (typeof error === 'object') {
        const record = error as Record<string, unknown>
        const msg = record.err_message ?? record.errMessage ?? record.message
        const title = record.err_title ?? record.errTitle ?? record.title
        if (typeof msg === 'string' && msg.length > 0) {
          return msg
        }
        if (typeof title === 'string' && title.length > 0) {
          return title
        }
        try {
          return JSON.stringify(error)
        } catch {
          return '未知錯誤'
        }
      }
      return String(error)
    }

    function cancelScopedSearch() {
      void commands.cancelScopedSearchScan()
    }

    function scrollListToTop() {
      void nextTick(() => {
        const el = comicListScrollArea.value
        if (el !== undefined) {
          el.scrollTop = 0
        }
      })
    }

    watch(
      () => store.searchResult,
      () => {
        scrollListToTop()
      },
    )

    function runExclusiveSearch(task: () => Promise<void>): Promise<void> {
      const next = searchQueue.then(task)
      searchQueue = next.catch(() => {})
      return next
    }

    function sleep(ms: number) {
      return new Promise<void>((resolve) => {
        setTimeout(resolve, ms)
      })
    }

    async function sleepUnlessCancelled(ms: number, shouldStop: () => boolean): Promise<boolean> {
      const step = 50
      let elapsed = 0
      while (elapsed < ms) {
        if (shouldStop()) {
          return false
        }
        const chunk = Math.min(step, ms - elapsed)
        await sleep(chunk)
        elapsed += chunk
      }
      return !shouldStop()
    }

    function mergeComicsInto(target: ComicInSearch[], pageComics: ComicInSearch[]) {
      const seen = new Set(target.map((c) => c.id))
      for (const comic of pageComics) {
        if (!seen.has(comic.id)) {
          seen.add(comic.id)
          target.push(comic)
        }
      }
    }

    function cancelKoreanModeLoad() {
      koreanModeLoadCancelled.value = true
    }

    async function loadAllComicsForKoreanMode(
      session: number,
    ): Promise<ComicInSearch[] | 'cancelled' | undefined> {
      const merged: ComicInSearch[] = []
      let consecutiveEmptyPages = 0
      let serverPageNum = 1
      let totalPages = Math.max(totalServerPagesHint.value, 1)

      koreanModeLoadCancelled.value = false
      koreanModeLoadProgress.value = { current: 0, total: totalPages }

      const shouldStop = () => koreanModeLoadCancelled.value || !isActiveSearchSession(session)

      try {
        while (serverPageNum <= totalPages) {
          if (shouldStop()) {
            return koreanModeLoadCancelled.value ? 'cancelled' : undefined
          }

          koreanModeLoadProgress.value = { current: serverPageNum, total: totalPages }

          let pageResult = pageCache.get(serverPageNum)
          if (pageResult === undefined) {
            if (serverPageNum > 1) {
              const continued = await sleepUnlessCancelled(PAGE_FETCH_DELAY_MS, shouldStop)
              if (!continued) {
                return koreanModeLoadCancelled.value ? 'cancelled' : undefined
              }
            }
            if (shouldStop()) {
              return koreanModeLoadCancelled.value ? 'cancelled' : undefined
            }
            const fetched = await fetchSearchPage(serverPageNum, session)
            if (shouldStop()) {
              return koreanModeLoadCancelled.value ? 'cancelled' : undefined
            }
            if (fetched === undefined) {
              consecutiveEmptyPages++
              if (consecutiveEmptyPages >= 2) {
                break
              }
              serverPageNum++
              continue
            }
            pageResult = fetched
            ingestSearchMetadata(fetched, serverPageNum)
          }

          if (pageResult.comics.length === 0) {
            consecutiveEmptyPages++
            shrinkTotalCountFromServerPage(serverPageNum, pageResult)
            if (consecutiveEmptyPages >= 2) {
              break
            }
          } else {
            consecutiveEmptyPages = 0
            mergeComicsInto(merged, pageResult.comics)
            shrinkTotalCountFromServerPage(serverPageNum, pageResult)
          }

          totalPages = Math.min(
            Math.max(totalPages, pageResult.totalPage),
            totalServerPagesHint.value,
          )
          koreanModeLoadProgress.value = { current: serverPageNum, total: totalPages }
          serverPageNum++
        }

        if (merged.length > 0) {
          refineTotalCountHint(merged.length)
        }
        return merged
      } finally {
        koreanModeLoadProgress.value = null
      }
    }

    function isActiveSearchSession(session: number) {
      return session === searchSession.value
    }

    function beginSearchSession(): number {
      searchSession.value++
      return searchSession.value
    }

    function clearSearchResultsForNewSearch() {
      pageCache.clear()
      allSearchComics.value = []
      sortedComics.value = []
      visibleComics.value = []
      catalogAnalysisByComicId.value = new Map()
      totalServerPagesHint.value = 1
      totalCountHint.value = 0
      totalCountRefined.value = false
      viewPage.value = 1
      lastCommittedViewPage.value = 1
      viewPageFetchProgress.value = null
      scopedOfflineMatches.value = []
    }

    function hasScopedOfflineMatches() {
      return scopedOfflineMatches.value.length > 0
    }

    function getSortedScopedOfflineMatches(): ComicInSearch[] {
      return sortSearchComics(scopedOfflineMatches.value, sortOrder.value)
    }

    async function fetchSearchPageFromApi(
      serverPage: number,
      session: number,
    ): Promise<SearchResult | undefined> {
      const source = searchSource.value
      let result:
        | Awaited<ReturnType<typeof commands.browseByCategory>>
        | undefined

      if (source.type === 'category') {
        result = await commands.browseByCategory(source.cateId, serverPage)
      } else if (source.type === 'ranking') {
        result = await commands.browseRanking(source.period, source.cateId, serverPage)
      } else if (source.type === 'albums') {
        result =
          source.list === 'home'
            ? await commands.browseHome(serverPage)
            : await commands.browseAlbumsList(serverPage)
      } else if (source.type === 'tag') {
        const cateId = source.cateId ?? null
        if (activeTagSearchSource.value === 'link') {
          const trimmed = tagOrLinkInput.value.trim()
          const parsed = parseTagSearchLink(trimmed)
          if (parsed === undefined) {
            return undefined
          }
          const pageToFetch = serverPage === 1 ? parsed.page : serverPage
          result = await commands.searchByTag(parsed.tagSlug, pageToFetch, cateId)
        } else {
          result = await commands.searchByTag(tagOrLinkInput.value.trim(), serverPage, cateId)
        }
      } else {
        const cateId = source.type === 'keyword' ? (source.cateId ?? null) : null
        result = await commands.searchByKeyword(
          keywordOrComicLinkInput.value.trim(),
          serverPage,
          cateId,
        )
      }

      if (!isActiveSearchSession(session)) {
        return undefined
      }
      if (result === undefined || result.status === 'error') {
        if (result?.status === 'error') {
          console.error(result.error)
        }
        return undefined
      }
      return result.data
    }

    async function fetchSearchPage(
      serverPage: number,
      session: number,
    ): Promise<SearchResult | undefined> {
      if (!isActiveSearchSession(session)) {
        return undefined
      }
      if (hasScopedOfflineMatches()) {
        const isTag = searchSource.value.type === 'tag'
        return buildCollectedPageResult(getSortedScopedOfflineMatches(), serverPage, isTag)
      }
      return fetchSearchPageFromApi(serverPage, session)
    }

    async function hydrateScopedOfflineMatches(session: number): Promise<boolean> {
      if (!isScopedSearchActive.value || totalCountHint.value <= 0) {
        return false
      }
      if (hasScopedOfflineMatches() && scopedOfflineMatches.value.length >= totalCountHint.value) {
        return true
      }

      const totalCollectedPages = Math.max(
        1,
        Math.ceil(totalCountHint.value / SCOPED_COLLECTED_PAGE_SIZE),
      )
      const merged: ComicInSearch[] = []

      for (let collectedPage = 1; collectedPage <= totalCollectedPages; collectedPage++) {
        if (!isActiveSearchSession(session)) {
          return false
        }
        const pageResult = await fetchSearchPageFromApi(collectedPage, session)
        if (pageResult === undefined) {
          return false
        }
        mergeComicsInto(merged, pageResult.comics)
        if (merged.length >= totalCountHint.value) {
          break
        }
      }

      if (!isActiveSearchSession(session) || merged.length === 0) {
        return false
      }

      scopedOfflineMatches.value = merged.slice(0, totalCountHint.value)
      persistActiveTab()
      return true
    }

    function hydrateScopedOfflineMatchesInBackground(session: number) {
      if (!isScopedSearchActive.value || totalCountHint.value <= 0) {
        return
      }
      void hydrateScopedOfflineMatches(session).catch((err) => {
        console.error(err)
      })
    }

    function effectiveTotalCount(result: SearchResult): number {
      if (result.totalCount > 0) {
        return result.totalCount
      }
      if (result.comics.length > 0) {
        return Math.max(
          result.comics.length,
          (Math.max(result.totalPage, 1) - 1) * SERVER_PAGE_SIZE + result.comics.length,
        )
      }
      return 0
    }

    /** 依已抓到的官網頁縮小總筆數（官網 <b> 常大於實際可翻頁筆數）。 */
    function refineTotalCountHint(provenTotal: number) {
      if (provenTotal < 0) {
        return
      }
      if (provenTotal === 0 && totalCountHint.value > 0) {
        return
      }
      const prev = totalCountHint.value
      const next = prev > 0 ? Math.min(prev, provenTotal) : provenTotal
      if (next === prev) {
        return
      }
      if (prev > 0 && next < prev) {
        totalCountRefined.value = true
      }
      totalCountHint.value = next
      totalServerPagesHint.value = Math.max(1, Math.ceil(next / SERVER_PAGE_SIZE))
      const maxViewPage = Math.max(1, Math.ceil(next / pageSize.value))
      if (viewPage.value > maxViewPage) {
        viewPage.value = maxViewPage
      }
      if (store.searchResult !== undefined) {
        store.searchResult = {
          ...store.searchResult,
          totalCount: next,
          totalPage: Math.max(1, Math.ceil(next / SERVER_PAGE_SIZE)),
        }
      }
    }

    function shrinkTotalCountFromServerPage(serverPage: number, result: SearchResult) {
      if (hasScopedOfflineMatches() || isScopedSearchActive.value || result.isSearchByTag) {
        return
      }
      const pageStart = (serverPage - 1) * SERVER_PAGE_SIZE
      const count = result.comics.length
      if (count === 0) {
        refineTotalCountHint(pageStart)
      } else if (count < SERVER_PAGE_SIZE) {
        refineTotalCountHint(pageStart + count)
      }
    }

    function ingestSearchMetadata(result: SearchResult, requestedServerPage?: number) {
      const cachePage = requestedServerPage ?? result.currentPage
      pageCache.set(cachePage, result)
      const total = effectiveTotalCount(result)
      if (!totalCountRefined.value) {
        totalServerPagesHint.value = Math.max(
          totalServerPagesHint.value,
          result.totalPage > 0 ? result.totalPage : Math.max(1, Math.ceil(total / SERVER_PAGE_SIZE)),
        )
        totalCountHint.value = Math.max(totalCountHint.value, total)
      }
      shrinkTotalCountFromServerPage(cachePage, result)
    }

    async function ensureServerPageInCache(
      serverPage: number,
      session: number,
      delayBeforeFetch: boolean,
    ): Promise<SearchResult | undefined> {
      const cached = pageCache.get(serverPage)
      if (cached !== undefined) {
        return cached
      }
      if (delayBeforeFetch) {
        await sleep(PAGE_FETCH_DELAY_MS)
      }
      if (!isActiveSearchSession(session)) {
        return undefined
      }
      const result = await fetchSearchPage(serverPage, session)
      if (!isActiveSearchSession(session) || result === undefined) {
        return undefined
      }
      ingestSearchMetadata(result, serverPage)
      return result
    }

    /** 超範圍請求常回第 1 頁空殼；二分搜尋找出最後一頁有資料的官網頁。 */
    async function discoverSearchTailTotal(upperEmptyPage: number, session: number) {
      if (hasScopedOfflineMatches() || isScopedSearchActive.value) {
        return
      }

      let lo = 1
      let hi = upperEmptyPage
      let fetchCount = 0

      while (lo <= hi) {
        if (!isActiveSearchSession(session)) {
          return
        }

        const mid = Math.floor((lo + hi) / 2)
        const result = await ensureServerPageInCache(mid, session, fetchCount > 0)
        fetchCount++
        if (result === undefined) {
          return
        }

        const count = result.comics.length
        if (count === 0) {
          hi = mid - 1
        } else if (count < SERVER_PAGE_SIZE) {
          refineTotalCountHint((mid - 1) * SERVER_PAGE_SIZE + count)
          return
        } else {
          lo = mid + 1
        }
      }

      if (hi >= 1 && isActiveSearchSession(session)) {
        const tail = await ensureServerPageInCache(hi, session, fetchCount > 0)
        if (tail !== undefined && tail.comics.length > 0) {
          refineTotalCountHint((hi - 1) * SERVER_PAGE_SIZE + tail.comics.length)
        }
      }
    }

    function mergeServerPageComics(firstServerPage: number, lastServerPage: number): ComicInSearch[] {
      const merged: ComicInSearch[] = []
      for (let p = firstServerPage; p <= lastServerPage; p++) {
        const cached = pageCache.get(p)
        if (cached !== undefined) {
          merged.push(...cached.comics)
        }
      }
      return merged
    }

    async function ensureServerPagesLoaded(
      firstServerPage: number,
      lastServerPage: number,
      session: number,
      onProgress: (current: number, total: number) => void,
    ): Promise<'ok' | 'error' | 'superseded'> {
      const total = Math.max(1, lastServerPage - firstServerPage + 1)
      let completed = 0
      let networkStarted = false
      let hadNetworkFetch = false

      const reportProgress = () => {
        onProgress(completed, total)
      }

      reportProgress()

      try {
        for (let p = firstServerPage; p <= lastServerPage; p++) {
          if (p > totalServerPagesHint.value) {
            break
          }

          if (pageCache.has(p)) {
            completed++
            reportProgress()
            continue
          }

          if (!networkStarted) {
            fetchingPages.value = true
            networkStarted = true
          }

          if (hadNetworkFetch) {
            await sleep(PAGE_FETCH_DELAY_MS)
          }
          if (!isActiveSearchSession(session)) {
            return 'superseded'
          }

          const result = await ensureServerPageInCache(p, session, hadNetworkFetch)
          if (!isActiveSearchSession(session)) {
            return 'superseded'
          }
          if (result === undefined) {
            return 'error'
          }

          hadNetworkFetch = true
          completed++
          reportProgress()
        }

        return 'ok'
      } finally {
        if (networkStarted) {
          fetchingPages.value = false
        }
      }
    }

    async function goToViewPage(page: number): Promise<boolean> {
      const pageCount = displayPageCount.value
      if (page < 1 || page > pageCount) {
        return false
      }
      if (page !== lastCommittedViewPage.value) {
        catalogAnalysisByComicId.value = new Map()
      }
      if (totalCountHint.value <= 0) {
        const cachedFirst = pageCache.get(1)
        if (cachedFirst !== undefined && cachedFirst.comics.length > 0) {
          totalCountHint.value = effectiveTotalCount(cachedFirst)
          totalServerPagesHint.value = Math.max(
            totalServerPagesHint.value,
            cachedFirst.totalPage > 0
              ? cachedFirst.totalPage
              : Math.max(1, Math.ceil(totalCountHint.value / SERVER_PAGE_SIZE)),
          )
        } else {
          return false
        }
      }

      const session = searchSession.value
      const previousCommittedPage = lastCommittedViewPage.value
      const startIdx = (page - 1) * pageSize.value
      const endIdx = Math.min(page * pageSize.value, totalCountHint.value)
      if (startIdx >= totalCountHint.value) {
        return false
      }

      viewPage.value = page
      scrollListToTop()

      if (hasScopedOfflineMatches()) {
        const sorted = getSortedScopedOfflineMatches()
        allSearchComics.value = sorted.slice(startIdx, endIdx)

        if (store.searchResult !== undefined) {
          store.searchResult = {
            ...store.searchResult,
            comics: allSearchComics.value,
            currentPage: page,
          }
        }

        lastCommittedViewPage.value = page
        applySortToList()
        showViewPage(page)
        persistActiveTab()
        return true
      }

      const firstServerPage = Math.floor(startIdx / SERVER_PAGE_SIZE) + 1
      const lastServerPage = Math.floor((endIdx - 1) / SERVER_PAGE_SIZE) + 1

      viewPageFetchProgress.value = { current: 0, total: Math.max(1, lastServerPage - firstServerPage + 1) }

      const loadResult = await ensureServerPagesLoaded(
        firstServerPage,
        lastServerPage,
        session,
        (current, total) => {
          viewPageFetchProgress.value = { current, total }
        },
      )

      viewPageFetchProgress.value = null

      if (loadResult === 'superseded') {
        viewPage.value = previousCommittedPage
        return false
      }
      if (loadResult === 'error') {
        viewPage.value = previousCommittedPage
        message.error('無法載入這一頁，請稍後再試')
        return false
      }
      if (!isActiveSearchSession(session)) {
        viewPage.value = previousCommittedPage
        return false
      }

      const merged = mergeServerPageComics(firstServerPage, lastServerPage)
      const offsetInMerged = startIdx - (firstServerPage - 1) * SERVER_PAGE_SIZE
      const wantedCount = endIdx - startIdx
      allSearchComics.value = merged.slice(offsetInMerged, offsetInMerged + wantedCount)

      if (!hasScopedOfflineMatches() && !isScopedSearchActive.value) {
        const firstCached = pageCache.get(firstServerPage)
        if (
          allSearchComics.value.length < wantedCount &&
          firstServerPage > 1 &&
          (merged.length === 0 || firstCached?.comics.length === 0)
        ) {
          await discoverSearchTailTotal(firstServerPage, session)
        } else if (allSearchComics.value.length < wantedCount) {
          refineTotalCountHint(startIdx + allSearchComics.value.length)
        }
      }

      const maxViewPage = Math.max(1, Math.ceil(totalCountHint.value / pageSize.value))
      if (page > maxViewPage && totalCountHint.value > 0) {
        return goToViewPage(maxViewPage)
      }

      if (store.searchResult !== undefined) {
        store.searchResult = {
          ...store.searchResult,
          comics: allSearchComics.value,
          currentPage: page,
        }
      }

      lastCommittedViewPage.value = page
      applySortToList()
      showViewPage(page)
      persistActiveTab()
      return true
    }

    function goToViewPageExclusive(page: number) {
      void runExclusiveSearch(async () => {
        await goToViewPage(page)
      })
    }

    async function applyFirstSearchPage(result: SearchResult): Promise<boolean> {
      store.searchResult = result
      ingestSearchMetadata(result, 1)
      return goToViewPage(1)
    }

    async function completeNewSearchTab(
      pendingTabTitle: string | null,
      result: SearchResult,
    ): Promise<boolean> {
      if (pendingTabTitle !== null) {
        openNewSearchTab(pendingTabTitle)
      }
      const session = searchSession.value
      const ok = await applyFirstSearchPage(result)
      if (ok && isScopedSearchActive.value && totalCountHint.value > 0) {
        hydrateScopedOfflineMatchesInBackground(session)
      }
      if (!ok && pendingTabTitle !== null && activeTabId.value !== null) {
        closeSearchTab(activeTabId.value)
      }
      return ok
    }

    function resetCoverLoadWindow() {
      coverLoadLimit.value = Math.max(COVER_LOAD_BATCH, visibleComics.value.length)
      scrollListToTop()
    }

    function setSearchResultLayout(layout: SearchResultLayout) {
      if (searchResultLayout.value === layout) {
        return
      }
      searchResultLayout.value = layout
      localStorage.setItem(SEARCH_LAYOUT_STORAGE_KEY, layout)
      resetCoverLoadWindow()
    }

    function onComicListScroll() {
      const container = comicListScrollArea.value
      if (container === undefined || visibleComics.value.length === 0) {
        return
      }

      const listRoot = container.querySelector<HTMLElement>('[data-comic-list]')
      if (listRoot === null) {
        return
      }

      const children = listRoot.children
      let lastVisibleIndex = 0
      const containerBottom = container.getBoundingClientRect().bottom

      for (let i = 0; i < children.length; i++) {
        const child = children[i]
        if (child === undefined) {
          continue
        }
        if (child.getBoundingClientRect().top < containerBottom) {
          lastVisibleIndex = i
        }
      }

      const needCount = Math.min(
        visibleComics.value.length,
        Math.max(COVER_LOAD_BATCH, Math.ceil((lastVisibleIndex + 1) / COVER_LOAD_BATCH) * COVER_LOAD_BATCH),
      )

      if (needCount > coverLoadLimit.value) {
        coverLoadLimit.value = needCount
      }
    }

    function applySortToList() {
      sortedComics.value = sortSearchComics(allSearchComics.value, sortOrder.value)
    }

    function showViewPage(page: number) {
      viewPage.value = Math.min(Math.max(1, page), displayPageCount.value)
      visibleComics.value = sortedComics.value
      resetCoverLoadWindow()
      void nextTick(() => onComicListScroll())
    }

    async function onSortChange(key: SearchSortOrder) {
      sortOrder.value = key
      if (allSearchComics.value.length === 0) {
        return
      }
      applySortToList()
      showViewPage(viewPage.value)
    }

    async function searchByKeywordImpl(keyword: string) {
      const scope = searchScopeCategory.value
      const tabTitle = formatSearchResultTabTitle({
        searchSource: scope !== null ? { type: 'keyword', cateId: scope.cateId } : { type: 'keyword' },
        keywordOrComicLinkInput: keyword,
        tagOrLinkInput: tagOrLinkInput.value,
        activeTagSearchSource: activeTagSearchSource.value,
        activeTagLabel: '',
        activeCategoryLabel: scope?.label ?? '',
        searchScopeCategory: scope,
        rankingPeriod: rankingPeriod.value,
      })
      persistActiveTabBeforeNewSearch()
      keywordOrComicLinkInput.value = keyword
      searchSource.value =
        scope !== null ? { type: 'keyword', cateId: scope.cateId } : { type: 'keyword' }
      activeTagLabel.value = ''
      if (scope !== null) {
        activeCategoryLabel.value = scope.label
        store.activeBrowseLabel = scope.label
      } else {
        activeCategoryLabel.value = ''
        store.activeBrowseLabel = ''
      }
      searchingKeywordOrComicLink.value = true
      const session = beginSearchSession()

      const result = await commands.searchByKeyword(keyword, 1, scope?.cateId ?? null)
      if (!isActiveSearchSession(session)) {
        searchingKeywordOrComicLink.value = false
        return
      }
      if (result.status === 'error') {
        searchingKeywordOrComicLink.value = false
        clearScopedSearchProgress()
        if (isSearchCancelledError(result.error)) {
          message.info('已取消掃描')
        } else {
          message.error('搜尋失敗，請稍後再試')
        }
        console.error(result.error)
        return
      }

      store.currentTabName = 'search'

      try {
        await completeNewSearchTab(tabTitle, result.data)
      } finally {
        searchingKeywordOrComicLink.value = false
        if (isActiveSearchSession(session)) {
          clearScopedSearchProgress()
        }
      }
    }

    function searchByKeyword(keyword: string) {
      void runExclusiveSearch(() => searchByKeywordImpl(keyword))
    }

    async function searchByTagImpl(
      tagName: string,
      pageNum: number,
      useCategoryScope: boolean,
    ) {
      if (!useCategoryScope) {
        clearScopedSearchProgress()
        void commands.cancelScopedSearchScan()
      }
      if (pageNum === 1) {
        persistActiveTabBeforeNewSearch()
      }
      tagOrLinkInput.value = tagName
      activeTagSearchSource.value = 'name'
      const scope = useCategoryScope ? searchScopeCategory.value : null
      searchSource.value =
        scope !== null
          ? { type: 'tag', source: 'name', cateId: scope.cateId }
          : { type: 'tag', source: 'name' }
      if (scope !== null) {
        activeCategoryLabel.value = scope.label
        store.activeBrowseLabel = scope.label
      } else {
        activeCategoryLabel.value = ''
        store.activeBrowseLabel = ''
      }
      searchingTagOrLink.value = true

      const pendingTabTitle =
        pageNum === 1
          ? formatSearchResultTabTitle({
              searchSource:
                scope !== null
                  ? { type: 'tag', source: 'name', cateId: scope.cateId }
                  : { type: 'tag', source: 'name' },
              keywordOrComicLinkInput: keywordOrComicLinkInput.value,
              tagOrLinkInput: tagName,
              activeTagSearchSource: 'name',
              activeTagLabel: tagName.trim(),
              activeCategoryLabel: scope?.label ?? '',
              searchScopeCategory: scope,
              rankingPeriod: rankingPeriod.value,
            })
          : null

      const session = pageNum === 1 ? beginSearchSession() : searchSession.value

      const result = await commands.searchByTag(tagName, pageNum, scope?.cateId ?? null)
      if (pageNum === 1 && !isActiveSearchSession(session)) {
        searchingTagOrLink.value = false
        return
      }
      if (result.status === 'error') {
        searchingTagOrLink.value = false
        clearScopedSearchProgress()
        if (pageNum === 1) {
          if (isSearchCancelledError(result.error)) {
            message.info('已取消掃描')
          } else {
            message.error('搜尋失敗，請稍後再試')
          }
        }
        console.error(result.error)
        return
      }

      activeTagLabel.value = tagName.trim()
      store.currentTabName = 'search'

      if (pageNum === 1) {
        try {
          await completeNewSearchTab(pendingTabTitle, result.data)
        } finally {
          searchingTagOrLink.value = false
          if (isActiveSearchSession(session)) {
            clearScopedSearchProgress()
          }
        }
      } else {
        await goToViewPage(pageNum)
        searchingTagOrLink.value = false
      }
    }

    function searchByTag(tagName: string, pageNum: number) {
      void runExclusiveSearch(() => searchByTagImpl(tagName, pageNum, false))
    }

    async function searchByTagLinkImpl(rawLink: string, pageNum: number) {
      const trimmed = rawLink.trim()
      const parsed = parseTagSearchLink(trimmed)
      if (parsed === undefined) {
        message.error('標籤鏈接格式錯誤，請輸入標籤列表頁鏈接')
        return
      }

      const pageToFetch = pageNum === 1 ? parsed.page : pageNum

      if (pageNum === 1) {
        persistActiveTabBeforeNewSearch()
      }
      tagOrLinkInput.value = trimmed
      activeTagSearchSource.value = 'link'
      const scope = searchScopeCategory.value
      searchSource.value =
        scope !== null
          ? { type: 'tag', source: 'link', cateId: scope.cateId }
          : { type: 'tag', source: 'link' }
      if (scope !== null) {
        activeCategoryLabel.value = scope.label
        store.activeBrowseLabel = scope.label
      } else {
        activeCategoryLabel.value = ''
        store.activeBrowseLabel = ''
      }
      searchingTagOrLink.value = true

      const pendingTabTitle =
        pageNum === 1
          ? formatSearchResultTabTitle({
              searchSource:
                scope !== null
                  ? { type: 'tag', source: 'link', cateId: scope.cateId }
                  : { type: 'tag', source: 'link' },
              keywordOrComicLinkInput: keywordOrComicLinkInput.value,
              tagOrLinkInput: trimmed,
              activeTagSearchSource: 'link',
              activeTagLabel: parsed.tagSlug,
              activeCategoryLabel: scope?.label ?? '',
              searchScopeCategory: scope,
              rankingPeriod: rankingPeriod.value,
            })
          : null

      const session = pageNum === 1 ? beginSearchSession() : searchSession.value

      const result = await commands.searchByTag(parsed.tagSlug, pageToFetch, scope?.cateId ?? null)
      if (pageNum === 1 && !isActiveSearchSession(session)) {
        searchingTagOrLink.value = false
        return
      }
      if (result.status === 'error') {
        searchingTagOrLink.value = false
        clearScopedSearchProgress()
        if (pageNum === 1) {
          if (isSearchCancelledError(result.error)) {
            message.info('已取消掃描')
          } else {
            message.error('搜尋失敗，請稍後再試')
          }
        }
        console.error(result.error)
        return
      }

      activeTagLabel.value = parsed.tagSlug
      store.currentTabName = 'search'

      if (pageNum === 1) {
        try {
          await completeNewSearchTab(pendingTabTitle, result.data)
        } finally {
          searchingTagOrLink.value = false
          if (isActiveSearchSession(session)) {
            clearScopedSearchProgress()
          }
        }
      } else {
        await goToViewPage(pageNum)
        searchingTagOrLink.value = false
      }
    }

    async function searchByTagLink(rawLink: string, pageNum: number) {
      void runExclusiveSearch(() => searchByTagLinkImpl(rawLink, pageNum))
    }

    async function searchByCategoryImpl(cateId: number, label: string, pageNum = 1) {
      let session = searchSession.value
      let pendingTabTitle: string | null = null
      if (pageNum === 1) {
        pendingTabTitle = formatSearchResultTabTitle({
          searchSource: { type: 'category', cateId },
          keywordOrComicLinkInput: '',
          tagOrLinkInput: '',
          activeTagSearchSource: 'name',
          activeTagLabel: '',
          activeCategoryLabel: label,
          searchScopeCategory: { cateId, label },
          rankingPeriod: rankingPeriod.value,
        })
        searchingTagOrLink.value = true
        session = beginSearchSession()
      }

      const result = await commands.browseByCategory(cateId, pageNum)
      if (pageNum === 1 && !isActiveSearchSession(session)) {
        searchingTagOrLink.value = false
        return
      }
      if (result.status === 'error') {
        if (pageNum === 1) {
          searchingTagOrLink.value = false
          message.error('無法載入列表，請稍後再試')
        }
        console.error(result.error)
        return
      }

      store.currentTabName = 'search'

      if (pageNum === 1) {
        persistActiveTabBeforeNewSearch()
        searchSource.value = { type: 'category', cateId }
        searchScopeCategory.value = { cateId, label }
        activeCategoryLabel.value = label
        store.activeBrowseLabel = label
        tagOrLinkInput.value = ''
        keywordOrComicLinkInput.value = ''
        try {
          await completeNewSearchTab(pendingTabTitle, result.data)
        } finally {
          searchingTagOrLink.value = false
        }
      } else {
        await goToViewPage(pageNum)
      }
    }

    function searchByCategory(cateId: number, label: string, pageNum = 1) {
      void runExclusiveSearch(() => searchByCategoryImpl(cateId, label, pageNum))
    }

    async function browseRankingImpl(
      cateId: number | null,
      label: string,
      pageNum = 1,
      period: RankingPeriod = rankingPeriod.value,
    ) {
      let session = searchSession.value
      let pendingTabTitle: string | null = null

      if (pageNum === 1) {
        pendingTabTitle = formatSearchResultTabTitle({
          searchSource: { type: 'ranking', period, cateId },
          keywordOrComicLinkInput: '',
          tagOrLinkInput: '',
          activeTagSearchSource: 'name',
          activeTagLabel: '',
          activeCategoryLabel: label,
          searchScopeCategory: null,
          rankingPeriod: period,
        })
        searchingTagOrLink.value = true
        session = beginSearchSession()
      }

      let result: Awaited<ReturnType<typeof commands.browseRanking>>
      try {
        result = await commands.browseRanking(period, cateId, pageNum)
      } catch (error) {
        if (pageNum === 1) {
          searchingTagOrLink.value = false
          message.error(`無法載入排行榜：${formatInvokeError(error)}`)
        }
        console.error(error)
        return
      }

      if (pageNum === 1 && !isActiveSearchSession(session)) {
        searchingTagOrLink.value = false
        return
      }
      if (result.status === 'error') {
        if (pageNum === 1) {
          searchingTagOrLink.value = false
          message.error(`無法載入排行榜：${formatInvokeError(result.error)}`)
        }
        console.error(result.error)
        return
      }

      store.currentTabName = 'search'

      if (pageNum === 1) {
        persistActiveTabBeforeNewSearch()
        rankingPeriod.value = period
        searchSource.value = { type: 'ranking', period, cateId }
        searchScopeCategory.value = null
        activeCategoryLabel.value = label
        store.activeBrowseLabel = label === '排行' ? '排行' : `排行 / ${label}`
        tagOrLinkInput.value = ''
        keywordOrComicLinkInput.value = ''
        try {
          if (result.data.comics.length === 0) {
            message.warning('排行榜沒有可顯示的項目（可能為網頁結構變更或域名不支援）')
          }
          await completeNewSearchTab(pendingTabTitle, result.data)
        } finally {
          searchingTagOrLink.value = false
        }
      } else {
        await goToViewPage(pageNum)
      }
    }

    function browseRanking(cateId: number | null, label: string, pageNum = 1) {
      void runExclusiveSearch(() => browseRankingImpl(cateId, label, pageNum))
    }

    function setRankingPeriod(period: RankingPeriod) {
      if (searchSource.value.type !== 'ranking') {
        return
      }
      const { cateId } = searchSource.value
      const label =
        cateId === null
          ? '全部分類'
          : (listRankingScopes().find((s) => s.cateId === cateId)?.label ?? '全部分類')
      void runExclusiveSearch(() => browseRankingImpl(cateId, label, 1, period))
    }

    async function browseSiteListImpl(list: 'home' | 'albums', label: string, pageNum = 1) {
      let session = searchSession.value
      let pendingTabTitle: string | null = null
      if (pageNum === 1) {
        pendingTabTitle = formatSearchResultTabTitle({
          searchSource: { type: 'albums', list },
          keywordOrComicLinkInput: '',
          tagOrLinkInput: '',
          activeTagSearchSource: 'name',
          activeTagLabel: '',
          activeCategoryLabel: label,
          searchScopeCategory: null,
          rankingPeriod: rankingPeriod.value,
        })
        searchingTagOrLink.value = true
        session = beginSearchSession()
      }

      const result =
        list === 'home' ? await commands.browseHome(pageNum) : await commands.browseAlbumsList(pageNum)
      if (pageNum === 1 && !isActiveSearchSession(session)) {
        searchingTagOrLink.value = false
        return
      }
      if (result.status === 'error') {
        if (pageNum === 1) {
          searchingTagOrLink.value = false
          message.error('無法載入列表，請稍後再試')
        }
        console.error(result.error)
        return
      }

      store.currentTabName = 'search'

      if (pageNum === 1) {
        persistActiveTabBeforeNewSearch()
        searchSource.value = { type: 'albums', list }
        searchScopeCategory.value = null
        activeCategoryLabel.value = label
        store.activeBrowseLabel = label
        tagOrLinkInput.value = ''
        keywordOrComicLinkInput.value = ''
        try {
          await completeNewSearchTab(pendingTabTitle, result.data)
        } finally {
          searchingTagOrLink.value = false
        }
      } else {
        await goToViewPage(pageNum)
      }
    }

    function browseSiteList(list: 'home' | 'albums', label: string, pageNum = 1) {
      void runExclusiveSearch(() => browseSiteListImpl(list, label, pageNum))
    }

    async function submitKeywordOrComicLink() {
      const input = keywordOrComicLinkInput.value.trim()
      if (input === '') {
        return
      }

      const comicId = extractComicId(input)
      if (comicId !== undefined) {
        await pickComic(comicId)
        return
      }

      await searchByKeyword(input)
    }

    async function submitTagOrLink() {
      const input = tagOrLinkInput.value.trim()
      if (input === '') {
        return
      }

      if (parseTagSearchLink(input) !== undefined) {
        await searchByTagLink(input, 1)
      } else {
        await runExclusiveSearch(() => searchByTagImpl(input, 1, true))
      }
    }

    function onPageSizeChange(size: number) {
      if (!PAGE_SIZE_OPTIONS.includes(size as (typeof PAGE_SIZE_OPTIONS)[number])) {
        return
      }
      const firstItemIndex = (viewPage.value - 1) * pageSize.value
      pageSize.value = size
      localStorage.setItem(SEARCH_PAGE_SIZE_STORAGE_KEY, String(size))
      if (totalCountHint.value > 0) {
        const nextPage = Math.min(
          displayPageCount.value,
          Math.max(1, Math.floor(firstItemIndex / size) + 1),
        )
        void goToViewPageExclusive(nextPage)
      }
    }

    function openDownloadAllConfirm() {
      if (store.searchResult === undefined) {
        return
      }
      if (sortedComics.value.length === 0) {
        applySortToList()
      }
      downloadAllCandidates.value = sortedComics.value
      downloadAllConfirmShowing.value = true
    }

    async function executeDownloadAllSearchResults(comics: ComicInSearch[]) {
      if (store.config === undefined || comics.length === 0) {
        return
      }

      void runSerializedDownloadBatch(async () => {
        const savedViewPage = viewPage.value
        const uncompletedIds = new Set(
          Array.from(store.progresses.entries())
            .filter(
              ([, { state }]) =>
                state === 'Pending' || state === 'Downloading' || state === 'Paused',
            )
            .map(([id]) => id),
        )

        downloadingAll.value = true

        const jobOptions = {
          seriesFolder: null as string | null,
          titleById: new Map(comics.map((c) => [c.id, c.title] as const)),
          skipInQueue: true,
          skipDownloaded: true,
          isInQueue: (comicId: number) => uncompletedIds.has(comicId),
          isDownloadedById: new Map(comics.map((c) => [c.id, c.isDownloaded] as const)),
        }

        beginDownloadBatchEnqueueProgress(comics.length)

        try {
          const result = await enqueueComicIds(comics.map((c) => c.id), jobOptions, (handled, enqueued) => {
            updateDownloadBatchEnqueueProgress(handled, enqueued)
          })

          showViewPage(savedViewPage)

          if (result.cancelled) {
            dismissDownloadBatchEnqueueOverlay()
            return
          }

          if (result.failures.length > 0) {
            showBatchEnqueueFailures(result.failures, jobOptions, result.enqueued)
            return
          }

          showBatchEnqueueDone(`已加入下載佇列 ${result.enqueued} 本`)
        } catch (err) {
          console.error(err)
          showBatchEnqueueDone('加入下載佇列時發生錯誤，請關閉後重試')
        } finally {
          downloadingAll.value = false
        }
      })
    }

    function resolveKoreanModeLabel(): string {
      const source = searchSource.value
      const scope = searchScopeCategory.value
      if (source.type === 'keyword') {
        const kw = keywordOrComicLinkInput.value.trim()
        return scope !== null ? `${scope.label} · ${kw}` : kw
      }
      if (source.type === 'tag') {
        const tag =
          activeTagLabel.value ||
          getTagLabelFromSearch(tagOrLinkInput.value, activeTagSearchSource.value)
        return scope !== null && source.cateId !== undefined
          ? `${scope.label} · ${tag}`
          : tag
      }
      if (source.type === 'category' || source.type === 'albums' || source.type === 'ranking') {
        return activeCategoryLabel.value || store.activeBrowseLabel
      }
      return ''
    }

    function resolveCatalogAnalysisTagLabel(): string | undefined {
      const source = searchSource.value
      if (source.type === 'tag') {
        const tag =
          activeTagLabel.value ||
          getTagLabelFromSearch(tagOrLinkInput.value, activeTagSearchSource.value)
        return tag.trim() || undefined
      }
      return undefined
    }

    async function runCatalogAnalysis() {
      const config = store.config
      if (config === undefined) {
        return
      }
      if (!config.koreanTxtDuplicateCheckEnabled) {
        message.warning('請先在設定中開啟韓漫 TXT 重複檢查')
        return
      }
      const catalogDir = config.koreanTxtCatalogDir?.trim() ?? ''
      if (catalogDir === '') {
        message.warning('請先在設定中選擇韓漫 TXT 檔案')
        return
      }
      if (visibleComics.value.length === 0) {
        message.warning('目前頁面沒有漫畫')
        return
      }

      const tabId = activeTabId.value
      const comicsSnapshot = [...visibleComics.value]
      const tagLabelSnapshot = resolveCatalogAnalysisTagLabel()

      catalogAnalysisLoading.value = true
      catalogAnalysisProgress.value = null
      // 讓 Vue 先渲染 loading 狀態，避免 UI 卡住後才出現 spinner
      await nextTick()
      await new Promise<void>((r) => setTimeout(r, 16))
      try {
        const result = await commands.readKoreanTxtCatalog(catalogDir)
        if (result.status === 'error') {
          message.error(result.error.err_message || '讀取 TXT 目錄失敗')
          return
        }

        // 分批處理：每批 yield 一次，保持 UI 回應並更新進度
        const BATCH = 10
        const total = comicsSnapshot.length
        const analysis = new Map<number, string>()
        const validLines = result.data.filter(
          (line) => line.trim() !== '' && !line.startsWith('#') && !line.startsWith('//'),
        )
        catalogAnalysisProgress.value = { current: 0, total }
        await nextTick()

        for (let i = 0; i < total; i += BATCH) {
          const batch = comicsSnapshot.slice(i, i + BATCH)
          const partial = analyzePageCatalogDuplicates(batch, validLines, {
            tagLabel: tagLabelSnapshot,
          })
          for (const [k, v] of partial) {
            analysis.set(k, v)
          }
          catalogAnalysisProgress.value = { current: Math.min(i + BATCH, total), total }
          await new Promise<void>((r) => setTimeout(r, 0))
        }

        catalogAnalysisProgress.value = null
        const duplicateCount = [...analysis.values()].filter((msg) => msg.startsWith('與列表中')).length

        if (tabId !== null && activeTabId.value !== tabId) {
          const idx = searchTabs.value.findIndex((t) => t.id === tabId)
          if (idx >= 0) {
            const next = [...searchTabs.value]
            next[idx] = {
              ...next[idx]!,
              catalogAnalysisEntries: [...analysis.entries()],
            }
            searchTabs.value = next
            saveSearchResultTabs(searchTabs.value, activeTabId.value)
          }
          message.success(`已分析本頁 ${comicsSnapshot.length} 項（${duplicateCount} 項可能重複）`)
          return
        }

        catalogAnalysisByComicId.value = analysis
        persistActiveTab()
        message.success(`已分析本頁 ${comicsSnapshot.length} 項（${duplicateCount} 項可能重複）`)
      } finally {
        catalogAnalysisLoading.value = false
        catalogAnalysisProgress.value = null
      }
    }

    async function openKoreanDownloadModeImpl() {
      if (store.searchResult === undefined || !canUseKoreanDownloadMode.value) {
        message.warning('請先使用「關鍵詞／漫畫鏈結」或「標籤詞／標籤鏈結」搜尋後再使用韓漫下載模式')
        return
      }

      openingKoreanMode.value = true
      const session = searchSession.value

      try {
        const comics = await loadAllComicsForKoreanMode(session)
        if (comics === 'cancelled') {
          message.info('已取消載入')
          return
        }
        if (!isActiveSearchSession(session)) {
          return
        }
        if (comics === undefined || comics.length === 0) {
          message.error('無法載入搜尋列表，請稍後再試')
          return
        }

        koreanModeComics.value = comics
        activeTagLabel.value = resolveKoreanModeLabel()
        koreanModeDialogShowing.value = true
      } finally {
        openingKoreanMode.value = false
      }
    }

    function openKoreanDownloadMode() {
      if (isDownloadBatchEnqueueRunning()) {
        message.warning('正在加入下載佇列，請等待完成或按「取消」')
        return
      }
      void runExclusiveSearch(() => openKoreanDownloadModeImpl())
    }

    async function pickComic(comicIdOverride?: number) {
      const comicId = comicIdOverride ?? extractComicId(keywordOrComicLinkInput.value)
      if (comicId === undefined) {
        message.error('漫畫ID格式錯誤，請輸入漫畫ID或漫畫鏈接')
        return
      }

      const result = await commands.getComic(comicId)
      if (result.status === 'error') {
        console.error(result.error)
        return
      }

      store.pickedComic = result.data
      store.currentTabName = 'comic'
    }

    const render = () => (
      <div class="h-full flex flex-col gap-2 relative">
        <NInputGroup class="box-border px-2 pt-2">
          <FloatLabelInput
            size="small"
            label="關鍵詞/漫畫鏈結"
            value={keywordOrComicLinkInput.value}
            onUpdate:value={(value) => (keywordOrComicLinkInput.value = value)}
            clearable
            {...{
              onKeydown: async (e: KeyboardEvent) => {
                if (e.key === 'Enter') {
                  await submitKeywordOrComicLink()
                }
              },
            }}
          />
          <NButton
            loading={searchingKeywordOrComicLink.value}
            type="primary"
            size="small"
            class="w-15%"
            onClick={() => submitKeywordOrComicLink()}>
            {{
              icon: () => (
                <NIcon size={22}>
                  <PhMagnifyingGlass />
                </NIcon>
              ),
            }}
          </NButton>
        </NInputGroup>
        <NInputGroup class="box-border px-2">
          <FloatLabelInput
            size="small"
            label="標籤詞/標籤鏈結"
            value={tagOrLinkInput.value}
            onUpdate:value={(value) => (tagOrLinkInput.value = value)}
            clearable
            {...{
              onKeydown: async (e: KeyboardEvent) => {
                if (e.key === 'Enter') {
                  await submitTagOrLink()
                }
              },
            }}
          />
          <NButton
            loading={searchingTagOrLink.value}
            type="primary"
            size="small"
            class="w-15%"
            onClick={() => submitTagOrLink()}>
            {{
              icon: () => (
                <NIcon size={22}>
                  <PhMagnifyingGlass />
                </NIcon>
              ),
            }}
          </NButton>
        </NInputGroup>

        <div class="flex items-center gap-2 px-2 flex-wrap shrink-0">
          <NDropdown
            trigger="click"
            options={SEARCH_SCOPE_DROPDOWN_OPTIONS}
            onSelect={(key) => {
              if (key === 'all') {
                searchScopeCategory.value = null
                return
              }
              const found = CATEGORY_SEARCH_SCOPE_OPTIONS.find(
                (o) => String(o.cateId) === key,
              )
              if (found !== undefined) {
                searchScopeCategory.value = found
              }
            }}>
            <NButton size="small" class="max-w-56 truncate">
              搜尋範圍：{searchScopeCategory.value?.label ?? '全站'}
            </NButton>
          </NDropdown>
          {searchScopeCategory.value !== null && (
            <span class="text-xs opacity-70">
              關鍵詞／標籤搜尋將限於此分類（首次搜尋需掃描分類列表，請稍候）
            </span>
          )}
        </div>

        <div class="flex items-center shrink-0 min-h-8 border-b border-[var(--n-divider-color)]">
          <div class="flex-1 min-w-0 overflow-hidden">
            <SearchResultTabBar
              tabs={searchTabs.value}
              activeId={activeTabId.value}
              isTabBookmarked={(tabId) => store.isFavoriteSearchTab(tabId)}
              onSelect={switchSearchTab}
              onClose={closeSearchTab}
              onToggleBookmark={toggleSearchTabBookmark}
            />
          </div>
          {hasActiveSearchResults.value && (
            <div class="flex items-center gap-1 px-2 shrink-0">
              <NButton
                size="small"
                type="primary"
                loading={downloadingAll.value}
                disabled={isSearchBusy.value}
                onClick={openDownloadAllConfirm}>
                全部下載(本頁)
              </NButton>
              <NButton
                size="small"
                type={isKoreanModeLoading.value ? 'warning' : 'default'}
                loading={openingKoreanMode.value && !isKoreanModeLoading.value}
                disabled={
                  isKoreanModeLoading.value
                    ? false
                    : !canUseKoreanDownloadMode.value || isSearchBusy.value
                }
                onClick={() => {
                  if (isKoreanModeLoading.value) {
                    cancelKoreanModeLoad()
                    return
                  }
                  openKoreanDownloadMode()
                }}>
                {koreanModeButtonLabel.value}
              </NButton>
              <NDropdown
                trigger="click"
                placement="bottom-end"
                disabled={isInitialSearchBusy.value}
                options={SEARCH_LAYOUT_OPTIONS.map((o) => ({
                  key: o.key,
                  label: o.label,
                }))}
                onSelect={(key) => setSearchResultLayout(key as SearchResultLayout)}>
                <NButton
                  size="small"
                  disabled={isInitialSearchBusy.value}
                  title={layoutOptionLabel(searchResultLayout.value)}>
                  {{
                    icon: () => (
                      <NIcon size={18}>
                        {isGridSearchLayout(searchResultLayout.value) ? (
                          <GridColsIcon cols={gridColsNumber(searchResultLayout.value)} />
                        ) : (
                          <PhListBullets />
                        )}
                      </NIcon>
                    ),
                  }}
                </NButton>
              </NDropdown>
            </div>
          )}
        </div>

        {searchSource.value.type === 'ranking' && (
          <div class="flex items-center gap-1 px-2 flex-wrap">
            {RANKING_PERIOD_OPTIONS.map((opt) => (
              <NButton
                key={opt.key}
                size="small"
                type={rankingPeriod.value === opt.key ? 'primary' : 'default'}
                disabled={isSearchBusy.value}
                onClick={() => setRankingPeriod(opt.key)}>
                {opt.label}
              </NButton>
            ))}
          </div>
        )}

        {hasActiveSearchResults.value && (
          <>
            <div
              ref={comicListScrollArea}
              class="relative flex flex-col overflow-auto flex-1 min-h-0"
              onScroll={onComicListScroll}>
              {(isInitialSearchBusy.value || isViewPageLoading.value) &&
                !isScopedScanOverlay.value && (
                <div class="absolute inset-0 z-10 flex items-center justify-center pointer-events-none bg-black/45">
                  <div class="flex flex-col items-center gap-3 px-8 py-6 rounded-xl bg-[#2a2a2a] border border-[rgba(255,255,255,0.14)] shadow-xl">
                    <NSpin show size="large" />
                    <span class="text-sm text-gray-100 text-center leading-relaxed">
                      {loadingDescription.value}
                    </span>
                  </div>
                </div>
              )}
              <div
                data-comic-list
                class={
                  isGridSearchLayout(searchResultLayout.value)
                    ? `grid ${gridColsClass(searchResultLayout.value)} gap-2 p-2 items-stretch`
                    : 'flex flex-col gap-row-2 p-2'
                }>
                {visibleComics.value.map((comic, index) => (
                  <ComicCard
                    key={comic.id}
                    layout={comicCardLayout(searchResultLayout.value)}
                    comicId={comic.id}
                    comicTitle={comic.title}
                    comicTitleHtml={comic.titleHtml}
                    comicCover={comic.cover}
                    comicAdditionalInfo={comic.additionalInfo}
                    comicDownloaded={comic.isDownloaded}
                    idleDownloadLabel="下載"
                    showDetailButton={true}
                    showReadButton={true}
                    showTags={false}
                    showFavoriteButton={true}
                    favorited={store.isFavoriteComic(comic.id)}
                    onToggleFavorite={() => store.toggleFavoriteComic(comic)}
                    searchByTag={searchByTag}
                    enableCoverLoad={index < coverLoadLimit.value}
                    catalogAnalysisNote={catalogAnalysisByComicId.value.get(comic.id)}
                  />
                ))}
              </div>
            </div>
            <div class="flex items-center gap-2 p-2 mt-auto box-border flex-wrap w-full">
              <div class="flex items-center gap-1 shrink-0">
                <NPagination
                  page={viewPage.value}
                  pageCount={displayPageCount.value}
                  pageSlot={9}
                  disabled={isInitialSearchBusy.value}
                  onUpdate:page={(page) => goToViewPageExclusive(page)}
                />
              </div>
              <div class="flex-1 min-w-2" />
              <NButton
                size="small"
                type="info"
                class="shrink-0"
                loading={catalogAnalysisLoading.value}
                disabled={isSearchBusy.value || visibleComics.value.length === 0}
                onClick={() => void runCatalogAnalysis()}>
                {catalogAnalysisProgress.value
                  ? `分析中 ${catalogAnalysisProgress.value.current}／${catalogAnalysisProgress.value.total}`
                  : '目錄分析'}
              </NButton>
              <NDropdown
                trigger="click"
                options={SEARCH_SORT_OPTIONS.map((o) => ({ label: o.label, key: o.key }))}
                onSelect={(key) => onSortChange(key as SearchSortOrder)}>
                <NButton size="small" class="whitespace-nowrap" disabled={isSearchBusy.value}>
                  {sortButtonLabel.value}
                </NButton>
              </NDropdown>
              <NDropdown
                trigger="click"
                options={PAGE_SIZE_OPTIONS.map((n) => ({ label: String(n), key: n }))}
                onSelect={(key) => onPageSizeChange(key as number)}>
                <NButton size="small" class="whitespace-nowrap" disabled={isSearchBusy.value}>
                  {pageSizeButtonLabel.value}
                </NButton>
              </NDropdown>
            </div>
          </>
        )}

        <DownloadAllConfirmDialog
          showing={downloadAllConfirmShowing.value}
          comics={downloadAllCandidates.value}
          onUpdate:showing={(v) => (downloadAllConfirmShowing.value = v)}
          onConfirm={(comics) => {
            void executeDownloadAllSearchResults(comics)
          }}
        />

        <KoreanDownloadModeDialog
          showing={koreanModeDialogShowing.value}
          comics={koreanModeComics.value}
          tagLabel={activeTagLabel.value}
          onUpdate:showing={(v) => (koreanModeDialogShowing.value = v)}
        />

        {isScopedScanOverlay.value && (
          <Teleport to="body">
            <div class="fixed inset-0 z-[9998] flex items-center justify-center bg-black/55">
              <div class="flex flex-col items-center gap-4 px-8 py-6 rounded-xl bg-[#2a2a2a] border border-[rgba(255,255,255,0.14)] shadow-xl min-w-80 max-w-[92vw]">
                <NSpin show={!scopedSearchProgress.value?.paused} size="large" />
                <span class="text-sm text-gray-100 text-center leading-relaxed">
                  {loadingDescription.value}
                </span>
                <NButton type="warning" onClick={() => cancelScopedSearch()}>
                  取消掃描
                </NButton>
              </div>
            </div>
          </Teleport>
        )}

        {koreanModeLoadProgress.value !== null && (
          <Teleport to="body">
            <div class="fixed inset-0 z-[9999] flex items-center justify-center bg-black/55">
              <div class="flex flex-col items-center gap-4 px-8 py-6 rounded-xl bg-[#2a2a2a] border border-[rgba(255,255,255,0.14)] shadow-xl min-w-80 max-w-[92vw]">
              <NSpin show size="large" />
              <span class="text-sm text-gray-100 text-center leading-relaxed">
                正在載入搜尋全部列表（官網第 {koreanModeLoadProgress.value.current}/
                {koreanModeLoadProgress.value.total} 頁）
              </span>
              <NButton type="warning" onClick={() => cancelKoreanModeLoad()}>
                取消載入
              </NButton>
            </div>
          </div>
          </Teleport>
        )}
      </div>
    )

    return {
      render,
      searchByTag,
      searchByCategory,
      browseSiteList,
      browseRanking,
      activeCategoryLabel,
      openBookmarkedSearchTab,
    }
  },

  render() {
    return this.render()
  },
})
