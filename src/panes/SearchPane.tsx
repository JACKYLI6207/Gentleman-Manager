import { computed, defineComponent, nextTick, onMounted, onUnmounted, ref, Teleport, watch } from 'vue'
import {
  NButton,
  NPagination,
  useMessage,
  NInputGroup,
  NIcon,
  NDropdown,
  NSpin,
  NModal,
  NDialog,
  NEmpty,
  NRadioGroup,
  NRadio,
  NCheckbox,
  NInputNumber,
} from 'naive-ui'
import { useStore } from '../store.ts'
import { commands, events, Comic, ComicInSearch, SearchResult } from '../bindings.ts'
import ComicCard from '../components/ComicCard.tsx'
import GridColsIcon from '../components/GridColsIcon.tsx'
import { PhListBullets, PhMagnifyingGlass, PhTrash } from '@phosphor-icons/vue'
import FloatLabelInput from '../components/FloatLabelInput.tsx'
import {
  extractComicId,
  loadSavedSearchSortOrder,
  parseTagSearchLink,
  SEARCH_SORT_OPTIONS,
  saveSearchSortOrder,
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
import { loadSearchResultTabs, saveSearchResultTabs } from '../searchResultTabsStorage.ts'
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
  sanitizeTabStateForBookmark,
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
import { open, save } from '@tauri-apps/plugin-dialog'
import { chineseSearchVariants } from '../chineseText.ts'

/** 官網列表每頁 20 本；UI 分頁依「每頁顯示」按需抓取官網頁 */
const SERVER_PAGE_SIZE = 20
/** 快照存檔 ID 順序：與官網列表一致（頂部較新／大 ID，底部較舊／小 ID） */
const SNAPSHOT_ARCHIVE_ID_SORT: SearchSortOrder = 'comicIdDesc'
const COVER_LOAD_BATCH = 20
/** 連續請求間隔，降低官網限流（韓漫模式載入全部頁時使用） */
const PAGE_FETCH_DELAY_MS = 300
const PAGE_SIZE_OPTIONS = [20, 40, 60, 80, 100] as const
const GLOBAL_SNAPSHOT_KEYWORD_PROGRESS_CHUNK_SIZE = 1000
const SEARCH_PAGE_SIZE_STORAGE_KEY = 'searchDisplayPageSize'
const SCOPED_SCAN_CACHE_STORAGE_KEY = 'wnacg.scopedScanCaches.v1'
const SCOPED_SEARCH_PATH_CHOICE_STORAGE_KEY = 'wnacg.scopedSearchPathChoice.v1'
const SCOPED_SEARCH_SCAN_MODE_STORAGE_KEY = 'wnacg.scopedSearchScanMode.v1'
const GLOBAL_SNAPSHOT_META_STORAGE_KEY = 'wnacg.globalSnapshots.v1'
const GLOBAL_SNAPSHOT_ID_UPDATE_DUPLICATE_LIMIT_STORAGE_KEY = 'wnacg.globalSnapshotIdUpdateDuplicateLimit.v1'
const DEFAULT_GLOBAL_SNAPSHOT_ID_UPDATE_DUPLICATE_LIMIT = 20
const ACTIVE_GLOBAL_SNAPSHOT_STORAGE_KEY = 'wnacg.activeGlobalSnapshotId.v1'
const GLOBAL_SNAPSHOT_DB_NAME = 'wnacg.globalSnapshots.db'
const GLOBAL_SNAPSHOT_STORE_NAME = 'snapshots'
const CATEGORY_SEARCH_SCOPE_OPTIONS = listCategorySearchScopes()
const CATEGORY_LABEL_BY_CATE_ID = new Map(CATEGORY_SEARCH_SCOPE_OPTIONS.map((option) => [option.cateId, option.label]))
const SNAPSHOT_SCAN_TARGET_OPTIONS: SnapshotScanTarget[] = [
  { key: 'albums', kind: 'albums', label: '更新' },
  ...CATEGORY_SEARCH_SCOPE_OPTIONS.map((option) => ({
    key: `category:${option.cateId}`,
    kind: 'category' as const,
    label: option.label,
    cateId: option.cateId,
  })),
]

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

function normalizeGlobalSnapshotIdUpdateDuplicateLimit(value: number | null | undefined): number {
  const n = Math.floor(Number(value ?? DEFAULT_GLOBAL_SNAPSHOT_ID_UPDATE_DUPLICATE_LIMIT))
  if (!Number.isFinite(n) || n < 0) {
    return DEFAULT_GLOBAL_SNAPSHOT_ID_UPDATE_DUPLICATE_LIMIT
  }
  return n
}

function loadGlobalSnapshotIdUpdateDuplicateLimit(): number {
  const saved = localStorage.getItem(GLOBAL_SNAPSHOT_ID_UPDATE_DUPLICATE_LIMIT_STORAGE_KEY)
  if (saved === null) {
    return DEFAULT_GLOBAL_SNAPSHOT_ID_UPDATE_DUPLICATE_LIMIT
  }
  return normalizeGlobalSnapshotIdUpdateDuplicateLimit(Number(saved))
}

function saveGlobalSnapshotIdUpdateDuplicateLimit(value: number) {
  localStorage.setItem(
    GLOBAL_SNAPSHOT_ID_UPDATE_DUPLICATE_LIMIT_STORAGE_KEY,
    String(normalizeGlobalSnapshotIdUpdateDuplicateLimit(value)),
  )
}

const SEARCH_LAYOUT_OPTIONS: { key: SearchResultLayout; label: string }[] = [
  { key: 'grid4', label: '每排 4 個' },
  { key: 'grid6', label: '每排 6 個' },
  { key: 'grid8', label: '每排 8 個' },
  { key: 'grid10', label: '每排 10 個' },
  { key: 'list', label: '列表顯示' },
]

type SearchInputMode = 'keywordOrComicLink' | 'tagOrLink'
type ScopedSearchPathChoice = 'scoped' | 'useGlobal' | 'scanGlobal'
type ScopedSearchScanMode = 'conservative' | 'aggressive'
type GlobalSnapshotScanConfirmMode = 'scan' | 'resume' | 'update'
type GlobalSnapshotResumeStrategy = 'page' | 'idUpdate'
type SnapshotScanTarget =
  | { key: 'albums'; kind: 'albums'; label: string }
  | { key: string; kind: 'category'; label: string; cateId: number }

type SnapshotCompletedPageRange = {
  start: number
  end: number
}

type ScopedSearchEstimateRequest = {
  kind: 'keyword' | 'tag'
  query: string
}

type ScopedSearchPageEstimate =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; totalPages: number; totalCount: number }
  | { status: 'error' }

interface ScopedSearchCompleteSummary {
  elapsedText: string
  matchedCount: number
  scannedPages: number
  totalPages: number
}

interface GlobalSnapshotMeta {
  id: string
  savedAt: string
  totalCount: number
  totalPages: number
  scanCompletionPercent: number
  scanDirection?: 'tailToHead'
  scanCompletedPages?: number
  scanCompletedPageRanges?: SnapshotCompletedPageRange[]
  scanTargetKind?: 'albums' | 'category'
  scanTargetCateId?: number
  scanTargetLabel?: string
}

interface GlobalSnapshotRecord {
  id: string
  comics: ComicInSearch[]
}

type SnapshotSearchChoiceResult =
  | { action: 'scoped' }
  | { action: 'loadScoped'; cache: ScopedScanCache }
  | { action: 'useGlobal'; snapshot: GlobalSnapshotMeta }
  | { action: 'scanGlobal' }
  | { action: 'cancel' }

interface ScopedScanCache {
  id: string
  savedAt: string
  categoryLabel: string
  kindLabel: '關鍵詞' | '標籤詞'
  queryLabel: string
  totalCount: number
  scanCompletionPercent?: number
  scanDirection?: 'tailToHead'
  scanCompletedPages?: number
  tabState: SearchResultTabState
}

type SnapshotExportFile =
  | {
      format: 'gentleman-manager.snapshot.v1'
      exportedAt: string
      snapshot: { kind: 'global'; meta: GlobalSnapshotMeta; comics: ComicInSearch[] }
    }
  | {
      format: 'gentleman-manager.snapshot.v1'
      exportedAt: string
      snapshot: { kind: 'scoped'; cache: ScopedScanCache }
    }

type GlobalSnapshotExportFile = Extract<SnapshotExportFile, { snapshot: { kind: 'global' } }>

type SnapshotRepairLoadedFile = {
  path: string
  name: string
  file: GlobalSnapshotExportFile
}

type SnapshotRepairProgress = {
  phase: string
  current: number
  total: number
  detail: string
}

type SnapshotRepairSearchResult = {
  id: number
  found: boolean
  title?: string
}

type SnapshotRepairGapRange = {
  start: number
  end: number
  count: number
}

type SnapshotRepairGapAnalysis = {
  sourceName: string
  maxId: number
  totalMissing: number
  unnaturalMissingTotal: number
  remainingIdCount: number
  remainingMissingCount: number
  threshold: number
  ranges: SnapshotRepairGapRange[]
}

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
    const searchInputMode = ref<SearchInputMode>('keywordOrComicLink')
    const activeTagSearchSource = ref<'name' | 'link'>('name')
    const viewPage = ref<number>(1)
    const pageSize = ref<number>(20)
    const allSearchComics = ref<ComicInSearch[]>([])
    const sortedComics = ref<ComicInSearch[]>([])
    const sortOrder = ref<SearchSortOrder>(loadSavedSearchSortOrder())
    const visibleComics = ref<ComicInSearch[]>([])
    let pageCache = new Map<number, SearchResult>()
    const scopedOfflineMatches = ref<ComicInSearch[]>([])
    const searchTabs = ref<SearchResultTabState[]>([])
    const activeTabId = ref<string | null>(null)
    const downloadingAll = ref<boolean>(false)
    const openingKoreanMode = ref<boolean>(false)
    const koreanModeDialogShowing = ref<boolean>(false)
    const downloadAllConfirmShowing = ref<boolean>(false)
    const scopedSearchConfirmShowing = ref<boolean>(false)
    const scopedSearchScanMode = ref<ScopedSearchScanMode>('conservative')
    const scopedCacheChoiceShowing = ref<boolean>(false)
    const scopedCacheChoiceCaches = ref<ScopedScanCache[]>([])
    const scopedCacheChoiceRequest = ref<ScopedSearchEstimateRequest | null>(null)
    const scopedCacheChoiceGlobalSnapshot = ref<GlobalSnapshotMeta | null>(null)
    const scopedSearchPathChoice = ref<ScopedSearchPathChoice>('scoped')
    const scopedSearchPageEstimate = ref<ScopedSearchPageEstimate>({ status: 'idle' })
    const globalSnapshotPageEstimate = ref<ScopedSearchPageEstimate>({ status: 'idle' })
    const scopedSearchCompleteSummary = ref<ScopedSearchCompleteSummary | null>(null)
    const globalSnapshotMetas = ref<GlobalSnapshotMeta[]>([])
    const activeGlobalSnapshotMeta = ref<GlobalSnapshotMeta | null>(null)
    const activeGlobalSnapshotComics = ref<ComicInSearch[]>([])
    const snapshotDeleteTarget = ref<
      { kind: 'global'; snapshot: GlobalSnapshotMeta } | { kind: 'scoped'; cache: ScopedScanCache } | null
    >(null)
    const globalSnapshotConfirmShowing = ref<boolean>(false)
    const globalSnapshotScanMode = ref<'conservative' | 'aggressive'>('conservative')
    const globalSnapshotScanTargetKeys = ref<string[]>(['albums'])
    const globalSnapshotConfirmMode = ref<GlobalSnapshotScanConfirmMode>('scan')
    const globalSnapshotScanningLabel = ref<string>('快照')
    const globalSnapshotScanProgress = ref<{
      current: number
      total: number
      matchedCount: number
      successPages: number
      failedAttempts: number
      queuedRetryPages: number
      retrySuccessPages: number
      selfCheckHint?: string | null
    } | null>(null)
    const globalSnapshotManualRequest = ref<{ startPage: number; endPage: number } | null>(null)
    const globalSnapshotPauseReason = ref<string | null>(null)
    const globalSnapshotResumeShowing = ref<boolean>(false)
    const globalSnapshotResumeSelectedIds = ref<string[]>([])
    const globalSnapshotResumeStrategy = ref<GlobalSnapshotResumeStrategy>('page')
    const globalSnapshotIdUpdateDuplicateLimit = ref(loadGlobalSnapshotIdUpdateDuplicateLimit())
    const globalSnapshotStartedAt = ref<number | null>(null)
    const globalSnapshotElapsedTick = ref(Date.now())
    const snapshotRepairShowing = ref<boolean>(false)
    const snapshotRepairSortChecked = ref<boolean>(false)
    const snapshotRepairMissingChecked = ref<boolean>(false)
    const snapshotRepairSortFile = ref<SnapshotRepairLoadedFile | null>(null)
    const snapshotRepairMissingFile = ref<SnapshotRepairLoadedFile | null>(null)
    const snapshotRepairGapLimit = ref<number>(5)
    const snapshotRepairSearchMode = ref<'conservative' | 'aggressive'>('conservative')
    const snapshotRepairProgress = ref<SnapshotRepairProgress | null>(null)
    const snapshotRepairRunning = ref<boolean>(false)
    const snapshotRepairSortDone = ref<{ path: string; file: GlobalSnapshotExportFile; missingCount: number } | null>(null)
    const snapshotRepairSearchResults = ref<SnapshotRepairSearchResult[]>([])
    const snapshotRepairFoundComics = ref<ComicInSearch[]>([])
    const snapshotRepairFoundSnapshotPath = ref<string | null>(null)
    const snapshotRepairLogPath = ref<string | null>(null)
    const snapshotRepairResultShowing = ref<boolean>(false)
    const snapshotRepairStartedAt = ref<number | null>(null)
    const snapshotRepairElapsedTick = ref(Date.now())
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
    const scopedScanCaches = ref<ScopedScanCache[]>([])
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
      pausedReason: string | null
    } | null>(null)
    const globalSnapshotKeywordSearchProgress = ref<{
      current: number
      total: number
      matchedCount: number
      detail: string
    } | null>(null)
    const scopedSearchStartedAt = ref<number | null>(null)
    const scopedSearchElapsedTick = ref(Date.now())
    const lastScopedSearchProgress = ref<{ current: number; total: number; matchedCount: number } | null>(null)
    let scopedSearchElapsedTimer: ReturnType<typeof window.setInterval> | undefined
    let unlistenSearchScanProgress: (() => void) | undefined
    const lastCommittedViewPage = ref<number>(1)
    const totalServerPagesHint = ref<number>(1)
    const totalCountHint = ref<number>(0)
    /** 總筆數已依實際尾端下修；後續官網頁 HTML 的 <b> 不再放大 totalCountHint */
    const totalCountRefined = ref(false)
    /** 每次新搜尋遞增；用於忽略過期的並發載入 */
    const searchSession = ref<number>(0)
    let searchQueue: Promise<void> = Promise.resolve()
    let scopedSearchConfirmResolve: ((confirmed: boolean) => void) | undefined
    let scopedCacheChoiceResolve: ((result: SnapshotSearchChoiceResult) => void) | undefined
    let scopedSearchEstimateToken = 0
    let globalSnapshotPageEstimateToken = 0
    let globalSnapshotCancelled = false
    let snapshotRepairCancelled = false
    let snapshotRepairElapsedTimer: ReturnType<typeof window.setInterval> | undefined
    let globalSnapshotElapsedTimer: ReturnType<typeof window.setInterval> | undefined
    let globalSnapshotConfirmResolve: ((confirmed: boolean) => void) | undefined
    let globalSnapshotManualRequestResolve: (() => void) | undefined
    const coverLoadLimit = ref<number>(COVER_LOAD_BATCH)
    const searchResultLayout = ref<SearchResultLayout>('list')

    function loadSavedScopedSearchChoices() {
      const savedPathChoice = localStorage.getItem(SCOPED_SEARCH_PATH_CHOICE_STORAGE_KEY)
      if (savedPathChoice === 'scoped' || savedPathChoice === 'useGlobal' || savedPathChoice === 'scanGlobal') {
        scopedSearchPathChoice.value = savedPathChoice
      }
      const savedScanMode = localStorage.getItem(SCOPED_SEARCH_SCAN_MODE_STORAGE_KEY)
      if (savedScanMode === 'conservative' || savedScanMode === 'aggressive') {
        scopedSearchScanMode.value = savedScanMode
      }
    }

    function saveScopedSearchPathChoice(value: ScopedSearchPathChoice) {
      localStorage.setItem(SCOPED_SEARCH_PATH_CHOICE_STORAGE_KEY, value)
    }

    function setScopedSearchScanMode(value: ScopedSearchScanMode) {
      scopedSearchScanMode.value = value
      localStorage.setItem(SCOPED_SEARCH_SCAN_MODE_STORAGE_KEY, value)
    }

    loadSavedScopedSearchChoices()

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

    function isScopedScanCache(value: unknown): value is ScopedScanCache {
      if (typeof value !== 'object' || value === null) {
        return false
      }
      const item = value as ScopedScanCache
      return (
        typeof item.id === 'string' &&
        typeof item.savedAt === 'string' &&
        typeof item.categoryLabel === 'string' &&
        (item.kindLabel === '關鍵詞' || item.kindLabel === '標籤詞') &&
        typeof item.queryLabel === 'string' &&
        typeof item.totalCount === 'number' &&
        (item.scanCompletionPercent === undefined || typeof item.scanCompletionPercent === 'number') &&
        typeof item.tabState === 'object' &&
        item.tabState !== null
      )
    }

    function loadScopedScanCaches() {
      try {
        const raw = localStorage.getItem(SCOPED_SCAN_CACHE_STORAGE_KEY)
        if (raw === null || raw === '') {
          scopedScanCaches.value = []
          return
        }
        const parsed: unknown = JSON.parse(raw)
        scopedScanCaches.value = Array.isArray(parsed) ? parsed.filter(isScopedScanCache) : []
      } catch {
        scopedScanCaches.value = []
      }
    }

    function saveScopedScanCaches() {
      localStorage.setItem(SCOPED_SCAN_CACHE_STORAGE_KEY, JSON.stringify(scopedScanCaches.value))
    }

    loadScopedScanCaches()

    function isGlobalSnapshotMeta(value: unknown): value is GlobalSnapshotMeta {
      if (typeof value !== 'object' || value === null) {
        return false
      }
      const item = value as GlobalSnapshotMeta
      return (
        typeof item.id === 'string' &&
        typeof item.savedAt === 'string' &&
        typeof item.totalCount === 'number' &&
        typeof item.totalPages === 'number' &&
        typeof item.scanCompletionPercent === 'number'
      )
    }

    function isComicInSearchArray(value: unknown): value is ComicInSearch[] {
      return (
        Array.isArray(value) &&
        value.every((item) => {
          const comic = item as ComicInSearch
          return (
            typeof item === 'object' &&
            item !== null &&
            typeof comic.id === 'number' &&
            typeof comic.title === 'string' &&
            typeof comic.titleHtml === 'string' &&
            typeof comic.cover === 'string'
          )
        })
      )
    }

    function isSnapshotExportFile(value: unknown): value is SnapshotExportFile {
      if (typeof value !== 'object' || value === null) {
        return false
      }
      const file = value as SnapshotExportFile
      if (file.format !== 'gentleman-manager.snapshot.v1' || typeof file.exportedAt !== 'string') {
        return false
      }
      if (typeof file.snapshot !== 'object' || file.snapshot === null) {
        return false
      }
      if (file.snapshot.kind === 'global') {
        return isGlobalSnapshotMeta(file.snapshot.meta) && isComicInSearchArray(file.snapshot.comics)
      }
      if (file.snapshot.kind === 'scoped') {
        return isScopedScanCache(file.snapshot.cache)
      }
      return false
    }

    function isGlobalSnapshotExportFile(value: unknown): value is GlobalSnapshotExportFile {
      return isSnapshotExportFile(value) && value.snapshot.kind === 'global'
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

    function normalizeDialogPaths(value: string | string[] | null): string[] {
      if (value === null) {
        return []
      }
      if (Array.isArray(value)) {
        return value.filter((path) => path.length > 0)
      }
      return value.length > 0 ? [value] : []
    }

    function safeSnapshotExportFilename(label: string) {
      const safeLabel = label.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim()
      return `${safeLabel || 'snapshot'}.gm-snapshot.json`
    }

    function ensureSnapshotExportExtension(path: string) {
      return path.toLocaleLowerCase().endsWith('.json') ? path : `${path}.gm-snapshot.json`
    }

    function snapshotRepairTimestamp() {
      const d = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      return `${d.getFullYear()}_${pad(d.getMonth() + 1)}_${pad(d.getDate())}_${pad(d.getHours())}_${pad(d.getMinutes())}_${pad(d.getSeconds())}`
    }

    function snapshotRepairFileName(label: string, extension = '.gm-snapshot.json') {
      return safeSnapshotExportFilename(`${label} ${snapshotRepairTimestamp()}`).replace(/\.gm-snapshot\.json$/i, extension)
    }

    function getMaxComicId(comics: ComicInSearch[]) {
      let max = 0
      for (const comic of comics) {
        if (comic.id > max) {
          max = comic.id
        }
      }
      return max
    }

    function sortComicsForSnapshotArchive(comics: ComicInSearch[]): ComicInSearch[] {
      return sortSearchComics(comics, SNAPSHOT_ARCHIVE_ID_SORT)
    }

    function sortedUniqueComicsById(comics: ComicInSearch[]) {
      const byId = new Map<number, ComicInSearch>()
      for (const comic of comics) {
        if (!byId.has(comic.id)) {
          byId.set(comic.id, comic)
        }
      }
      return sortComicsForSnapshotArchive([...byId.values()])
    }

    function makeGlobalSnapshotExportFile(
      source: GlobalSnapshotExportFile,
      comics: ComicInSearch[],
      metaPatch: Partial<GlobalSnapshotMeta> = {},
    ): GlobalSnapshotExportFile {
      const meta: GlobalSnapshotMeta = {
        ...source.snapshot.meta,
        ...metaPatch,
        id: metaPatch.id ?? crypto.randomUUID(),
        savedAt: metaPatch.savedAt ?? new Date().toISOString(),
        totalCount: comics.length,
      }
      return {
        format: 'gentleman-manager.snapshot.v1',
        exportedAt: new Date().toISOString(),
        snapshot: { kind: 'global', meta, comics },
      }
    }

    function comicDetailToSnapshotComic(comic: Comic): ComicInSearch {
      return {
        id: comic.id,
        titleHtml: comic.title,
        title: comic.title,
        cover: comic.cover,
        additionalInfo: `${comic.imageCount}張照片`,
        isDownloaded: Boolean(comic.isDownloaded),
        listCateId: null,
      }
    }

    function loadGlobalSnapshotMetas() {
      try {
        const raw = localStorage.getItem(GLOBAL_SNAPSHOT_META_STORAGE_KEY)
        if (raw === null || raw === '') {
          globalSnapshotMetas.value = []
          return
        }
        const parsed: unknown = JSON.parse(raw)
        globalSnapshotMetas.value = Array.isArray(parsed) ? parsed.filter(isGlobalSnapshotMeta) : []
        activeGlobalSnapshotMeta.value = null
        activeGlobalSnapshotComics.value = []
        localStorage.removeItem(ACTIVE_GLOBAL_SNAPSHOT_STORAGE_KEY)
      } catch {
        globalSnapshotMetas.value = []
        activeGlobalSnapshotMeta.value = null
      }
    }

    function saveGlobalSnapshotMetas() {
      localStorage.setItem(GLOBAL_SNAPSHOT_META_STORAGE_KEY, JSON.stringify(globalSnapshotMetas.value))
    }

    loadGlobalSnapshotMetas()

    function openGlobalSnapshotDb(): Promise<IDBDatabase> {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(GLOBAL_SNAPSHOT_DB_NAME, 1)
        request.onupgradeneeded = () => {
          const db = request.result
          if (!db.objectStoreNames.contains(GLOBAL_SNAPSHOT_STORE_NAME)) {
            db.createObjectStore(GLOBAL_SNAPSHOT_STORE_NAME, { keyPath: 'id' })
          }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    }

    async function putGlobalSnapshotRecord(record: GlobalSnapshotRecord) {
      const db = await openGlobalSnapshotDb()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(GLOBAL_SNAPSHOT_STORE_NAME, 'readwrite')
        tx.objectStore(GLOBAL_SNAPSHOT_STORE_NAME).put(record)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
      db.close()
    }

    async function getGlobalSnapshotRecord(id: string): Promise<GlobalSnapshotRecord | undefined> {
      const db = await openGlobalSnapshotDb()
      const record = await new Promise<GlobalSnapshotRecord | undefined>((resolve, reject) => {
        const tx = db.transaction(GLOBAL_SNAPSHOT_STORE_NAME, 'readonly')
        const request = tx.objectStore(GLOBAL_SNAPSHOT_STORE_NAME).get(id)
        request.onsuccess = () => resolve(request.result as GlobalSnapshotRecord | undefined)
        request.onerror = () => reject(request.error)
      })
      db.close()
      return record
    }

    async function deleteGlobalSnapshotRecord(id: string) {
      const db = await openGlobalSnapshotDb()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(GLOBAL_SNAPSHOT_STORE_NAME, 'readwrite')
        tx.objectStore(GLOBAL_SNAPSHOT_STORE_NAME).delete(id)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
      db.close()
    }

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

    function isGlobalSnapshotSearchState(source: SearchSource, label: string) {
      return source.type === 'albums' && source.list === 'albums' && label.includes('快照')
    }

    function findGlobalSnapshotMetaForTab(tab: Pick<SearchResultTabState, 'activeCategoryLabel' | 'title' | 'globalSnapshotMetaId'>) {
      if (tab.globalSnapshotMetaId !== undefined) {
        const byId = globalSnapshotMetas.value.find((meta) => meta.id === tab.globalSnapshotMetaId)
        if (byId !== undefined) {
          return byId
        }
      }
      return globalSnapshotMetas.value.find(
        (meta) => tab.activeCategoryLabel === globalSnapshotLabel(meta) || tab.title === globalSnapshotLabel(meta),
      )
    }

    function activeGlobalSnapshotMetaId() {
      const tab = searchTabs.value.find((t) => t.id === activeTabId.value)
      return (
        tab?.globalSnapshotMetaId ??
        findGlobalSnapshotMetaForTab({
          activeCategoryLabel: activeCategoryLabel.value,
          title: tab?.title ?? activeCategoryLabel.value,
          globalSnapshotMetaId: undefined,
        })?.id
      )
    }

    function captureTabState(): SearchResultTabState {
      const existing = searchTabs.value.find((t) => t.id === activeTabId.value)
      const isGlobalSnapshotSearch = isGlobalSnapshotSearchState(searchSource.value, activeCategoryLabel.value)
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
          !isGlobalSnapshotSearch && scopedOfflineMatches.value.length > 0 ? [...scopedOfflineMatches.value] : undefined,
        globalSnapshotMetaId: isGlobalSnapshotSearch ? activeGlobalSnapshotMetaId() : undefined,
      }
    }

    function restoreTabState(tab: SearchResultTabState, options?: { preserveSearchScope?: boolean }) {
      const savedSortOrder = loadSavedSearchSortOrder()
      const preservedScope = searchScopeCategory.value
      keywordOrComicLinkInput.value = tab.keywordOrComicLinkInput
      tagOrLinkInput.value = tab.tagOrLinkInput
      activeTagSearchSource.value = tab.activeTagSearchSource
      searchSource.value = tab.searchSource
      searchInputMode.value = tab.searchSource.type === 'tag' ? 'tagOrLink' : 'keywordOrComicLink'
      searchScopeCategory.value = options?.preserveSearchScope === true ? preservedScope : tab.searchScopeCategory
      activeTagLabel.value = tab.activeTagLabel
      activeCategoryLabel.value = tab.activeCategoryLabel
      rankingPeriod.value = tab.rankingPeriod
      viewPage.value = tab.viewPage
      allSearchComics.value = tab.allSearchComics
      sortedComics.value = tab.sortedComics
      visibleComics.value = tab.visibleComics
      pageCache = new Map(tab.pageCacheEntries)
      sortOrder.value = savedSortOrder
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
      if (tab.allSearchComics.length > 0 && savedSortOrder !== tab.sortOrder) {
        applySortToList()
        showViewPage(tab.viewPage)
      }
      void nextTick(() => {
        const el = comicListScrollArea.value
        if (el !== undefined) {
          el.scrollTop = tab.listScrollTop
        }
      })
    }

    function openSearchTabFromState(tab: SearchResultTabState, options?: { preserveSearchScope?: boolean }) {
      if (activeTabId.value !== null) {
        persistActiveTab()
      }
      cancelInFlightSearchUi()
      clearScopedSearchProgress()
      searchSession.value = Date.now()
      const restored = cloneTabStateForRestore(tab, crypto.randomUUID())
      restored.searchSession = searchSession.value
      searchTabs.value = [...searchTabs.value, restored]
      activeTabId.value = restored.id
      restoreTabState(restored, options)
      saveSearchResultTabs(searchTabs.value, activeTabId.value)
      applySortToList()
      void goToViewPage(restored.viewPage)
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

    async function ensureActiveGlobalSnapshotOfflineMatches() {
      if (!isGlobalSnapshotSearchState(searchSource.value, activeCategoryLabel.value) || hasScopedOfflineMatches()) {
        return true
      }
      const tab = activeTabId.value === null ? undefined : searchTabs.value.find((item) => item.id === activeTabId.value)
      const meta = findGlobalSnapshotMetaForTab({
        activeCategoryLabel: activeCategoryLabel.value,
        title: tab?.title ?? activeCategoryLabel.value,
        globalSnapshotMetaId: tab?.globalSnapshotMetaId,
      })
      if (meta === undefined) {
        return false
      }
      const session = searchSession.value
      const record = await getGlobalSnapshotRecord(meta.id)
      if (!isActiveSearchSession(session)) {
        return false
      }
      if (record === undefined) {
        message.error('找不到全站快照內容，可能已被瀏覽器清除')
        return false
      }
      scopedOfflineMatches.value = [...record.comics]
      totalCountHint.value = record.comics.length
      totalServerPagesHint.value = Math.max(1, Math.ceil(record.comics.length / SCOPED_COLLECTED_PAGE_SIZE))
      totalCountRefined.value = true
      if (activeTabId.value !== null) {
        const idx = searchTabs.value.findIndex((item) => item.id === activeTabId.value)
        if (idx >= 0) {
          const next = [...searchTabs.value]
          next[idx] = { ...next[idx]!, globalSnapshotMetaId: meta.id }
          searchTabs.value = next
          saveSearchResultTabs(searchTabs.value, activeTabId.value)
        }
      }
      return true
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
        const preservedScope = searchScopeCategory.value
        activeTabId.value = null
        store.searchResult = undefined
        keywordOrComicLinkInput.value = ''
        tagOrLinkInput.value = ''
        activeTagSearchSource.value = 'name'
        searchInputMode.value = 'keywordOrComicLink'
        searchScopeCategory.value = preservedScope
        searchSource.value = preservedScope === null ? { type: 'keyword' } : { type: 'keyword', cateId: preservedScope.cateId }
        activeTagLabel.value = ''
        activeCategoryLabel.value = ''
        store.activeBrowseLabel = ''
        clearSearchResultsForNewSearch()
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
        restoreTabState(restored, { preserveSearchScope: true })
        saveSearchResultTabs(searchTabs.value, activeTabId.value)

        if (
          isScopedSearchSource(restored.searchSource) &&
          (restored.scopedOfflineMatches === undefined || restored.scopedOfflineMatches.length === 0)
        ) {
          message.warning('此收藏建立時未保存完整列表，需重新掃描；請掃描完成後再次點星星更新收藏')
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
    const activeSearchInputValue = computed(() => keywordOrComicLinkInput.value)
    const activeSearchInputLoading = computed(() => searchingKeywordOrComicLink.value)
    const displayPageCount = computed(() => {
      if (totalCountHint.value <= 0) {
        return 1
      }
      return Math.max(1, Math.ceil(totalCountHint.value / pageSize.value))
    })

    const isInitialSearchBusy = computed(() => searchingKeywordOrComicLink.value || searchingTagOrLink.value)

    const isSearchBusy = computed(
      () => isInitialSearchBusy.value || fetchingPages.value || isDownloadBatchEnqueueRunning(),
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
      () => store.searchResult !== undefined || visibleComics.value.length > 0 || allSearchComics.value.length > 0,
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

    const isGlobalSnapshotDialogOpen = computed(
      () => globalSnapshotResumeShowing.value || globalSnapshotConfirmShowing.value,
    )

    function selectGlobalSnapshotResumeStrategy(strategy: GlobalSnapshotResumeStrategy) {
      globalSnapshotResumeStrategy.value = strategy
    }

    function selectGlobalSnapshotScanMode(mode: 'conservative' | 'aggressive') {
      globalSnapshotScanMode.value = mode
    }

    function prepareGlobalSnapshotResumeScan() {
      globalSnapshotCancelled = true
      globalSnapshotManualRequestResolve?.()
      globalSnapshotManualRequestResolve = undefined
      globalSnapshotManualRequest.value = null
      clearGlobalSnapshotProgress()
      globalSnapshotCancelled = false
    }

    const isScopedScanOverlay = computed(() => {
      if (isGlobalSnapshotDialogOpen.value) {
        return false
      }
      if (globalSnapshotScanProgress.value !== null) {
        return true
      }
      if (scopedSearchConfirmShowing.value) {
        return false
      }
      if (!isScopedSearchActive.value) {
        return false
      }
      // 僅在後端正在回報掃描進度時顯示全螢幕遮罩；勿用 isInitialSearchBusy，
      // 否則分類瀏覽與關鍵詞搜尋交疊時 loading 旗標可能殘留並擋住所有點擊。
      return scopedSearchProgress.value !== null
    })

    const scopedSearchScanModeParam = computed(() =>
      scopedSearchScanMode.value === 'aggressive' ? 'aggressive' : 'conservative',
    )

    const scopedSearchElapsedText = computed(() => {
      const startedAt = scopedSearchStartedAt.value
      if (startedAt === null) {
        return '0秒'
      }
      return formatElapsedTime(scopedSearchElapsedTick.value - startedAt)
    })

    const globalSnapshotElapsedText = computed(() => {
      const startedAt = globalSnapshotStartedAt.value
      if (startedAt === null) {
        return '0秒'
      }
      return formatElapsedTime(globalSnapshotElapsedTick.value - startedAt)
    })

    const snapshotRepairElapsedText = computed(() => {
      const startedAt = snapshotRepairStartedAt.value
      if (startedAt === null) {
        return '0秒'
      }
      return formatElapsedTime(snapshotRepairElapsedTick.value - startedAt)
    })

    const globalSnapshotKeywordSearchPercent = computed(() => {
      const progress = globalSnapshotKeywordSearchProgress.value
      if (progress === null || progress.total <= 0) {
        return 0
      }
      return Math.min(100, Math.max(0, Math.round((progress.current / progress.total) * 100)))
    })

    const snapshotRepairGapThreshold = computed(() => Math.max(1, Math.floor(snapshotRepairGapLimit.value) + 1))

    const snapshotRepairMissingGapAnalysis = computed(() => {
      const source = snapshotRepairMissingFile.value
      if (source === null) {
        return null
      }
      return buildSnapshotGapAnalysis(source, snapshotRepairGapThreshold.value)
    })

    const activeGlobalSnapshotLabel = computed(() => {
      const snapshot = activeGlobalSnapshotMeta.value
      return snapshot === null ? '' : `目前：${globalSnapshotLabel(snapshot)}`
    })

    const isManualScanRequestWaiting = computed(() => {
      if (globalSnapshotManualRequest.value !== null) {
        return true
      }
      const scoped = scopedSearchProgress.value
      return scoped?.paused === true && scoped.retryInSecs === null
    })

    const loadingDescription = computed(() => {
      const snapshotKeywordProgress = globalSnapshotKeywordSearchProgress.value
      if (snapshotKeywordProgress !== null) {
        if (snapshotKeywordProgress.total <= 0) {
          return snapshotKeywordProgress.detail
        }
        return `${snapshotKeywordProgress.detail} ${snapshotKeywordProgress.current}/${snapshotKeywordProgress.total} 筆（已找到 ${snapshotKeywordProgress.matchedCount} 本）`
      }
      const globalProgress = globalSnapshotScanProgress.value
      if (globalProgress !== null) {
        const manual = globalSnapshotManualRequest.value
        const reason = globalSnapshotPauseReason.value
        if (reason !== null && manual === null) {
          return `${reason}（成功 ${globalProgress.successPages}/${globalProgress.total} 頁，失敗嘗試 ${globalProgress.failedAttempts}，待補掃 ${globalProgress.queuedRetryPages}，補掃成功 ${globalProgress.retrySuccessPages}，已收集 ${globalProgress.matchedCount} 本，已用時 ${globalSnapshotElapsedText.value}）`
        }
        if (globalSnapshotScanMode.value === 'aggressive') {
          if (manual !== null) {
            if (reason !== null) {
              return `${reason}（成功 ${globalProgress.successPages}/${globalProgress.total} 頁，失敗嘗試 ${globalProgress.failedAttempts}，待補掃 ${globalProgress.queuedRetryPages}，補掃成功 ${globalProgress.retrySuccessPages}，已找到 ${globalProgress.matchedCount} 本）`
            }
            return `成功 ${globalProgress.successPages}/${globalProgress.total} 頁，失敗嘗試 ${globalProgress.failedAttempts}，待補掃 ${globalProgress.queuedRetryPages}，補掃成功 ${globalProgress.retrySuccessPages}，已找到 ${globalProgress.matchedCount} 本`
          }
          return `成功 ${globalProgress.successPages}/${globalProgress.total} 頁，失敗嘗試 ${globalProgress.failedAttempts}，待補掃 ${globalProgress.queuedRetryPages}，補掃成功 ${globalProgress.retrySuccessPages}，已找到 ${globalProgress.matchedCount} 本`
        }
        if (manual !== null) {
          return `已準備發送第 ${manual.startPage}-${manual.endPage} 頁請求，按「發送請求」後繼續（已收集 ${globalProgress.matchedCount} 本，已用時 ${globalSnapshotElapsedText.value}）`
        }
        return `正在建立${globalSnapshotScanningLabel.value} ${globalProgress.current}/${globalProgress.total} 頁（成功 ${globalProgress.successPages}，失敗嘗試 ${globalProgress.failedAttempts}，待補掃 ${globalProgress.queuedRetryPages}，補掃成功 ${globalProgress.retrySuccessPages}，已收集 ${globalProgress.matchedCount} 本，已用時 ${globalSnapshotElapsedText.value}）${globalProgress.selfCheckHint ? ` · ${globalProgress.selfCheckHint}` : ''}`
      }
      const scoped = scopedSearchProgress.value
      if (scoped !== null) {
        if (scopedSearchScanMode.value === 'aggressive') {
          if (scoped.paused && scoped.retryInSecs === null) {
            if (scoped.pausedReason !== null) {
              return `${scoped.pausedReason}（已掃 ${scoped.current}/${scoped.total} 頁，已找到 ${scoped.matchedCount} 本）`
            }
            return `已掃 ${scoped.current}/${scoped.total} 頁，已找到 ${scoped.matchedCount} 本`
          }
          return `已掃 ${scoped.current}/${scoped.total} 頁，已找到 ${scoped.matchedCount} 本`
        }
        const elapsed = scopedSearchElapsedText.value
        const listLabel =
          scoped.scanKind === 'tag' ? '標籤列表' : scoped.scanKind === 'search' ? '搜尋結果' : '分類列表'
        if (scoped.paused && scoped.retryInSecs === null) {
          return `激進模式已準備發送下一批 200 頁並行請求，按「發送請求」後繼續…（已找到 ${scoped.matchedCount} 本，已用時 ${elapsed}）`
        }
        if (scoped.paused && scoped.retryInSecs !== null) {
          return `請求過於頻繁，${scoped.retryInSecs} 秒後從第 ${scoped.current}/${scoped.total} 頁繼續…（已找到 ${scoped.matchedCount} 本，已用時 ${elapsed}）`
        }
        return `正在掃描${listLabel} ${scoped.current}/${scoped.total} 頁（已找到 ${scoped.matchedCount} 本，已用時 ${elapsed}）`
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
      void hydrateActiveGlobalSnapshotTabOnStartup().catch((err) => {
        console.error(err)
      })
      window.addEventListener('keydown', handleScopedCacheChoiceEnter)
      unlistenSearchScanProgress = await events.searchScanProgressEvent.listen(({ payload }) => {
        lastScopedSearchProgress.value = {
          current: payload.current,
          total: payload.total,
          matchedCount: payload.matchedCount,
        }
        if (scopedSearchStartedAt.value === null) {
          scopedSearchStartedAt.value = Date.now()
          scopedSearchElapsedTick.value = scopedSearchStartedAt.value
          startScopedSearchElapsedTimer()
        }
        if (payload.cancelled || payload.finished) {
          if (payload.finished && !payload.cancelled) {
            const startedAt = scopedSearchStartedAt.value ?? Date.now()
            scopedSearchCompleteSummary.value = {
              elapsedText: formatElapsedTime(Date.now() - startedAt),
              matchedCount: payload.matchedCount,
              scannedPages: payload.current,
              totalPages: payload.total,
            }
          }
          clearScopedSearchProgress()
          return
        }
        scopedSearchProgress.value = {
          current: payload.current,
          total: payload.total,
          matchedCount: payload.matchedCount,
          scanKind: payload.scanKind === 'tag' ? 'tag' : payload.scanKind === 'search' ? 'search' : 'category',
          paused: payload.paused,
          retryInSecs: payload.retryInSecs,
          pausedReason: payload.pausedReason,
        }
      })
    })

    onUnmounted(() => {
      persistActiveTab()
      window.removeEventListener('keydown', handleScopedCacheChoiceEnter)
      unlistenSearchScanProgress?.()
      stopScopedSearchElapsedTimer()
      stopGlobalSnapshotElapsedTimer()
      stopSnapshotRepairElapsedTimer()
    })

    function formatElapsedTime(ms: number) {
      const totalSeconds = Math.max(0, Math.floor(ms / 1000))
      const minutes = Math.floor(totalSeconds / 60)
      const seconds = totalSeconds % 60
      if (minutes <= 0) {
        return `${seconds}秒`
      }
      return `${minutes}分${String(seconds).padStart(2, '0')}秒`
    }

    function startScopedSearchElapsedTimer() {
      if (scopedSearchElapsedTimer !== undefined) {
        return
      }
      scopedSearchElapsedTimer = window.setInterval(() => {
        scopedSearchElapsedTick.value = Date.now()
      }, 1000)
    }

    function stopScopedSearchElapsedTimer() {
      if (scopedSearchElapsedTimer === undefined) {
        return
      }
      window.clearInterval(scopedSearchElapsedTimer)
      scopedSearchElapsedTimer = undefined
    }

    function startSnapshotRepairElapsedTimer() {
      if (snapshotRepairElapsedTimer !== undefined) {
        return
      }
      snapshotRepairElapsedTimer = window.setInterval(() => {
        snapshotRepairElapsedTick.value = Date.now()
      }, 1000)
    }

    function stopSnapshotRepairElapsedTimer() {
      if (snapshotRepairElapsedTimer === undefined) {
        return
      }
      window.clearInterval(snapshotRepairElapsedTimer)
      snapshotRepairElapsedTimer = undefined
    }

    function startGlobalSnapshotElapsedTimer() {
      if (globalSnapshotElapsedTimer !== undefined) {
        return
      }
      globalSnapshotElapsedTimer = window.setInterval(() => {
        globalSnapshotElapsedTick.value = Date.now()
      }, 1000)
    }

    function stopGlobalSnapshotElapsedTimer() {
      if (globalSnapshotElapsedTimer === undefined) {
        return
      }
      window.clearInterval(globalSnapshotElapsedTimer)
      globalSnapshotElapsedTimer = undefined
    }

    function clearScopedSearchProgress() {
      scopedSearchProgress.value = null
      scopedSearchStartedAt.value = null
      stopScopedSearchElapsedTimer()
    }

    function clearGlobalSnapshotProgress() {
      globalSnapshotScanProgress.value = null
      globalSnapshotManualRequest.value = null
      globalSnapshotPauseReason.value = null
      globalSnapshotManualRequestResolve = undefined
      globalSnapshotStartedAt.value = null
      stopGlobalSnapshotElapsedTimer()
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

    function isCloudflareChallengeFailure(reason: string) {
      const lower = reason.toLocaleLowerCase()
      return (
        lower.includes('just a moment') ||
        lower.includes('challenges.cloudflare.com') ||
        lower.includes('/cdn-cgi/challenge-platform') ||
        lower.includes('cf-chl-') ||
        lower.includes('enable javascript and cookies')
      )
    }

    function isStrictCloudflareChallengeFailure(reason: string) {
      const lower = reason.toLocaleLowerCase()
      return (
        lower.includes('just a moment') ||
        lower.includes('challenges.cloudflare.com') ||
        lower.includes('/cdn-cgi/challenge-platform') ||
        lower.includes('cf-chl-') ||
        lower.includes('enable javascript and cookies')
      )
    }

    function cancelScopedSearch() {
      if (globalSnapshotScanProgress.value !== null) {
        globalSnapshotCancelled = true
        globalSnapshotManualRequestResolve?.()
        globalSnapshotManualRequestResolve = undefined
        globalSnapshotManualRequest.value = null
        return
      }
      void commands.cancelScopedSearchScan()
    }

    function sendManualScanRequest() {
      if (globalSnapshotManualRequest.value !== null) {
        globalSnapshotManualRequest.value = null
        const resolve = globalSnapshotManualRequestResolve
        globalSnapshotManualRequestResolve = undefined
        resolve?.()
        return
      }
      void commands.advanceScopedSearchScan()
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

    async function loadAllComicsForKoreanMode(session: number): Promise<ComicInSearch[] | 'cancelled' | undefined> {
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

          totalPages = Math.min(Math.max(totalPages, pageResult.totalPage), totalServerPagesHint.value)
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
      lastScopedSearchProgress.value = null
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

    async function fetchSearchPageFromApi(serverPage: number, session: number): Promise<SearchResult | undefined> {
      const source = searchSource.value
      let result: Awaited<ReturnType<typeof commands.browseByCategory>> | undefined

      if (source.type === 'category') {
        result = await commands.browseByCategory(source.cateId, serverPage)
      } else if (source.type === 'ranking') {
        result = await commands.browseRanking(source.period, source.cateId, serverPage)
      } else if (source.type === 'albums') {
        result =
          source.list === 'home' ? await commands.browseHome(serverPage) : await commands.browseAlbumsList(serverPage)
      } else if (source.type === 'tag') {
        const cateId = source.cateId ?? null
        if (activeTagSearchSource.value === 'link') {
          const trimmed = tagOrLinkInput.value.trim()
          const parsed = parseTagSearchLink(trimmed)
          if (parsed === undefined) {
            return undefined
          }
          const pageToFetch = serverPage === 1 ? parsed.page : serverPage
          result = await commands.searchByTag(parsed.tagSlug, pageToFetch, cateId, scopedSearchScanModeParam.value)
        } else {
          result = await commands.searchByTag(
            tagOrLinkInput.value.trim(),
            serverPage,
            cateId,
            scopedSearchScanModeParam.value,
          )
        }
      } else {
        const cateId = source.type === 'keyword' ? (source.cateId ?? null) : null
        result = await commands.searchByKeyword(
          keywordOrComicLinkInput.value.trim(),
          serverPage,
          cateId,
          scopedSearchScanModeParam.value,
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

    async function fetchSearchPage(serverPage: number, session: number): Promise<SearchResult | undefined> {
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

      const totalCollectedPages = Math.max(1, Math.ceil(totalCountHint.value / SCOPED_COLLECTED_PAGE_SIZE))
      const merged: ComicInSearch[] = []
      const firstPageResult = pageCache.get(1)
      let startCollectedPage = 1

      if (firstPageResult !== undefined) {
        mergeComicsInto(merged, firstPageResult.comics)
        startCollectedPage = 2
      }

      for (let collectedPage = startCollectedPage; collectedPage <= totalCollectedPages; collectedPage++) {
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
      saveActiveScopedScanCache()
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

    function maxServerListPage(): number {
      if (totalCountHint.value <= 0) {
        return totalServerPagesHint.value
      }
      return Math.max(totalServerPagesHint.value, Math.ceil(totalCountHint.value / SERVER_PAGE_SIZE))
    }

    function ingestSearchMetadata(result: SearchResult, requestedServerPage?: number) {
      const cachePage = requestedServerPage ?? result.currentPage
      pageCache.set(cachePage, result)
      const total = effectiveTotalCount(result)
      if (!totalCountRefined.value || totalCountHint.value <= 0) {
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
          // 總數尚未知時勿 cap 官網頁（否則每頁 40/60 只會載入 20 筆）；已知總數時才依 maxServerListPage 上限
          if (totalCountHint.value > 0 && p > maxServerListPage()) {
            break
          }
          if (totalCountHint.value <= 0 && p > totalServerPagesHint.value) {
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
      if (!(await ensureActiveGlobalSnapshotOfflineMatches())) {
        return false
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

      const loadResult = await ensureServerPagesLoaded(firstServerPage, lastServerPage, session, (current, total) => {
        viewPageFetchProgress.value = { current, total }
      })

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

    function normalizeHomeListResult(result: SearchResult): SearchResult {
      const total = result.comics.length
      return {
        ...result,
        currentPage: 1,
        totalPage: Math.max(1, Math.ceil(total / SERVER_PAGE_SIZE)),
        totalCount: total,
      }
    }

    async function completeNewSearchTab(
      pendingTabTitle: string | null,
      result: SearchResult,
      options?: { offlineComics?: ComicInSearch[] },
    ): Promise<boolean> {
      if (pendingTabTitle !== null) {
        openNewSearchTab(pendingTabTitle)
      }
      if (options?.offlineComics !== undefined) {
        scopedOfflineMatches.value = [...options.offlineComics]
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
      saveSearchSortOrder(key)
      if (allSearchComics.value.length === 0) {
        return
      }
      applySortToList()
      showViewPage(viewPage.value)
    }

    function formatScanCacheDate(value: string) {
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) {
        return value
      }
      const yyyy = date.getFullYear()
      const mm = String(date.getMonth() + 1).padStart(2, '0')
      const dd = String(date.getDate()).padStart(2, '0')
      const hh = String(date.getHours()).padStart(2, '0')
      const mi = String(date.getMinutes()).padStart(2, '0')
      const ss = String(date.getSeconds()).padStart(2, '0')
      return `${yyyy}/${mm}/${dd} ${hh}:${mi}:${ss}`
    }

    function scanCacheLabel(cache: ScopedScanCache) {
      return `${cache.categoryLabel} ${cache.kindLabel} ${cache.queryLabel} 共${cache.totalCount}本 ${formatScanCacheDate(cache.savedAt)}`
    }

    function snapshotScanTargetLabel(snapshot: GlobalSnapshotMeta) {
      if (snapshot.scanTargetKind === 'category') {
        return snapshot.scanTargetLabel ?? CATEGORY_LABEL_BY_CATE_ID.get(snapshot.scanTargetCateId ?? -1) ?? '分類'
      }
      return snapshot.scanTargetLabel ?? '更新'
    }

    function globalSnapshotLabel(snapshot: GlobalSnapshotMeta) {
      return `${snapshotScanTargetLabel(snapshot)}快照 ${formatScanCacheDate(snapshot.savedAt)}`
    }

    function snapshotScanTargetFromKey(key: string) {
      return SNAPSHOT_SCAN_TARGET_OPTIONS.find((target) => target.key === key)
    }

    function snapshotScanTargetFromMeta(meta: GlobalSnapshotMeta): SnapshotScanTarget {
      if (meta.scanTargetKind === 'category' && meta.scanTargetCateId !== undefined) {
        return (
          snapshotScanTargetFromKey(`category:${meta.scanTargetCateId}`) ?? {
            key: `category:${meta.scanTargetCateId}`,
            kind: 'category',
            label: meta.scanTargetLabel ?? `分類 ID ${meta.scanTargetCateId}`,
            cateId: meta.scanTargetCateId,
          }
        )
      }
      return SNAPSHOT_SCAN_TARGET_OPTIONS[0]!
    }

    function snapshotTargetMatchesMeta(target: SnapshotScanTarget, meta: GlobalSnapshotMeta) {
      if (target.kind === 'category') {
        return meta.scanTargetKind === 'category' && meta.scanTargetCateId === target.cateId
      }
      return meta.scanTargetKind !== 'category'
    }

    function findLatestCompletedGlobalSnapshotForTarget(target: SnapshotScanTarget) {
      return [...globalSnapshotMetas.value]
        .filter((meta) => snapshotTargetMatchesMeta(target, meta) && isSnapshotScanComplete(meta))
        .sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime())[0]
    }

    function findLatestGlobalSnapshotForScope(scope: { cateId: number; label: string }) {
      return [...globalSnapshotMetas.value]
        .filter((meta) => meta.scanTargetKind === 'category' && meta.scanTargetCateId === scope.cateId)
        .sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime())[0]
    }

    function pageRangesFromSet(pages: Set<number>): SnapshotCompletedPageRange[] {
      const sorted = [...pages].sort((a, b) => a - b)
      const ranges: SnapshotCompletedPageRange[] = []
      for (const page of sorted) {
        const last = ranges[ranges.length - 1]
        if (last !== undefined && page === last.end + 1) {
          last.end = page
          continue
        }
        ranges.push({ start: page, end: page })
      }
      return ranges
    }

    function pageSetFromRanges(ranges: SnapshotCompletedPageRange[] | undefined, totalPages: number) {
      const pages = new Set<number>()
      for (const range of ranges ?? []) {
        const start = Math.max(1, Math.min(totalPages, range.start))
        const end = Math.max(1, Math.min(totalPages, range.end))
        for (let page = start; page <= end; page += 1) {
          pages.add(page)
        }
      }
      return pages
    }

    function completedPagesFromSnapshotMeta(meta: GlobalSnapshotMeta | undefined, totalPages: number) {
      if (meta === undefined) {
        return new Set<number>()
      }
      const rangedPages = pageSetFromRanges(meta.scanCompletedPageRanges, totalPages)
      if (rangedPages.size > 0 || meta.scanCompletedPageRanges !== undefined) {
        return rangedPages
      }
      const completedCount = Math.min(
        totalPages,
        Math.max(
          0,
          meta.scanCompletedPages ?? Math.round((scanCacheCompletionPercent(meta) / 100) * totalPages),
        ),
      )
      const pages = new Set<number>()
      for (let page = totalPages; page > totalPages - completedCount; page -= 1) {
        pages.add(page)
      }
      return pages
    }

    function highestUncompletedPage(totalPages: number, completedPages: Set<number>) {
      for (let page = totalPages; page >= 1; page -= 1) {
        if (!completedPages.has(page)) {
          return page
        }
      }
      return 0
    }

    function missingSnapshotPagesInRange(completed: Set<number>, from: number, to: number) {
      const missing: number[] = []
      for (let page = from; page <= to; page += 1) {
        if (!completed.has(page)) {
          missing.push(page)
        }
      }
      return missing
    }

    function isUsableSnapshotPageResult(
      result: SearchResult | undefined,
      requestedPage: number,
      totalPages: number,
      failAttempts: number,
    ) {
      if (result === undefined) {
        return false
      }
      if (result.currentPage !== requestedPage) {
        return false
      }
      if (result.comics.length === 0) {
        return false
      }
      if (requestedPage >= totalPages) {
        return true
      }
      if (result.comics.length >= SERVER_PAGE_SIZE) {
        return true
      }
      return failAttempts >= 4 && result.comics.length >= 1
    }

    function validateSnapshotScanIntegrity(input: {
      targetLabel: string
      totalPages: number
      expectedTotalCount: number
      completedPages: Set<number>
      retryQueuedPages: Set<number>
      uniqueComicCount: number
      requireFullPages: boolean
    }): { ok: true } | { ok: false; message: string } {
      if (input.requireFullPages) {
        const missing = missingSnapshotPagesInRange(input.completedPages, 1, input.totalPages)
        if (missing.length > 0) {
          const preview =
            missing.length <= 8
              ? missing.join('、')
              : `${missing.slice(0, 6).join('、')}…等 ${missing.length} 頁`
          return {
            ok: false,
            message: `${input.targetLabel} 收尾驗證：官網第 ${preview} 未掃描`,
          }
        }
        if (input.completedPages.size < input.totalPages) {
          return {
            ok: false,
            message: `${input.targetLabel} 收尾驗證：僅完成 ${input.completedPages.size}/${input.totalPages} 頁`,
          }
        }
      }
      if (input.expectedTotalCount > 0 && input.uniqueComicCount < input.expectedTotalCount) {
        return {
          ok: false,
          message: `${input.targetLabel} 收尾驗證：收集 ${input.uniqueComicCount}/${input.expectedTotalCount} 本（差 ${input.expectedTotalCount - input.uniqueComicCount} 本）`,
        }
      }
      if (input.retryQueuedPages.size > 0) {
        return {
          ok: false,
          message: `${input.targetLabel} 收尾驗證：仍有 ${input.retryQueuedPages.size} 頁待補掃`,
        }
      }
      return { ok: true }
    }

    function validateSnapshotComicIdOrder(comics: ComicInSearch[]): { ok: true } | { ok: false; message: string } {
      for (let index = 1; index < comics.length; index += 1) {
        const prev = comics[index - 1]!
        const current = comics[index]!
        if (current.id >= prev.id) {
          return {
            ok: false,
            message: `ID 排序校對失敗：第 ${index}→${index + 1} 筆（${prev.id} → ${current.id}），應由大到小排列（頂部 ID 較大、底部 ID 較小）`,
          }
        }
      }
      return { ok: true }
    }

    function comicMatchesCateScope(comic: ComicInSearch, cateId: number) {
      const listCateId = comic.listCateId
      if (listCateId === null || listCateId === undefined) {
        return false
      }
      if (listCateId === cateId) {
        return true
      }
      switch (cateId) {
        case 5:
          return [1, 12, 16, 2, 37, 22, 3].includes(listCateId)
        case 6:
          return [9, 13, 17].includes(listCateId)
        case 7:
          return [10, 14, 18].includes(listCateId)
        case 19:
          return [20, 21].includes(listCateId)
        default:
          return false
      }
    }

    function comicTitleMatchesKeywordVariants(comic: ComicInSearch, keywordVariants: string[]) {
      const titleVariants = chineseSearchVariants(`${comic.title} ${comic.titleHtml}`)
      return keywordVariants.some((kw) => titleVariants.some((title) => title.includes(kw)))
    }

    function globalSnapshotComicCategoryLabel(comic: ComicInSearch) {
      const cateId = comic.listCateId
      if (cateId === null || cateId === undefined) {
        return '未知分類'
      }
      return CATEGORY_LABEL_BY_CATE_ID.get(cateId) ?? `分類 ID ${cateId}`
    }

    async function filterGlobalSnapshotByKeywordWithProgress(
      comics: ComicInSearch[],
      scope: { cateId: number },
      keyword: string,
    ) {
      const keywordVariants = chineseSearchVariants(keyword)
      if (keywordVariants.length === 0) {
        return []
      }
      const matches: ComicInSearch[] = []
      const total = comics.length
      for (let index = 0; index < total; index += 1) {
        const comic = comics[index]
        if (comicMatchesCateScope(comic, scope.cateId) && comicTitleMatchesKeywordVariants(comic, keywordVariants)) {
          matches.push(comic)
        }
        if ((index + 1) % GLOBAL_SNAPSHOT_KEYWORD_PROGRESS_CHUNK_SIZE === 0 || index + 1 === total) {
          globalSnapshotKeywordSearchProgress.value = {
            current: index + 1,
            total,
            matchedCount: matches.length,
            detail: '正在比對全站快照',
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
        }
      }
      return matches
    }

    async function summarizeGlobalSnapshotKeywordMatchesWithProgress(comics: ComicInSearch[], keyword: string) {
      const keywordVariants = chineseSearchVariants(keyword)
      if (keywordVariants.length === 0) {
        return { totalCount: 0, categories: [] }
      }
      let totalCount = 0
      const categoryCounts = new Map<string, number>()
      const total = comics.length
      for (let index = 0; index < total; index += 1) {
        const comic = comics[index]
        if (comicTitleMatchesKeywordVariants(comic, keywordVariants)) {
          totalCount += 1
          const label = globalSnapshotComicCategoryLabel(comic)
          categoryCounts.set(label, (categoryCounts.get(label) ?? 0) + 1)
        }
        if ((index + 1) % GLOBAL_SNAPSHOT_KEYWORD_PROGRESS_CHUNK_SIZE === 0 || index + 1 === total) {
          globalSnapshotKeywordSearchProgress.value = {
            current: index + 1,
            total,
            matchedCount: totalCount,
            detail: '正在確認全站快照是否有符合關鍵詞',
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
        }
      }
      return {
        totalCount,
        categories: Array.from(categoryCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([label, count]) => `${label} ${count} 本`),
      }
    }

    function buildCollectedSearchResult(comics: ComicInSearch[], isSearchByTag = false): SearchResult {
      return {
        comics: comics.slice(0, SCOPED_COLLECTED_PAGE_SIZE),
        currentPage: 1,
        totalPage: Math.max(1, Math.ceil(comics.length / SCOPED_COLLECTED_PAGE_SIZE)),
        totalCount: comics.length,
        isSearchByTag,
      }
    }

    function clampScanCompletionPercent(value: number) {
      if (!Number.isFinite(value)) {
        return 100
      }
      return Math.min(100, Math.max(0, Math.round(value)))
    }

    function scanCacheCompletionPercent(cache: {
      scanCompletionPercent?: number
      scanCompletedPages?: number
      scanCompletedPageRanges?: SnapshotCompletedPageRange[]
      totalPages?: number
    }) {
      if (cache.totalPages !== undefined && cache.totalPages > 0) {
        let completedPages: number | undefined
        if (cache.scanCompletedPageRanges !== undefined) {
          const fromRanges = pageSetFromRanges(cache.scanCompletedPageRanges, cache.totalPages).size
          completedPages =
            fromRanges > 0
              ? fromRanges
              : cache.scanCompletedPages
        } else {
          completedPages = cache.scanCompletedPages
        }
        if (completedPages !== undefined) {
          const percent = (Math.min(completedPages, cache.totalPages) / cache.totalPages) * 100
          return completedPages >= cache.totalPages ? 100 : Math.min(99, clampScanCompletionPercent(percent))
        }
      }
      return clampScanCompletionPercent(cache.scanCompletionPercent ?? 100)
    }

    function isSnapshotScanComplete(snapshot: GlobalSnapshotMeta) {
      if (snapshot.totalPages <= 0) {
        return false
      }
      if (snapshot.scanCompletedPages !== undefined) {
        return snapshot.scanCompletedPages >= snapshot.totalPages
      }
      return scanCacheCompletionPercent(snapshot) >= 100
    }

    function currentScanCompletionPercent() {
      const progress = lastScopedSearchProgress.value
      if (progress !== null && progress.total > 0) {
        return clampScanCompletionPercent((progress.current / progress.total) * 100)
      }
      if (totalCountHint.value > 0) {
        return clampScanCompletionPercent((scopedOfflineMatches.value.length / totalCountHint.value) * 100)
      }
      return 100
    }

    function currentScanCompletedPages() {
      const progress = lastScopedSearchProgress.value
      if (progress !== null && progress.total > 0) {
        return Math.min(progress.total, Math.max(0, progress.current))
      }
      return undefined
    }

    async function loadGlobalSnapshot(meta: GlobalSnapshotMeta, openTab = true) {
      const record = await getGlobalSnapshotRecord(meta.id)
      if (record === undefined) {
        message.error('找不到全站快照內容，可能已被瀏覽器清除')
        return false
      }
      if (openTab) {
        store.currentTabName = 'search'
        await openGlobalSnapshotTab(meta, record.comics)
      }
      message.success('已載入快照分頁')
      return true
    }

    async function openGlobalSnapshotTab(meta: GlobalSnapshotMeta, comics: ComicInSearch[]) {
      const preservedScope = searchScopeCategory.value
      store.currentTabName = 'search'
      persistActiveTabBeforeNewSearch()
      searchSource.value = { type: 'albums', list: 'albums' }
      searchScopeCategory.value = preservedScope
      activeCategoryLabel.value = globalSnapshotLabel(meta)
      store.activeBrowseLabel = snapshotScanTargetLabel(meta)
      keywordOrComicLinkInput.value = ''
      tagOrLinkInput.value = ''
      searchInputMode.value = 'keywordOrComicLink'
      const session = beginSearchSession()
      await completeNewSearchTab(globalSnapshotLabel(meta), buildCollectedSearchResult(comics), {
        offlineComics: comics,
      })
      if (activeTabId.value !== null) {
        const idx = searchTabs.value.findIndex((item) => item.id === activeTabId.value)
        if (idx >= 0) {
          const next = [...searchTabs.value]
          next[idx] = { ...next[idx]!, globalSnapshotMetaId: meta.id }
          searchTabs.value = next
          saveSearchResultTabs(searchTabs.value, activeTabId.value)
        }
      }
      if (!isActiveSearchSession(session)) {
        return
      }
      store.currentTabName = 'search'
    }

    function isGlobalSnapshotTabState(tab: SearchResultTabState, meta?: GlobalSnapshotMeta) {
      if (tab.searchSource.type !== 'albums' || tab.searchSource.list !== 'albums') {
        return false
      }
      if (meta !== undefined) {
        return tab.activeCategoryLabel === globalSnapshotLabel(meta) || tab.title === globalSnapshotLabel(meta)
      }
      return tab.activeCategoryLabel.includes('快照') || tab.title.includes('快照')
    }

    function currentTabNeedsGlobalSnapshotHydration(meta: GlobalSnapshotMeta) {
      const tab = activeTabId.value === null ? undefined : searchTabs.value.find((item) => item.id === activeTabId.value)
      if (tab === undefined) {
        return false
      }
      const isEmpty =
        tab.allSearchComics.length === 0 &&
        tab.visibleComics.length === 0 &&
        (tab.searchResult?.comics.length ?? 0) === 0
      return isGlobalSnapshotTabState(tab, meta) && isEmpty
    }

    async function hydrateActiveGlobalSnapshotTabOnStartup() {
      const meta = activeGlobalSnapshotMeta.value
      if (meta === null) {
        return
      }
      const hasSavedSnapshotTab = searchTabs.value.some((tab) => isGlobalSnapshotTabState(tab, meta))
      if (!hasSavedSnapshotTab) {
        return
      }
      if (!currentTabNeedsGlobalSnapshotHydration(meta)) {
        return
      }
      const record = await getGlobalSnapshotRecord(meta.id)
      if (record === undefined) {
        return
      }
      activeGlobalSnapshotComics.value = [...record.comics]
      store.currentTabName = 'search'
      if (activeTabId.value === null) {
        await openGlobalSnapshotTab(meta, record.comics)
        return
      }
      searchSource.value = { type: 'albums', list: 'albums' }
      searchScopeCategory.value = null
      activeCategoryLabel.value = globalSnapshotLabel(meta)
      store.activeBrowseLabel = snapshotScanTargetLabel(meta)
      keywordOrComicLinkInput.value = ''
      tagOrLinkInput.value = ''
      searchInputMode.value = 'keywordOrComicLink'
      const session = beginSearchSession()
      await completeNewSearchTab(null, buildCollectedSearchResult(record.comics), {
        offlineComics: record.comics,
      })
      if (!isActiveSearchSession(session)) {
        return
      }
      persistActiveTab()
      store.currentTabName = 'search'
    }

    async function upsertGlobalSnapshot(
      meta: GlobalSnapshotMeta | null,
      target: SnapshotScanTarget,
      batchComics: ComicInSearch[],
      totalPages: number,
      completionPercent: number,
      scanCompletedPages: number,
      scanCompletedPageRanges: SnapshotCompletedPageRange[],
    ) {
      const nextMeta: GlobalSnapshotMeta =
        meta ??
        {
          id: crypto.randomUUID(),
          savedAt: new Date().toISOString(),
          totalCount: 0,
          totalPages,
          scanCompletionPercent: 0,
          scanDirection: 'tailToHead',
          scanCompletedPages: 0,
          scanCompletedPageRanges: [],
          scanTargetKind: target.kind,
          scanTargetCateId: target.kind === 'category' ? target.cateId : undefined,
          scanTargetLabel: target.label,
        }
      const existing = meta === null ? undefined : await getGlobalSnapshotRecord(meta.id)
      const mergedComics = existing?.comics ? [...existing.comics] : []
      mergeComicsInto(mergedComics, batchComics)
      const snapshotComics = sortComicsForSnapshotArchive(mergedComics)
      const updatedMeta: GlobalSnapshotMeta = {
        ...nextMeta,
        savedAt: new Date().toISOString(),
        totalCount: snapshotComics.length,
        totalPages,
        scanCompletionPercent: clampScanCompletionPercent(completionPercent),
        scanDirection: 'tailToHead',
        scanCompletedPages,
        scanCompletedPageRanges,
        scanTargetKind: target.kind,
        scanTargetCateId: target.kind === 'category' ? target.cateId : undefined,
        scanTargetLabel: target.label,
      }
      await putGlobalSnapshotRecord({ id: updatedMeta.id, comics: snapshotComics })
      globalSnapshotMetas.value = [
        updatedMeta,
        ...globalSnapshotMetas.value.filter((item) => item.id !== updatedMeta.id),
      ]
      saveGlobalSnapshotMetas()
      return updatedMeta
    }

    function randomInt(min: number, max: number) {
      return Math.floor(Math.random() * (max - min + 1)) + min
    }

    async function fetchGlobalSnapshotPage(page: number) {
      const result = await commands.browseAlbumsList(page)
      if (result.status === 'error') {
        console.error(result.error)
        return undefined
      }
      return result.data
    }

    async function fetchSnapshotScanTargetPage(target: SnapshotScanTarget, page: number) {
      const result =
        target.kind === 'category'
          ? await commands.browseByCategory(target.cateId, page)
          : await commands.browseAlbumsList(page)
      if (result.status === 'error') {
        console.error(result.error)
        return { data: undefined, reason: formatInvokeError(result.error) }
      }
      return { data: result.data, reason: undefined }
    }

    async function writeSortedGlobalSnapshotCalibration(meta: GlobalSnapshotMeta) {
      const record = await getGlobalSnapshotRecord(meta.id)
      if (record === undefined) {
        return null
      }
      const source: GlobalSnapshotExportFile = {
        format: 'gentleman-manager.snapshot.v1',
        exportedAt: new Date().toISOString(),
        snapshot: { kind: 'global', meta, comics: record.comics },
      }
      const sortedFile = makeGlobalSnapshotExportFile(source, sortedUniqueComicsById(record.comics), {
        scanCompletionPercent: 100,
        scanCompletedPages: meta.totalPages,
        scanCompletedPageRanges: meta.totalPages > 0 ? [{ start: 1, end: meta.totalPages }] : [],
      })
      const result = await commands.writeSnapshotWebsiteFile(
        safeSnapshotExportFilename(`${snapshotScanTargetLabel(meta)}快照 ${snapshotRepairTimestamp()}`),
        JSON.stringify(sortedFile, null, 2),
        true,
      )
      if (result.status === 'error') {
        console.error(result.error)
        message.error(result.error.err_message)
        return null
      }
      return result.data
    }

    async function exportGlobalSnapshotToWebsite(meta: GlobalSnapshotMeta) {
      return writeSortedGlobalSnapshotCalibration(meta)
    }

    async function finishGlobalSnapshotWebsiteExport(
      target: SnapshotScanTarget,
      meta: GlobalSnapshotMeta,
      options: { addedCount: number; openTabOnComplete: boolean },
    ) {
      if (options.openTabOnComplete) {
        await loadGlobalSnapshot(meta, true)
      }
      const websitePath = await exportGlobalSnapshotToWebsite(meta)
      if (options.addedCount <= 0) {
        if (websitePath !== null) {
          message.success(
            `${target.label}快照已是最新，無須更新；已同步導出至 Website Snapshot（舊檔已刪除）`,
          )
        } else {
          message.success(`${target.label}快照已是最新，無須更新`)
        }
        return
      }
      if (websitePath !== null) {
        message.success(
          `${target.label}快照已更新至最新（新增 ${options.addedCount} 本）；已導出至 Website Snapshot（舊檔已刪除）`,
        )
      } else {
        message.warning(`${target.label}快照已更新（新增 ${options.addedCount} 本），但導出 Website Snapshot 失敗`)
      }
    }

    function resolveGlobalSnapshotConfirm(confirmed: boolean) {
      globalSnapshotConfirmShowing.value = false
      const resolve = globalSnapshotConfirmResolve
      globalSnapshotConfirmResolve = undefined
      resolve?.(confirmed)
    }

    function toggleGlobalSnapshotScanTarget(key: string, checked: boolean) {
      if (checked) {
        globalSnapshotScanTargetKeys.value = [...new Set([...globalSnapshotScanTargetKeys.value, key])]
        return
      }
      globalSnapshotScanTargetKeys.value = globalSnapshotScanTargetKeys.value.filter((item) => item !== key)
    }

    async function confirmGlobalSnapshotScan(mode: GlobalSnapshotScanConfirmMode = 'scan') {
      if (globalSnapshotConfirmShowing.value) {
        return false
      }
      globalSnapshotConfirmMode.value = mode
      globalSnapshotScanMode.value = 'conservative'
      globalSnapshotConfirmShowing.value = true
      return new Promise<boolean>((resolve) => {
        globalSnapshotConfirmResolve = resolve
      })
    }

    async function scanGlobalSnapshot(
      resumeMeta?: GlobalSnapshotMeta,
      mode: GlobalSnapshotScanConfirmMode = resumeMeta === undefined ? 'scan' : 'resume',
    ) {
      if (!(await confirmGlobalSnapshotScan(mode))) {
        return undefined
      }
      const targets =
        resumeMeta !== undefined
          ? [snapshotScanTargetFromMeta(resumeMeta)]
          : globalSnapshotScanTargetKeys.value
              .map((key) => snapshotScanTargetFromKey(key))
              .filter((target): target is SnapshotScanTarget => target !== undefined)
      if (targets.length === 0) {
        message.warning('請至少勾選一個要掃描的分類')
        return undefined
      }
      let lastMeta: GlobalSnapshotMeta | undefined
      for (const target of targets) {
        const updateBaseMeta =
          mode === 'update'
            ? (resumeMeta !== undefined ? resumeMeta : findLatestCompletedGlobalSnapshotForTarget(target))
            : undefined
        if (mode === 'update' && updateBaseMeta === undefined) {
          message.warning(`${target.label}沒有可更新的 100% 快照，請先載入或完成掃描`)
          continue
        }
        let meta: GlobalSnapshotMeta | undefined
        try {
          meta = await scanGlobalSnapshotTarget(target, mode === 'update' ? undefined : resumeMeta, updateBaseMeta, {
            openTabOnComplete: mode !== 'resume',
          })
        } catch (err) {
          console.error(err)
          clearGlobalSnapshotProgress()
          message.error(`${target.label}快照掃描發生錯誤，將保留已保存內容並繼續後續分類`)
        }
        if (meta !== undefined) {
          lastMeta = meta
        }
        if (globalSnapshotCancelled || resumeMeta !== undefined) {
          break
        }
      }
      return lastMeta
    }

    async function scanGlobalSnapshotTarget(
      target: SnapshotScanTarget,
      resumeMeta?: GlobalSnapshotMeta,
      updateBaseMeta?: GlobalSnapshotMeta,
      options?: { openTabOnComplete?: boolean },
    ) {
      const openTabOnComplete = options?.openTabOnComplete !== false
      globalSnapshotCancelled = false
      globalSnapshotScanningLabel.value = updateBaseMeta === undefined ? `${target.label}快照` : `${target.label}更新快照`
      globalSnapshotStartedAt.value = Date.now()
      globalSnapshotElapsedTick.value = globalSnapshotStartedAt.value
      startGlobalSnapshotElapsedTimer()
      globalSnapshotScanProgress.value = {
        current: 0,
        total: 1,
        matchedCount: 0,
        successPages: 0,
        failedAttempts: 0,
        queuedRetryPages: 0,
        retrySuccessPages: 0,
      }
      const shouldStop = () => globalSnapshotCancelled

      async function fetchGlobalSnapshotPageForScan(page: number) {
        return (await fetchSnapshotScanTargetPage(target, page)).data
      }

      async function fetchFirstGlobalSnapshotPageForScan() {
        let failedAttempts = 0
        while (!shouldStop()) {
          const result = await fetchSnapshotScanTargetPage(target, 1)
          if (result.data !== undefined) {
            globalSnapshotPauseReason.value = null
            return result.data
          }
          if (shouldStop()) {
            return undefined
          }
          failedAttempts += 1
          globalSnapshotScanProgress.value = {
            current: 0,
            total: 1,
            matchedCount: 0,
            successPages: 0,
            failedAttempts,
            queuedRetryPages: 1,
            retrySuccessPages: 0,
          }
          const reason = result.reason ?? '未知錯誤'
          const challenged = isCloudflareChallengeFailure(reason)
          const cooldownSeconds = challenged || failedAttempts > 3 ? 20 : randomInt(3, 8)
          for (let remaining = cooldownSeconds; remaining >= 1; remaining -= 1) {
            if (shouldStop()) {
              return undefined
            }
            globalSnapshotPauseReason.value = challenged
              ? `取得${target.label}第 1 頁遇到 Cloudflare 挑戰，請換 IP 或等待 ${remaining} 秒後重試`
              : `取得${target.label}第 1 頁失敗 ${failedAttempts} 次，緩衝 ${remaining} 秒後重試`
            await sleep(1000)
          }
        }
        return undefined
      }

      const firstPage = await fetchFirstGlobalSnapshotPageForScan()
      if (firstPage === undefined) {
        clearGlobalSnapshotProgress()
        if (!shouldStop()) {
          message.error(`${target.label}快照掃描失敗`)
        }
        return undefined
      }
      let firstPageResult = firstPage

      let totalPages = scanPageCountFromResult(firstPage)
      let expectedTotalCount = effectiveTotalCount(firstPage)
      const resumeRecord = resumeMeta === undefined ? undefined : await getGlobalSnapshotRecord(resumeMeta.id)
      const updateRecord = updateBaseMeta === undefined ? undefined : await getGlobalSnapshotRecord(updateBaseMeta.id)
      if (resumeMeta !== undefined && resumeRecord === undefined) {
        clearGlobalSnapshotProgress()
        message.error('找不到要接續的快照內容')
        return undefined
      }
      if (updateBaseMeta !== undefined && updateRecord === undefined) {
        clearGlobalSnapshotProgress()
        message.error(`找不到要更新的${target.label}快照內容`)
        return undefined
      }
      let batchComics: ComicInSearch[] = []
      let persistedSnapshotMeta: GlobalSnapshotMeta | null = updateBaseMeta ?? resumeMeta ?? null
      let persistedComicCount = updateRecord?.comics.length ?? resumeRecord?.comics.length ?? 0
      const completedPages = completedPagesFromSnapshotMeta(resumeMeta, totalPages)
      let persistedCompletedPageCount = completedPages.size
      const resumeStartPage = highestUncompletedPage(totalPages, completedPages)
      let failedPageAttempts = 0
      let consecutiveFailedAttempts = 0
      let retrySuccessPages = 0
      let retryMode = false
      let selfCheckHint: string | null = null
      const pageFailAttempts = new Map<number, number>()
      const comicIdToPage = new Map<number, number>()
      for (const comic of resumeRecord?.comics ?? []) {
        comicIdToPage.set(comic.id, 0)
      }
      for (const comic of updateRecord?.comics ?? []) {
        comicIdToPage.set(comic.id, 0)
      }
      globalSnapshotScanProgress.value = {
        current: completedPages.size,
        total: totalPages,
        matchedCount: persistedComicCount,
        successPages: completedPages.size,
        failedAttempts: failedPageAttempts,
        queuedRetryPages: 0,
        retrySuccessPages,
        selfCheckHint,
      }

      const retryQueuedPages = new Set<number>()
      const updateGlobalSnapshotProgress = () => {
        globalSnapshotScanProgress.value = {
          current: completedPages.size,
          total: totalPages,
          matchedCount: persistedComicCount + batchComics.length,
          successPages: completedPages.size,
          failedAttempts: failedPageAttempts,
          queuedRetryPages: retryQueuedPages.size,
          retrySuccessPages,
          selfCheckHint,
        }
      }
      updateGlobalSnapshotProgress()

      function getPageFailAttempts(page: number) {
        return pageFailAttempts.get(page) ?? 0
      }

      function bumpPageFailAttempts(page: number) {
        pageFailAttempts.set(page, getPageFailAttempts(page) + 1)
      }

      function appendPageResultInternal(page: number, result: SearchResult) {
        if (completedPages.has(page)) {
          return
        }
        mergeComicsInto(batchComics, result.comics)
        for (const comic of result.comics) {
          comicIdToPage.set(comic.id, page)
        }
        completedPages.add(page)
        retryQueuedPages.delete(page)
        pageFailAttempts.delete(page)
        consecutiveFailedAttempts = 0
        if (retryMode) {
          retrySuccessPages += 1
        }
        updateGlobalSnapshotProgress()
      }

      function acceptValidatedPageResult(page: number, result: SearchResult | undefined) {
        if (result === undefined) {
          return false
        }
        const attempts = getPageFailAttempts(page)
        if (!isUsableSnapshotPageResult(result, page, totalPages, attempts)) {
          bumpPageFailAttempts(page)
          selfCheckHint = `第 ${page} 頁回應異常（回傳頁碼 ${result.currentPage}，${result.comics.length} 本）`
          updateGlobalSnapshotProgress()
          queueRetryPage(page)
          return false
        }
        for (const comic of result.comics) {
          const prevPage = comicIdToPage.get(comic.id)
          if (prevPage !== undefined && prevPage !== 0 && prevPage !== page) {
            bumpPageFailAttempts(page)
            selfCheckHint = `第 ${page} 頁與第 ${prevPage} 頁 ID ${comic.id} 重複，重試中`
            updateGlobalSnapshotProgress()
            queueRetryPage(page)
            return false
          }
        }
        appendPageResultInternal(page, result)
        return true
      }

      function appendPageResult(page: number, result: SearchResult) {
        acceptValidatedPageResult(page, result)
      }

      function queueRetryPage(page: number) {
        if (page >= 1 && page <= totalPages && !completedPages.has(page)) {
          failedPageAttempts += 1
          consecutiveFailedAttempts += 1
          retryQueuedPages.add(page)
          updateGlobalSnapshotProgress()
        }
      }

      function takeRetryPages() {
        const pages = [...retryQueuedPages].sort((a, b) => b - a)
        retryQueuedPages.clear()
        return pages
      }

      async function flushGlobalSnapshotBatch() {
        if (batchComics.length === 0 && completedPages.size === persistedCompletedPageCount) {
          return persistedSnapshotMeta
        }
        if (persistedSnapshotMeta === null && batchComics.length === 0) {
          return persistedSnapshotMeta
        }
        const completed = completedPages.size
        let completionPercent = totalPages > 0 ? (completed / totalPages) * 100 : 100
        if (totalPages > 0 && completed < totalPages) {
          completionPercent = Math.min(99, completionPercent)
        } else {
          completionPercent = 100
        }
        let scanCompletedPages = completed
        let scanCompletedPageRanges = pageRangesFromSet(completedPages)
        const updateBaseWasComplete =
          updateBaseMeta !== undefined && isSnapshotScanComplete(updateBaseMeta)
        if (updateBaseWasComplete) {
          completionPercent = 100
          scanCompletedPages = totalPages
          scanCompletedPageRanges = totalPages > 0 ? [{ start: 1, end: totalPages }] : []
        }
        const comicsToSave = batchComics
        batchComics = []
        persistedSnapshotMeta = await upsertGlobalSnapshot(
          persistedSnapshotMeta,
          target,
          comicsToSave,
          totalPages,
          completionPercent,
          scanCompletedPages,
          scanCompletedPageRanges,
        )
        persistedComicCount = persistedSnapshotMeta.totalCount
        persistedCompletedPageCount = completedPages.size
        updateGlobalSnapshotProgress()
        return persistedSnapshotMeta
      }

      async function fetchPageResult(page: number) {
        if (shouldStop()) {
          return undefined
        }
        const result = await fetchGlobalSnapshotPageForScan(page)
        if (result === undefined || shouldStop()) {
          return undefined
        }
        return result
      }

      function appendFirstPage() {
        appendPageResult(1, firstPageResult)
      }

      async function collectParallelPages(startPage: number, endPage: number) {
        if (startPage > endPage || shouldStop()) {
          return !shouldStop()
        }
        const pageResults = await Promise.all(
          Array.from({ length: endPage - startPage + 1 }, (_, index) => {
            const page = startPage + index
            return fetchPageResult(page).then((result) => ({ page, result }))
          }),
        )
        if (shouldStop()) {
          return false
        }
        pageResults
          .sort((a, b) => b.page - a.page)
          .forEach(({ page, result }) => {
            if (result === undefined) {
              queueRetryPage(page)
              return
            }
            appendPageResult(page, result)
          })
        return !shouldStop()
      }

      async function collectAggressivePages(pages: number[]) {
        const failedPages = new Set<number>()
        let challenged = false

        if (shouldStop()) {
          return { challenged, failedPages: [] }
        }
        const pageResults = await Promise.all(
          pages.map(async (page) => {
            if (shouldStop()) {
              return { page, result: undefined, failure: undefined }
            }
            const result = await fetchSnapshotScanTargetPage(target, page)
            if (result.data === undefined) {
              const failure = result.reason === undefined ? undefined : { reason: result.reason }
              return { page, result: undefined, failure }
            }
            return { page, result: result.data, failure: undefined }
          }),
        )

        if (shouldStop()) {
          return { challenged, failedPages: [] }
        }

        pageResults
          .filter(({ result }) => result !== undefined)
          .sort((a, b) => b.page - a.page)
          .forEach(({ page, result }) => {
            appendPageResult(page, result as SearchResult)
          })

        for (const item of pageResults) {
          if (item.result === undefined) {
            queueRetryPage(item.page)
            if (item.failure !== undefined && isCloudflareChallengeFailure(item.failure.reason)) {
              failedPages.add(item.page)
              challenged = true
            }
          }
        }
        if (challenged) {
          globalSnapshotPauseReason.value = '已被 Cloudflare 挑戰，請換 IP 或等待'
        }

        return {
          challenged,
          failedPages: [...failedPages].sort((a, b) => b - a),
        }
      }

      async function collectPacedPages(startPage: number, endPage: number) {
        for (let page = endPage; page >= startPage; page--) {
          const continued = await sleepUnlessCancelled(randomInt(500, 1500), shouldStop)
          if (!continued || shouldStop()) {
            return false
          }
          const result = await fetchPageResult(page)
          if (result === undefined) {
            if (shouldStop()) {
              return false
            }
            queueRetryPage(page)
            continue
          }
          appendPageResult(page, result)
        }
        return true
      }

      async function waitGlobalManualRequest(startPage: number, endPage: number) {
        globalSnapshotManualRequest.value = { startPage, endPage }
        await new Promise<void>((resolve) => {
          globalSnapshotManualRequestResolve = resolve
        })
        globalSnapshotManualRequest.value = null
        globalSnapshotPauseReason.value = null
        globalSnapshotManualRequestResolve = undefined
        return !shouldStop()
      }

      async function waitAggressiveBatchSend(pages: number[]) {
        if (pages.length === 0) {
          return true
        }
        // 快照掃描激進模式：自動發送；僅 Cloudflare 挑戰時才 waitGlobalManualRequest
        if (globalSnapshotScanMode.value === 'aggressive') {
          return !shouldStop()
        }
        const startPage = Math.min(...pages)
        const endPage = Math.max(...pages)
        return await waitGlobalManualRequest(startPage, endPage)
      }

      async function waitConsecutiveFailureCooldown() {
        if (globalSnapshotScanMode.value === 'aggressive') {
          return !shouldStop()
        }
        if (consecutiveFailedAttempts <= 3) {
          return true
        }
        for (let remaining = 20; remaining >= 1; remaining -= 1) {
          if (shouldStop()) {
            return false
          }
          globalSnapshotPauseReason.value = `連續請求失敗 ${consecutiveFailedAttempts} 次，緩衝 ${remaining} 秒後繼續`
          updateGlobalSnapshotProgress()
          await sleep(1000)
        }
        globalSnapshotPauseReason.value = null
        consecutiveFailedAttempts = 0
        updateGlobalSnapshotProgress()
        return !shouldStop()
      }

      async function drainRetryQueue() {
        while (retryQueuedPages.size > 0 && !shouldStop()) {
          const pages = takeRetryPages()
          if (pages.length === 0) {
            return true
          }
          if (globalSnapshotScanMode.value === 'conservative') {
            retryMode = true
            let useParallel = Math.random() >= 0.5
            try {
              while (pages.length > 0 && !shouldStop()) {
                const span = useParallel ? randomInt(30, 40) : randomInt(10, 30)
                const batch = pages.splice(0, span)
                if (batch.length === 0) {
                  break
                }
                if (useParallel) {
                  const pageResults = await Promise.all(
                    batch.map(async (page) => ({ page, result: await fetchPageResult(page) })),
                  )
                  if (shouldStop()) {
                    break
                  }
                  pageResults
                    .sort((a, b) => b.page - a.page)
                    .forEach(({ page, result }) => {
                      if (result === undefined) {
                        queueRetryPage(page)
                        return
                      }
                      appendPageResult(page, result)
                    })
                } else {
                  for (const page of batch) {
                    if (shouldStop()) {
                      break
                    }
                    const result = await fetchPageResult(page)
                    if (result === undefined) {
                      if (shouldStop()) {
                        break
                      }
                      queueRetryPage(page)
                      continue
                    }
                    appendPageResult(page, result)
                  }
                }
                await flushGlobalSnapshotBatch()
                if (!(await waitConsecutiveFailureCooldown())) {
                  return false
                }
                useParallel = !useParallel
              }
            } finally {
              retryMode = false
            }
            continue
          }
          retryMode = true
          let outcome: Awaited<ReturnType<typeof collectAggressivePages>>
          try {
            if (!(await waitAggressiveBatchSend(pages))) {
              return false
            }
            outcome = await collectAggressivePages(pages)
          } finally {
            retryMode = false
          }
          await flushGlobalSnapshotBatch()
          if (outcome.challenged) {
            const startPage = Math.min(...outcome.failedPages)
            const endPage = Math.max(...outcome.failedPages)
            if (!(await waitGlobalManualRequest(startPage, endPage))) {
              return false
            }
            continue
          }
          if (!(await waitConsecutiveFailureCooldown())) {
            return false
          }
        }
        return !shouldStop()
      }

      async function runLocalSnapshotSelfCheck(requireFullPages: boolean) {
        const integrity = validateSnapshotScanIntegrity({
          targetLabel: target.label,
          totalPages,
          expectedTotalCount,
          completedPages,
          retryQueuedPages,
          uniqueComicCount: comicIdToPage.size,
          requireFullPages,
        })
        if (!integrity.ok) {
          return integrity
        }
        if (persistedSnapshotMeta === null) {
          return { ok: true as const }
        }
        const record = await getGlobalSnapshotRecord(persistedSnapshotMeta.id)
        if (record === undefined) {
          return { ok: false as const, message: `${target.label} 收尾驗證：找不到快照內容` }
        }
        const sorted = sortComicsForSnapshotArchive(record.comics)
        return validateSnapshotComicIdOrder(sorted)
      }

      async function ensureSnapshotIdSorted(meta: GlobalSnapshotMeta) {
        const record = await getGlobalSnapshotRecord(meta.id)
        if (record === undefined) {
          return meta
        }
        const sorted = sortComicsForSnapshotArchive(record.comics)
        const orderCheck = validateSnapshotComicIdOrder(sorted)
        if (!orderCheck.ok) {
          message.warning(orderCheck.message)
        }
        if (
          sorted.length === record.comics.length &&
          sorted.every((comic, index) => comic.id === record.comics[index]?.id)
        ) {
          return meta
        }
        await putGlobalSnapshotRecord({ id: meta.id, comics: sorted })
        const updatedMeta: GlobalSnapshotMeta = { ...meta, totalCount: sorted.length }
        globalSnapshotMetas.value = [
          updatedMeta,
          ...globalSnapshotMetas.value.filter((item) => item.id !== updatedMeta.id),
        ]
        saveGlobalSnapshotMetas()
        return updatedMeta
      }

      async function appendFreshFirstPage() {
        if (globalSnapshotScanMode.value === 'aggressive') {
          if (!(await waitAggressiveBatchSend([1]))) {
            return false
          }
        }
        const result = await fetchPageResult(1)
        if (result === undefined) {
          queueRetryPage(1)
          return false
        }
        firstPageResult = result
        const refreshedTotal = scanPageCountFromResult(result)
        const refreshedCount = effectiveTotalCount(result)
        if (refreshedTotal > totalPages) {
          selfCheckHint = `官網總頁數更新為 ${refreshedTotal}（原 ${totalPages}）`
          totalPages = refreshedTotal
        }
        if (refreshedCount > expectedTotalCount) {
          expectedTotalCount = refreshedCount
        }
        completedPages.delete(1)
        for (const comic of result.comics) {
          if (comicIdToPage.get(comic.id) === 1) {
            comicIdToPage.delete(comic.id)
          }
        }
        acceptValidatedPageResult(1, result)
        updateGlobalSnapshotProgress()
        return true
      }

      async function fillMissingSnapshotPages() {
        if (!(await appendFreshFirstPage())) {
          return false
        }
        let guard = 0
        while (!shouldStop() && guard < 20_000) {
          guard += 1
          const missing = missingSnapshotPagesInRange(completedPages, 1, totalPages)
          if (missing.length === 0) {
            break
          }
          selfCheckHint = `補缺頁：尚有 ${missing.length} 頁`
          updateGlobalSnapshotProgress()
          missing.sort((a, b) => b - a)
          const batchSize = globalSnapshotScanMode.value === 'aggressive' ? Math.min(30, missing.length) : 1
          const batch = missing.slice(0, batchSize)
          if (globalSnapshotScanMode.value === 'aggressive') {
            if (!(await waitAggressiveBatchSend(batch))) {
              return false
            }
            const outcome = await collectAggressivePages(batch)
            await flushGlobalSnapshotBatch()
            if (outcome.challenged) {
              const cfPages = outcome.failedPages.length > 0 ? outcome.failedPages : batch
              if (!(await waitGlobalManualRequest(Math.min(...cfPages), Math.max(...cfPages)))) {
                return false
              }
              continue
            }
            if (!(await waitConsecutiveFailureCooldown())) {
              return false
            }
          } else {
            for (const page of batch) {
              if (shouldStop()) {
                return false
              }
              if (page === 1) {
                if (!(await appendFreshFirstPage())) {
                  return false
                }
                continue
              }
              const continued = await sleepUnlessCancelled(randomInt(500, 1500), shouldStop)
              if (!continued || shouldStop()) {
                return false
              }
              const result = await fetchPageResult(page)
              if (result === undefined) {
                queueRetryPage(page)
                continue
              }
              acceptValidatedPageResult(page, result)
            }
            await flushGlobalSnapshotBatch()
            if (!(await waitConsecutiveFailureCooldown())) {
              return false
            }
          }
          if (!(await drainRetryQueue())) {
            return false
          }
        }
        return !shouldStop()
      }

      async function finalizeSnapshotScan(requireFullPages: boolean) {
        globalSnapshotScanningLabel.value = `${target.label}收尾驗證`
        selfCheckHint = '本地自檢中（不發請求）'
        updateGlobalSnapshotProgress()
        let check = await runLocalSnapshotSelfCheck(requireFullPages)
        if (!check.ok) {
          message.info(check.message)
        }

        if (requireFullPages && !shouldStop()) {
          globalSnapshotScanningLabel.value = `${target.label}補缺頁`
          await fillMissingSnapshotPages()
          await flushGlobalSnapshotBatch()
        }

        globalSnapshotScanningLabel.value = `${target.label}ID 排序校對`
        selfCheckHint = '依 ID 由大到小排序存檔（頂部較新）'
        updateGlobalSnapshotProgress()
        if (persistedSnapshotMeta !== null) {
          persistedSnapshotMeta = await ensureSnapshotIdSorted(persistedSnapshotMeta)
          if (requireFullPages && completedPages.size >= totalPages) {
            persistedSnapshotMeta = await upsertGlobalSnapshot(
              persistedSnapshotMeta,
              target,
              [],
              totalPages,
              100,
              completedPages.size,
              pageRangesFromSet(completedPages),
            )
          }
        }

        check = await runLocalSnapshotSelfCheck(requireFullPages)
        selfCheckHint = check.ok ? '收尾完成' : check.message
        updateGlobalSnapshotProgress()
        if (!check.ok) {
          message.warning(check.message)
        } else {
          message.success(`${target.label}收尾驗證通過`)
        }
        return check.ok
      }

      async function collectAggressiveUpdatePages(pages: number[]) {
        const failedPages = new Set<number>()
        let challenged = false
        const results = new Map<number, SearchResult>()

        if (shouldStop()) {
          return { challenged, failedPages: [] as number[], results }
        }

        const pageResults = await Promise.all(
          pages.map(async (page) => {
            if (shouldStop()) {
              return { page, result: undefined, failure: undefined }
            }
            const result = await fetchSnapshotScanTargetPage(target, page)
            if (result.data === undefined) {
              const failure = result.reason === undefined ? undefined : { reason: result.reason }
              return { page, result: undefined, failure }
            }
            return { page, result: result.data, failure: undefined }
          }),
        )

        if (shouldStop()) {
          return { challenged, failedPages: [] as number[], results }
        }

        for (const item of pageResults) {
          if (item.result !== undefined) {
            results.set(item.page, item.result)
            retryQueuedPages.delete(item.page)
            continue
          }
          queueRetryPage(item.page)
          failedPages.add(item.page)
          if (item.failure !== undefined && isCloudflareChallengeFailure(item.failure.reason)) {
            challenged = true
          }
        }

        if (challenged) {
          globalSnapshotPauseReason.value = '已被 Cloudflare 挑戰，請換 IP 或等待'
        }

        return {
          challenged,
          failedPages: [...failedPages].sort((a, b) => a - b),
          results,
        }
      }

      async function fetchUpdatePageForScan(page: number): Promise<SearchResult | undefined> {
        while (!shouldStop()) {
          const response = await fetchSnapshotScanTargetPage(target, page)
          if (response.data !== undefined) {
            retryQueuedPages.delete(page)
            consecutiveFailedAttempts = 0
            return response.data
          }
          if (shouldStop()) {
            return undefined
          }
          queueRetryPage(page)
          const challenged =
            response.reason !== undefined && isCloudflareChallengeFailure(response.reason)
          if (challenged) {
            globalSnapshotPauseReason.value = '已被 Cloudflare 挑戰，請換 IP 或等待'
            for (let remaining = 20; remaining >= 1; remaining -= 1) {
              if (shouldStop()) {
                return undefined
              }
              globalSnapshotPauseReason.value = `已被 Cloudflare 挑戰，${remaining} 秒後重試第 ${page} 頁`
              updateGlobalSnapshotProgress()
              await sleep(1000)
            }
            globalSnapshotPauseReason.value = null
            continue
          }
          if (!(await waitConsecutiveFailureCooldown())) {
            return undefined
          }
        }
        return undefined
      }

      async function runSnapshotUpdateScan() {
        if (updateBaseMeta === undefined || updateRecord === undefined) {
          return undefined
        }
        const knownComicIds = new Set(updateRecord.comics.map((comic) => comic.id))
        const addedComicIds = new Set<number>()
        let duplicateIdCount = 0

        function appendUpdatePageResult(page: number, result: SearchResult) {
          if (completedPages.has(page)) {
            return
          }
          const newComics: ComicInSearch[] = []
          for (const comic of result.comics) {
            if (knownComicIds.has(comic.id)) {
              duplicateIdCount += 1
              continue
            }
            if (!addedComicIds.has(comic.id)) {
              addedComicIds.add(comic.id)
              newComics.push(comic)
            }
          }
          mergeComicsInto(batchComics, newComics)
          for (const comic of newComics) {
            comicIdToPage.set(comic.id, page)
          }
          completedPages.add(page)
          retryQueuedPages.delete(page)
          consecutiveFailedAttempts = 0
          updateGlobalSnapshotProgress()
        }

        function applyUpdatePageResultsInOrder(pages: number[], results: Map<number, SearchResult>) {
          for (const pageNum of pages) {
            if (duplicateIdCount > duplicateStopLimit) {
              return false
            }
            const result = results.get(pageNum)
            if (result !== undefined) {
              appendUpdatePageResult(pageNum, result)
            }
          }
          return duplicateIdCount <= duplicateStopLimit
        }

        appendUpdatePageResult(1, firstPageResult)
        const duplicateStopLimit = globalSnapshotIdUpdateDuplicateLimit.value

        async function collectUpdatePacedPages(startPage: number, endPage: number) {
          for (let scanPage = startPage; scanPage <= endPage; scanPage += 1) {
            if (duplicateIdCount > duplicateStopLimit || shouldStop()) {
              return false
            }
            const continued = await sleepUnlessCancelled(randomInt(500, 1500), shouldStop)
            if (!continued || shouldStop()) {
              return false
            }
            const result = await fetchUpdatePageForScan(scanPage)
            if (result === undefined) {
              if (shouldStop()) {
                return false
              }
              continue
            }
            appendUpdatePageResult(scanPage, result)
            if (duplicateIdCount > duplicateStopLimit) {
              return false
            }
          }
          return true
        }

        async function collectUpdateParallelPages(startPage: number, endPage: number) {
          if (startPage > endPage || shouldStop()) {
            return !shouldStop()
          }
          const pages = Array.from({ length: endPage - startPage + 1 }, (_, index) => startPage + index)
          const pageResults = await Promise.all(
            pages.map(async (scanPage) => ({
              page: scanPage,
              result: await fetchUpdatePageForScan(scanPage),
            })),
          )
          if (shouldStop()) {
            return false
          }
          for (const { page: scanPage, result } of pageResults.sort((a, b) => a.page - b.page)) {
            if (duplicateIdCount > duplicateStopLimit) {
              return false
            }
            if (result === undefined) {
              continue
            }
            appendUpdatePageResult(scanPage, result)
            if (duplicateIdCount > duplicateStopLimit) {
              return false
            }
          }
          return !shouldStop()
        }

        if (globalSnapshotScanMode.value === 'aggressive') {
          let page = 2
          let retryPages: number[] = []
          let skipNextAggressiveBatchSend = false
          while (page <= totalPages && duplicateIdCount <= duplicateStopLimit && !shouldStop()) {
            const isRetryBatch = retryPages.length > 0
            const batchSize = isRetryBatch ? retryPages.length : randomInt(100, 200)
            const startPage = isRetryBatch ? Math.min(...retryPages) : page
            const endPage = isRetryBatch ? Math.max(...retryPages) : Math.min(totalPages, page + batchSize - 1)
            const pagesToScan = isRetryBatch
              ? retryPages
              : Array.from({ length: endPage - startPage + 1 }, (_, index) => startPage + index)
            retryPages = []

            if (pagesToScan.length === 0) {
              break
            }

            if (skipNextAggressiveBatchSend) {
              skipNextAggressiveBatchSend = false
            } else if (!(await waitAggressiveBatchSend(pagesToScan))) {
              break
            }

            const outcome = await collectAggressiveUpdatePages(pagesToScan)
            const orderedPages = [...pagesToScan].sort((a, b) => a - b)
            if (!applyUpdatePageResultsInOrder(orderedPages, outcome.results)) {
              break
            }
            await flushGlobalSnapshotBatch()

            if (outcome.challenged) {
              const cfPages = outcome.failedPages.length > 0 ? outcome.failedPages : pagesToScan
              if (!(await waitGlobalManualRequest(Math.min(...cfPages), Math.max(...cfPages)))) {
                break
              }
              skipNextAggressiveBatchSend = true
              retryPages = outcome.failedPages.filter((item) => !completedPages.has(item))
              continue
            }
            if (!(await waitConsecutiveFailureCooldown())) {
              break
            }

            if (outcome.failedPages.length > 0) {
              retryPages = outcome.failedPages.filter((item) => !completedPages.has(item))
              continue
            }

            page = endPage + 1
          }
        } else {
          let page = 2
          let useParallel = false
          while (page <= totalPages && duplicateIdCount <= duplicateStopLimit && !shouldStop()) {
            const span = useParallel ? randomInt(30, 40) : randomInt(10, 30)
            const endPage = Math.min(totalPages, page + span - 1)
            const completedBatch = useParallel
              ? await collectUpdateParallelPages(page, endPage)
              : await collectUpdatePacedPages(page, endPage)
            if (!completedBatch || duplicateIdCount > duplicateStopLimit) {
              break
            }
            await flushGlobalSnapshotBatch()
            if (!(await waitConsecutiveFailureCooldown())) {
              break
            }
            page = endPage + 1
            useParallel = !useParallel
          }
        }
        await flushGlobalSnapshotBatch()
        if (shouldStop()) {
          clearGlobalSnapshotProgress()
          return updateBaseMeta
        }
        const updateBaseWasComplete = isSnapshotScanComplete(updateBaseMeta)
        const comicsToSave = batchComics
        batchComics = []
        persistedSnapshotMeta = await upsertGlobalSnapshot(
          updateBaseMeta,
          target,
          comicsToSave,
          totalPages,
          updateBaseWasComplete ? 100 : clampScanCompletionPercent((completedPages.size / Math.max(totalPages, 1)) * 100),
          updateBaseWasComplete ? totalPages : completedPages.size,
          updateBaseWasComplete && totalPages > 0
            ? [{ start: 1, end: totalPages }]
            : pageRangesFromSet(completedPages),
        )
        await finalizeSnapshotScan(false)
        const finalizedMeta = persistedSnapshotMeta ?? updateBaseMeta
        clearGlobalSnapshotProgress()
        if (shouldStop()) {
          return finalizedMeta
        }
        if (addedComicIds.size === 0) {
          if (isSnapshotScanComplete(finalizedMeta)) {
            await finishGlobalSnapshotWebsiteExport(target, finalizedMeta, {
              addedCount: 0,
              openTabOnComplete,
            })
          } else {
            message.success(`${target.label}快照已是最新，無須更新`)
          }
          return finalizedMeta
        }
        await finishGlobalSnapshotWebsiteExport(target, finalizedMeta, {
          addedCount: addedComicIds.size,
          openTabOnComplete,
        })
        return finalizedMeta
      }

      if (updateBaseMeta !== undefined) {
        return await runSnapshotUpdateScan()
      }

      if (globalSnapshotScanMode.value === 'aggressive') {
        let page = resumeStartPage
        let retryPages: number[] = []
        let skipNextAggressiveBatchSend = false
        while (page >= 1 && !shouldStop()) {
          const isRetryBatch = retryPages.length > 0
          const batchSize = isRetryBatch ? retryPages.length : randomInt(100, 200)
          const startPage = isRetryBatch ? Math.min(...retryPages) : Math.max(1, page - batchSize + 1)
          const endPage = isRetryBatch ? Math.max(...retryPages) : page
          const pagesToScan = isRetryBatch
            ? retryPages
            : Array.from({ length: Math.max(0, endPage - Math.max(2, startPage) + 1) }, (_, index) => endPage - index)
          retryPages = []
          if (pagesToScan.length > 0) {
            if (skipNextAggressiveBatchSend) {
              skipNextAggressiveBatchSend = false
            } else if (!(await waitAggressiveBatchSend(pagesToScan))) {
              break
            }
            const outcome = await collectAggressivePages(pagesToScan)
            retryPages = outcome.failedPages
            await flushGlobalSnapshotBatch()
            if (outcome.challenged) {
              const cfPages = outcome.failedPages.length > 0 ? outcome.failedPages : pagesToScan
              if (!(await waitGlobalManualRequest(Math.min(...cfPages), Math.max(...cfPages)))) {
                break
              }
              skipNextAggressiveBatchSend = true
              continue
            }
            if (!(await waitConsecutiveFailureCooldown())) {
              break
            }
          }
          if (shouldStop()) {
            break
          }
          if (retryPages.length > 0) {
            continue
          }
          if (startPage === 1 && !shouldStop()) {
            appendFirstPage()
            await flushGlobalSnapshotBatch()
          }
          if (!shouldStop()) {
            await drainRetryQueue()
          }
          page = startPage - 1
        }
      } else if (totalPages < 100) {
        if (resumeStartPage > 1 && (await collectParallelPages(2, resumeStartPage))) {
          appendFirstPage()
        } else if (resumeStartPage <= 1 && !shouldStop()) {
          appendFirstPage()
        }
        if (!shouldStop()) {
          await drainRetryQueue()
        }
        await flushGlobalSnapshotBatch()
      } else {
        let page = resumeStartPage
        let useParallel = false
        while (page >= 2 && !shouldStop()) {
          const conservative = globalSnapshotScanMode.value === 'conservative'
          const span = useParallel
            ? randomInt(conservative ? 30 : 40, conservative ? 40 : 50)
            : randomInt(conservative ? 10 : 10, conservative ? 30 : 15)
          const startPage = Math.max(2, page - span + 1)
          const completedBatch = useParallel
            ? await collectParallelPages(startPage, page)
            : await collectPacedPages(startPage, page)
          if (!completedBatch) {
            break
          }
          await flushGlobalSnapshotBatch()
          if (!(await waitConsecutiveFailureCooldown())) {
            break
          }
          page = startPage - 1
          useParallel = !useParallel
        }
        if (page < 2 && !shouldStop()) {
          appendFirstPage()
        }
        if (!shouldStop()) {
          await drainRetryQueue()
        }
        await flushGlobalSnapshotBatch()
      }

      if (!shouldStop()) {
        await flushGlobalSnapshotBatch()
        await finalizeSnapshotScan(true)
      }

      const meta = persistedSnapshotMeta
      clearGlobalSnapshotProgress()
      if (meta === null || meta.totalCount === 0) {
        message.error(`${target.label}快照沒有可保存的資料`)
        return undefined
      }
      if (openTabOnComplete) {
        await loadGlobalSnapshot(meta, true)
      }
      if (isSnapshotScanComplete(meta) && !globalSnapshotCancelled) {
        const websitePath = await exportGlobalSnapshotToWebsite(meta)
        if (websitePath !== null) {
          message.success(`${globalSnapshotLabel(meta)} 已導出至 Website Snapshot（舊檔已刪除）`)
        }
      }
      if (openTabOnComplete) {
        message.success(`已保存 ${globalSnapshotLabel(meta)}`)
      } else {
        message.success(`已保存 ${globalSnapshotLabel(meta)}（未載入分頁，可於收藏快照手動開啟）`)
      }
      return meta
    }

    function openGlobalSnapshotResumeDialog() {
      const candidates = globalSnapshotMetas.value
      if (candidates.length === 0) {
        message.warning('沒有可接續掃描的快照')
        return
      }
      globalSnapshotResumeSelectedIds.value = candidates.map((item) => item.id)
      globalSnapshotResumeStrategy.value = 'page'
      globalSnapshotResumeShowing.value = true
    }

    function toggleGlobalSnapshotResumeSelection(id: string, checked: boolean) {
      if (checked) {
        globalSnapshotResumeSelectedIds.value = [...new Set([...globalSnapshotResumeSelectedIds.value, id])]
        return
      }
      globalSnapshotResumeSelectedIds.value = globalSnapshotResumeSelectedIds.value.filter((item) => item !== id)
    }

    function setGlobalSnapshotResumeSelectAll(checked: boolean) {
      globalSnapshotResumeSelectedIds.value = checked ? globalSnapshotMetas.value.map((item) => item.id) : []
    }

    const globalSnapshotResumeAllSelected = computed(() => {
      const total = globalSnapshotMetas.value.length
      if (total === 0) {
        return false
      }
      return globalSnapshotResumeSelectedIds.value.length === total
    })

    const globalSnapshotResumeSelectIndeterminate = computed(() => {
      const selected = globalSnapshotResumeSelectedIds.value.length
      const total = globalSnapshotMetas.value.length
      return selected > 0 && selected < total
    })

    const globalSnapshotResumeHasIncompleteSelection = computed(() =>
      globalSnapshotMetas.value.some(
        (snapshot) =>
          globalSnapshotResumeSelectedIds.value.includes(snapshot.id) && !isSnapshotScanComplete(snapshot),
      ),
    )

    async function resumeGlobalSnapshotsInQueue() {
      const snapshots = globalSnapshotResumeSelectedIds.value
        .map((id) => globalSnapshotMetas.value.find((item) => item.id === id))
        .filter((item): item is GlobalSnapshotMeta => item !== undefined)
      if (snapshots.length === 0) {
        message.warning('請至少選擇一個要接續的快照')
        return undefined
      }

      const strategy = globalSnapshotResumeStrategy.value
      let lastMeta: GlobalSnapshotMeta | undefined
      let completedCount = 0

      for (let index = 0; index < snapshots.length; index++) {
        if (globalSnapshotCancelled) {
          break
        }
        const snapshot = snapshots[index]
        const target = snapshotScanTargetFromMeta(snapshot)
        const mode = isSnapshotScanComplete(snapshot) || strategy === 'idUpdate' ? 'update' : 'resume'
        const updateBaseMeta = mode === 'update' ? snapshot : undefined

        if (snapshots.length > 1) {
          message.info(`排隊接續掃描 ${index + 1}/${snapshots.length}：${globalSnapshotLabel(snapshot)}`)
        }

        try {
          const meta = await scanGlobalSnapshotTarget(
            target,
            mode === 'update' ? undefined : snapshot,
            updateBaseMeta,
            { openTabOnComplete: false },
          )
          if (meta !== undefined) {
            lastMeta = meta
            completedCount += 1
          }
        } catch (err) {
          console.error(err)
          clearGlobalSnapshotProgress()
          message.error(`${target.label}快照掃描發生錯誤，將繼續下一項`)
        }
      }

      if (snapshots.length > 1) {
        if (completedCount > 0) {
          message.success(`排隊接續掃描完成 ${completedCount}/${snapshots.length} 項`)
        } else if (!globalSnapshotCancelled) {
          message.warning('排隊接續掃描未成功完成任何項目')
        }
      }
      return lastMeta
    }

    function resolveGlobalSnapshotResume(confirmed: boolean) {
      if (!confirmed) {
        globalSnapshotResumeShowing.value = false
        return
      }
      if (globalSnapshotResumeSelectedIds.value.length === 0) {
        message.warning('請至少選擇一個要接續的快照')
        return
      }
      globalSnapshotResumeShowing.value = false
      store.currentTabName = 'search'
      prepareGlobalSnapshotResumeScan()
      message.info('正在開始接續掃描…')
      void runExclusiveSearch(async () => {
        await resumeGlobalSnapshotsInQueue()
      })
    }

    function saveActiveScopedScanCache() {
      if (!isScopedSearchActive.value || scopedOfflineMatches.value.length === 0) {
        return
      }
      const source = searchSource.value
      const categoryLabel = searchScopeCategory.value?.label ?? activeCategoryLabel.value
      if (categoryLabel === '') {
        return
      }
      const kindLabel: ScopedScanCache['kindLabel'] = source.type === 'tag' ? '標籤詞' : '關鍵詞'
      const queryLabel =
        source.type === 'tag'
          ? activeTagLabel.value || getTagLabelFromSearch(tagOrLinkInput.value, activeTagSearchSource.value)
          : keywordOrComicLinkInput.value.trim()
      if (queryLabel.trim() === '') {
        return
      }
      const tab = captureTabState()
      const cache: ScopedScanCache = {
        id: crypto.randomUUID(),
        savedAt: new Date().toISOString(),
        categoryLabel,
        kindLabel,
        queryLabel: queryLabel.trim(),
        totalCount: scopedOfflineMatches.value.length,
        scanCompletionPercent: currentScanCompletionPercent(),
        scanDirection: 'tailToHead',
        scanCompletedPages: currentScanCompletedPages(),
        tabState: sanitizeTabStateForBookmark(tab),
      }
      scopedScanCaches.value = [
        cache,
        ...scopedScanCaches.value.filter(
          (item) =>
            !(
              item.categoryLabel === cache.categoryLabel &&
              item.kindLabel === cache.kindLabel &&
              item.queryLabel === cache.queryLabel
            ),
        ),
      ]
      saveScopedScanCaches()
    }

    function deleteScopedScanCache(id: string) {
      scopedScanCaches.value = scopedScanCaches.value.filter((item) => item.id !== id)
      saveScopedScanCaches()
      message.success('已刪除收藏快照')
    }

    async function deleteGlobalSnapshot(meta: GlobalSnapshotMeta) {
      await deleteGlobalSnapshotRecord(meta.id).catch((err) => {
        console.error(err)
      })
      globalSnapshotMetas.value = globalSnapshotMetas.value.filter((item) => item.id !== meta.id)
      saveGlobalSnapshotMetas()
      if (activeGlobalSnapshotMeta.value?.id === meta.id) {
        activeGlobalSnapshotMeta.value = null
        activeGlobalSnapshotComics.value = []
        localStorage.removeItem(ACTIVE_GLOBAL_SNAPSHOT_STORAGE_KEY)
      }
      message.success('已刪除全站快照')
    }

    function requestDeleteGlobalSnapshot(event: MouseEvent, snapshot: GlobalSnapshotMeta) {
      event.stopPropagation()
      snapshotDeleteTarget.value = { kind: 'global', snapshot }
    }

    function requestDeleteScopedScanCache(event: MouseEvent, cache: ScopedScanCache) {
      event.stopPropagation()
      snapshotDeleteTarget.value = { kind: 'scoped', cache }
    }

    function closeSnapshotDeleteConfirm() {
      snapshotDeleteTarget.value = null
    }

    function snapshotDeleteConfirmTitle() {
      return snapshotDeleteTarget.value?.kind === 'global' ? '刪除全站快照？' : '刪除分頁快照？'
    }

    function snapshotDeleteConfirmDescription() {
      const target = snapshotDeleteTarget.value
      if (target === null) {
        return ''
      }
      const label = target.kind === 'global' ? globalSnapshotLabel(target.snapshot) : scanCacheLabel(target.cache)
      return `確定要刪除「${label}」嗎？此動作無法復原。`
    }

    async function confirmSnapshotDelete() {
      const target = snapshotDeleteTarget.value
      if (target === null) {
        return
      }
      snapshotDeleteTarget.value = null
      if (target.kind === 'global') {
        await deleteGlobalSnapshot(target.snapshot)
        return
      }
      deleteScopedScanCache(target.cache.id)
    }

    function openScopedScanCache(cache: ScopedScanCache) {
      store.currentTabName = 'search'
      openSearchTabFromState(cache.tabState, { preserveSearchScope: true })
    }

    async function writeSnapshotExport(path: string, exportFile: SnapshotExportFile) {
      const result = await commands.writeSnapshotExportFile(path, JSON.stringify(exportFile, null, 2))
      if (result.status === 'error') {
        console.error(result.error)
        message.error(result.error.err_message)
        return false
      }
      message.success('已導出快照')
      return true
    }

    async function exportGlobalSnapshot(event: MouseEvent, snapshot: GlobalSnapshotMeta) {
      event.stopPropagation()
      const record = await getGlobalSnapshotRecord(snapshot.id)
      if (record === undefined) {
        message.error('找不到全站快照內容，無法導出')
        return
      }
      const selectedPath = await save({
        defaultPath: safeSnapshotExportFilename(globalSnapshotLabel(snapshot)),
        filters: [{ name: 'Gentleman Manager 快照', extensions: ['json'] }],
      })
      if (selectedPath === null) {
        return
      }
      await writeSnapshotExport(ensureSnapshotExportExtension(selectedPath), {
        format: 'gentleman-manager.snapshot.v1',
        exportedAt: new Date().toISOString(),
        snapshot: { kind: 'global', meta: snapshot, comics: record.comics },
      })
    }

    async function exportScopedScanCache(event: MouseEvent, cache: ScopedScanCache) {
      event.stopPropagation()
      const selectedPath = await save({
        defaultPath: safeSnapshotExportFilename(scanCacheLabel(cache)),
        filters: [{ name: 'Gentleman Manager 快照', extensions: ['json'] }],
      })
      if (selectedPath === null) {
        return
      }
      await writeSnapshotExport(ensureSnapshotExportExtension(selectedPath), {
        format: 'gentleman-manager.snapshot.v1',
        exportedAt: new Date().toISOString(),
        snapshot: { kind: 'scoped', cache },
      })
    }

    async function importSnapshotFromPath(
      selectedPath: string,
      options?: { silent?: boolean },
    ): Promise<boolean> {
      const readResult = await commands.readSnapshotExportFile(selectedPath)
      if (readResult.status === 'error') {
        console.error(readResult.error)
        if (!options?.silent) {
          message.error(readResult.error.err_message)
        }
        return false
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(readResult.data)
      } catch (err) {
        console.error(err)
        if (!options?.silent) {
          message.error('快照存檔格式錯誤，無法載入')
        }
        return false
      }
      if (!isSnapshotExportFile(parsed)) {
        if (!options?.silent) {
          message.error('這不是有效的 Gentleman Manager 快照存檔')
        }
        return false
      }

      const snapshot = parsed.snapshot
      if (snapshot.kind === 'global') {
        await putGlobalSnapshotRecord({ id: snapshot.meta.id, comics: snapshot.comics })
        globalSnapshotMetas.value = [
          snapshot.meta,
          ...globalSnapshotMetas.value.filter((item) => item.id !== snapshot.meta.id),
        ]
        saveGlobalSnapshotMetas()
        if (!options?.silent) {
          message.success(`已載入 ${globalSnapshotLabel(snapshot.meta)}`)
        }
        return true
      }

      scopedScanCaches.value = [
        snapshot.cache,
        ...scopedScanCaches.value.filter((item) => item.id !== snapshot.cache.id),
      ]
      saveScopedScanCaches()
      if (!options?.silent) {
        message.success(`已載入 ${scanCacheLabel(snapshot.cache)}`)
      }
      return true
    }

    async function importSnapshotExportFile() {
      const selectedPaths = normalizeDialogPaths(
        await open({
          multiple: true,
          filters: [{ name: 'Gentleman Manager 快照', extensions: ['json'] }],
        }),
      )
      if (selectedPaths.length === 0) {
        return
      }

      const batch = selectedPaths.length > 1
      let loaded = 0
      let failed = 0
      for (const selectedPath of selectedPaths) {
        const ok = await importSnapshotFromPath(selectedPath, { silent: batch })
        if (ok) {
          loaded += 1
        } else {
          failed += 1
        }
      }

      if (batch) {
        if (loaded > 0) {
          message.success(
            `已載入 ${loaded} 個快照${failed > 0 ? `，${failed} 個無法載入` : ''}`,
          )
        } else {
          message.error('所選檔案均無法載入為快照')
        }
      }
    }

    async function loadSnapshotRepairFile(kind: 'sort' | 'missing') {
      const selectedPath = normalizeDialogPath(
        await open({
          multiple: false,
          filters: [{ name: 'Gentleman Manager 快照', extensions: ['json'] }],
        }),
      )
      if (selectedPath === null) {
        return
      }
      const readResult = await commands.readSnapshotExportFile(selectedPath)
      if (readResult.status === 'error') {
        console.error(readResult.error)
        message.error(readResult.error.err_message)
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(readResult.data)
      } catch (err) {
        console.error(err)
        message.error('快照存檔格式錯誤，無法校準')
        return
      }
      if (!isGlobalSnapshotExportFile(parsed)) {
        message.error('校準快照只支援全站快照存檔')
        return
      }
      const loaded: SnapshotRepairLoadedFile = {
        path: selectedPath,
        name: selectedPath.split(/[\\/]/).pop() ?? selectedPath,
        file: parsed,
      }
      if (kind === 'sort') {
        snapshotRepairSortFile.value = loaded
        return
      }
      snapshotRepairMissingFile.value = loaded
    }

    function resetSnapshotRepairProgress() {
      snapshotRepairProgress.value = null
      snapshotRepairRunning.value = false
      snapshotRepairCancelled = false
      snapshotRepairStartedAt.value = null
      stopSnapshotRepairElapsedTimer()
    }

    function cancelSnapshotRepair() {
      snapshotRepairCancelled = true
      snapshotRepairProgress.value = snapshotRepairProgress.value
        ? { ...snapshotRepairProgress.value, detail: '正在終止，請稍候...' }
        : null
    }

    function setSnapshotRepairSortChecked(checked: boolean) {
      snapshotRepairSortChecked.value = checked
      if (checked) {
        snapshotRepairMissingChecked.value = false
      }
    }

    function setSnapshotRepairMissingChecked(checked: boolean) {
      snapshotRepairMissingChecked.value = checked
      if (checked) {
        snapshotRepairSortChecked.value = false
      }
    }

    async function writeSnapshotRepairJson(fileName: string, file: SnapshotExportFile) {
      const result = await commands.writeSnapshotRepairFile(fileName, JSON.stringify(file, null, 2))
      if (result.status === 'error') {
        console.error(result.error)
        message.error(result.error.err_message)
        return null
      }
      return result.data
    }

    async function runSnapshotSortCalibration(source: SnapshotRepairLoadedFile) {
      const comics = source.file.snapshot.comics
      const maxId = getMaxComicId(comics)
      const missing = new Set<number>()
      const ids = new Set(comics.map((comic) => comic.id))
      snapshotRepairProgress.value = { phase: '排序校準：ID掃描', current: 0, total: maxId, detail: '正在掃描 ID 分布' }
      await nextTick()
      for (let id = 1; id <= maxId; id += 1) {
        if (snapshotRepairCancelled) {
          message.info('已終止排序校準')
          return null
        }
        if (!ids.has(id)) {
          missing.add(id)
        }
        if (id % 1000 === 0 || id === maxId) {
          snapshotRepairProgress.value = {
            phase: '排序校準：ID掃描',
            current: id,
            total: maxId,
            detail: `已找到 ${missing.size} 個空號`,
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
        }
      }

      const sorted: ComicInSearch[] = []
      const byId = new Map(comics.map((comic) => [comic.id, comic] as const))
      snapshotRepairProgress.value = { phase: '排序校準：排序重構', current: 0, total: maxId, detail: '正在依 ID 重建順序' }
      await nextTick()
      for (let id = maxId; id >= 1; id -= 1) {
        if (snapshotRepairCancelled) {
          message.info('已終止排序校準')
          return null
        }
        const comic = byId.get(id)
        if (comic !== undefined) {
          sorted.push(comic)
        }
        const handled = maxId - id + 1
        if (handled % 1000 === 0 || id === 1) {
          snapshotRepairProgress.value = {
            phase: '排序校準：排序重構',
            current: handled,
            total: maxId,
            detail: `已重構 ${sorted.length} 本，跳過 ${missing.size} 個空號；目前處理 ID ${id}`,
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
        }
      }

      const sortedFile = makeGlobalSnapshotExportFile(source.file, sorted, {
        scanCompletionPercent: source.file.snapshot.meta.scanCompletionPercent,
        totalPages: source.file.snapshot.meta.totalPages,
        scanDirection: source.file.snapshot.meta.scanDirection,
        scanCompletedPages: source.file.snapshot.meta.scanCompletedPages,
      })
      const path = await writeSnapshotRepairJson(snapshotRepairFileName('排序校準快照存檔'), sortedFile)
      if (path === null) {
        return null
      }
      return { path, file: sortedFile, missingCount: missing.size }
    }

    function waitSnapshotRepairDelay() {
      return new Promise<void>((resolve) => setTimeout(resolve, 500 + Math.floor(Math.random() * 1001)))
    }

    function waitSnapshotRepairConservativeDelay() {
      return new Promise<void>((resolve) => setTimeout(resolve, 100 + Math.floor(Math.random() * 401)))
    }

    async function waitSnapshotRepairCloudflareCooldown(id: number, attempt: number) {
      for (let remaining = 20; remaining >= 1; remaining -= 1) {
        if (snapshotRepairCancelled) {
          return 'cancelled' as const
        }
        snapshotRepairProgress.value = {
          phase: '缺號修復：Cloudflare 等待',
          current: snapshotRepairProgress.value?.current ?? 0,
          total: snapshotRepairProgress.value?.total ?? 0,
          detail: `ID ${id} 第 ${attempt} 次確認遇到 Cloudflare 挑戰，休息 ${remaining} 秒後繼續`,
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 1000))
      }
      return 'ready' as const
    }

    async function fetchMissingComicById(id: number, maxAttempts: number, waitBetweenAttempts = waitSnapshotRepairDelay) {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (snapshotRepairCancelled) {
          return 'cancelled' as const
        }
        const result = await commands.getComic(id)
        if (result.status === 'ok') {
          return comicDetailToSnapshotComic(result.data)
        }
        const reason = formatInvokeError(result.error)
        if (isStrictCloudflareChallengeFailure(reason)) {
          const waitResult = await waitSnapshotRepairCloudflareCooldown(id, attempt)
          if (waitResult === 'cancelled') {
            return 'cancelled' as const
          }
        }
        if (attempt < maxAttempts) {
          await waitBetweenAttempts()
        }
      }
      return null
    }

    async function writeSnapshotRepairLog(sourceName: string, results: SnapshotRepairSearchResult[]) {
      const found = results.filter((item) => item.found)
      const missing = results.filter((item) => !item.found)
      const lines = [
        `缺號修復 LOG`,
        `來源：${sourceName}`,
        `時間：${new Date().toLocaleString()}`,
        `找到：${found.length}`,
        `未找到：${missing.length}`,
        '',
        '[找到]',
        ...found.map((item) => String(item.id)),
        '',
        '[未找到]',
        ...missing.map((item) => String(item.id)),
      ]
      const result = await commands.writeSnapshotRepairFile(snapshotRepairFileName('缺號修復結果', '.log'), lines.join('\n'))
      if (result.status === 'error') {
        console.error(result.error)
        message.error(result.error.err_message)
        return null
      }
      return result.data
    }

    async function runSnapshotMissingRepair(source: SnapshotRepairLoadedFile) {
      const sourceFile = source.file
      const comics = sourceFile.snapshot.comics
      const ids = new Set(comics.map((comic) => comic.id))
      const maxId = getMaxComicId(comics)
      const missingIds: number[] = []
      snapshotRepairProgress.value = {
        phase: '缺號修復：ID掃描',
        current: 0,
        total: maxId,
        detail: '正在建立空號清單',
      }
      await nextTick()
      for (let id = 1; id <= maxId; id += 1) {
        if (snapshotRepairCancelled) {
          message.info('已終止缺號修復')
          return null
        }
        if (!ids.has(id)) {
          missingIds.push(id)
        }
        if (id % 1000 === 0 || id === maxId) {
          snapshotRepairProgress.value = {
            phase: '缺號修復：ID掃描',
            current: id,
            total: maxId,
            detail: `已建立 ${missingIds.length} 個空號 ID`,
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
        }
      }

      const foundComics: ComicInSearch[] = []
      const results: SnapshotRepairSearchResult[] = []
      const outputName = snapshotRepairFileName('缺號修復快照存檔')
      let outputPath: string | null = null
      const gapAnalysis = buildSnapshotGapAnalysis(source, snapshotRepairGapThreshold.value)
      const repairMissingIds = filterRepairMissingIds(missingIds, gapAnalysis.ranges)
      if (gapAnalysis.unnaturalMissingTotal > 0) {
        message.info(`已排除不自然大段空號 ${gapAnalysis.unnaturalMissingTotal} 個，將修復剩餘空號 ${repairMissingIds.length} 個`)
      }

      async function saveFoundComicsSnapshot() {
        const foundFile = makeGlobalSnapshotExportFile(sourceFile, sortedUniqueComicsById(foundComics), {
          totalPages: 0,
          scanCompletionPercent: 100,
          scanCompletedPages: 0,
        })
        outputPath = await writeSnapshotRepairJson(outputName, foundFile)
        return outputPath !== null
      }

      async function handleMissingRepairResult(id: number, comic: ComicInSearch | null) {
        if (comic === null) {
          results.push({ id, found: false })
          return true
        }
        foundComics.push(comic)
        results.push({ id, found: true, title: comic.title })
        return await saveFoundComicsSnapshot()
      }

      const maxAttempts = snapshotRepairSearchMode.value === 'aggressive' ? 1 : 2
      const modeLabel = snapshotRepairSearchMode.value === 'aggressive' ? '激進模式' : '保守模式'
      let completed = 0

      async function processParallelRepairBatch(batch: number[]) {
        snapshotRepairProgress.value = {
          phase: `缺號修復：${modeLabel}`,
          current: completed,
          total: repairMissingIds.length,
          detail: `正在並行查詢 ID ${batch[0]} - ${batch[batch.length - 1]}`,
        }
        const batchResults = await Promise.all(batch.map(async (id) => ({ id, comic: await fetchMissingComicById(id, maxAttempts) })))
        for (const item of batchResults) {
          if (item.comic === 'cancelled') {
            message.info('已終止缺號修復')
            return false
          }
          if (!(await handleMissingRepairResult(item.id, item.comic))) {
            return false
          }
          completed += 1
        }
        snapshotRepairProgress.value = {
          phase: `缺號修復：${modeLabel}`,
          current: completed,
          total: repairMissingIds.length,
          detail: `已完成 ${completed}/${repairMissingIds.length} 個空號 ID`,
        }
        return true
      }

      async function processPacedRepairBatch(batch: number[], waitBetweenIds = waitSnapshotRepairDelay) {
        for (const id of batch) {
          if (snapshotRepairCancelled) {
            message.info('已終止缺號修復')
            return false
          }
          snapshotRepairProgress.value = {
            phase: `缺號修復：${modeLabel}`,
            current: completed,
            total: repairMissingIds.length,
            detail: `正在逐一查詢 ID ${id}`,
          }
          const comic = await fetchMissingComicById(id, maxAttempts, waitBetweenIds)
          if (comic === 'cancelled') {
            message.info('已終止缺號修復')
            return false
          }
          if (!(await handleMissingRepairResult(id, comic))) {
            return false
          }
          completed += 1
          snapshotRepairProgress.value = {
            phase: `缺號修復：${modeLabel}`,
            current: completed,
            total: repairMissingIds.length,
            detail: `已完成 ${completed}/${repairMissingIds.length} 個空號 ID`,
          }
          if (completed < repairMissingIds.length) {
            await waitBetweenIds()
          }
        }
        return true
      }

      if (snapshotRepairSearchMode.value === 'aggressive') {
        for (let start = 0; start < repairMissingIds.length; ) {
          if (snapshotRepairCancelled) {
            message.info('已終止缺號修復')
            return null
          }
          const batchSize = randomInt(100, 200)
          const batch = repairMissingIds.slice(start, start + batchSize)
          if (!(await processParallelRepairBatch(batch))) {
            return null
          }
          if (start + batchSize < repairMissingIds.length) {
            await waitSnapshotRepairDelay()
          }
          start += batchSize
        }
      } else {
        if (!(await processPacedRepairBatch(repairMissingIds, waitSnapshotRepairConservativeDelay))) {
          return null
        }
      }

      if (outputPath === null) {
        const emptyFile = makeGlobalSnapshotExportFile(sourceFile, [], {
          totalPages: 0,
          scanCompletionPercent: 100,
          scanCompletedPages: 0,
        })
        outputPath = await writeSnapshotRepairJson(outputName, emptyFile)
        if (outputPath === null) {
          return null
        }
      }
      const logPath = await writeSnapshotRepairLog(source.name, results)
      snapshotRepairSearchResults.value = results
      snapshotRepairFoundComics.value = sortedUniqueComicsById(foundComics)
      snapshotRepairFoundSnapshotPath.value = outputPath
      snapshotRepairLogPath.value = logPath
      snapshotRepairResultShowing.value = true
      return { outputPath, logPath }
    }

    function buildSnapshotGapAnalysis(source: SnapshotRepairLoadedFile, threshold = 6): SnapshotRepairGapAnalysis {
      const comics = source.file.snapshot.comics
      const ids = new Set(comics.map((comic) => comic.id))
      const maxId = getMaxComicId(comics)
      const ranges: SnapshotRepairGapRange[] = []
      let totalMissing = 0
      let rangeStart: number | null = null

      for (let id = 1; id <= maxId; id += 1) {
        const missing = !ids.has(id)
        if (missing) {
          totalMissing += 1
          if (rangeStart === null) {
            rangeStart = id
          }
          continue
        }
        if (rangeStart !== null) {
          const end = id - 1
          const count = end - rangeStart + 1
          if (count >= threshold) {
            ranges.push({ start: rangeStart, end, count })
          }
          rangeStart = null
        }
      }

      if (rangeStart !== null) {
        const count = maxId - rangeStart + 1
        if (count >= threshold) {
          ranges.push({ start: rangeStart, end: maxId, count })
        }
      }

      const unnaturalMissingTotal = ranges.reduce((sum, range) => sum + range.count, 0)
      return {
        sourceName: source.name,
        maxId,
        totalMissing,
        unnaturalMissingTotal,
        remainingIdCount: maxId - unnaturalMissingTotal,
        remainingMissingCount: totalMissing - unnaturalMissingTotal,
        threshold,
        ranges,
      }
    }

    function refreshSnapshotRepairGapAnalysis() {
      if (snapshotRepairMissingGapAnalysis.value === null) {
        message.warning('請先載入缺號修復快照存檔')
      }
    }

    function filterRepairMissingIds(missingIds: number[], ranges: SnapshotRepairGapRange[]) {
      const repairIds: number[] = []
      let rangeIndex = 0
      for (const id of missingIds) {
        while (rangeIndex < ranges.length && id > ranges[rangeIndex]!.end) {
          rangeIndex += 1
        }
        const range = ranges[rangeIndex]
        if (range !== undefined && id >= range.start && id <= range.end) {
          continue
        }
        repairIds.push(id)
      }
      return repairIds
    }

    async function startSnapshotRepair() {
      if (snapshotRepairRunning.value) {
        return
      }
      if (!snapshotRepairSortChecked.value && !snapshotRepairMissingChecked.value) {
        message.warning('請先勾選要執行的校準項目')
        return
      }
      if (snapshotRepairSortChecked.value && snapshotRepairSortFile.value === null) {
        message.warning('請先載入排序校準快照存檔')
        return
      }
      if (!snapshotRepairSortChecked.value && snapshotRepairMissingChecked.value && snapshotRepairMissingFile.value === null) {
        message.warning('請先載入缺號修復快照存檔')
        return
      }
      snapshotRepairRunning.value = true
      snapshotRepairCancelled = false
      snapshotRepairSortDone.value = null
      snapshotRepairStartedAt.value = Date.now()
      snapshotRepairElapsedTick.value = snapshotRepairStartedAt.value
      startSnapshotRepairElapsedTimer()
      try {
        if (snapshotRepairSortChecked.value && snapshotRepairSortFile.value !== null) {
          const sorted = await runSnapshotSortCalibration(snapshotRepairSortFile.value)
          if (sorted !== null) {
            snapshotRepairSortDone.value = sorted
          }
          return
        }

        if (snapshotRepairMissingChecked.value && snapshotRepairMissingFile.value !== null) {
          await runSnapshotMissingRepair(snapshotRepairMissingFile.value)
          return
        }

      } finally {
        resetSnapshotRepairProgress()
      }
    }

    function completeSnapshotSortDone() {
      const sorted = snapshotRepairSortDone.value
      if (sorted !== null) {
        snapshotRepairMissingChecked.value = true
        snapshotRepairMissingFile.value = {
          path: sorted.path,
          name: sorted.path.split(/[\\/]/).pop() ?? sorted.path,
          file: sorted.file,
        }
      }
      snapshotRepairSortDone.value = null
      snapshotRepairSortChecked.value = false
    }

    async function mergeSnapshotRepairResults() {
      const source = snapshotRepairMissingFile.value
      if (source === null) {
        message.error('找不到缺號修復載入的快照')
        return
      }
      const merged = sortedUniqueComicsById([...source.file.snapshot.comics, ...snapshotRepairFoundComics.value])
      const mergedFile = makeGlobalSnapshotExportFile(source.file, merged, {
        totalPages: source.file.snapshot.meta.totalPages,
        scanCompletionPercent: source.file.snapshot.meta.scanCompletionPercent,
        scanDirection: source.file.snapshot.meta.scanDirection,
        scanCompletedPages: source.file.snapshot.meta.scanCompletedPages,
      })
      const result = await commands.writeSnapshotRootFile(
        snapshotRepairFileName('缺號修復合併快照存檔'),
        JSON.stringify(mergedFile, null, 2),
      )
      if (result.status === 'error') {
        console.error(result.error)
        message.error(result.error.err_message)
        return
      }
      message.success(`已合併並輸出：${result.data}`)
      snapshotRepairResultShowing.value = false
      snapshotRepairShowing.value = false
    }

    function normalizeScopedCacheQuery(value: string) {
      return value.trim().toLocaleLowerCase()
    }

    function findMatchingScopedScanCaches(
      scope: { cateId: number; label: string },
      request: ScopedSearchEstimateRequest,
    ) {
      const kindLabel: ScopedScanCache['kindLabel'] = request.kind === 'tag' ? '標籤詞' : '關鍵詞'
      const query = normalizeScopedCacheQuery(request.query)
      if (query === '') {
        return []
      }
      return scopedScanCaches.value.filter(
        (cache) =>
          cache.categoryLabel === scope.label &&
          cache.kindLabel === kindLabel &&
          normalizeScopedCacheQuery(cache.queryLabel) === query,
      )
    }

    function renderScopedScanCachesPane() {
      const isEmpty = globalSnapshotMetas.value.length === 0 && scopedScanCaches.value.length === 0
      return (
        <div class="h-full flex flex-col">
          {isEmpty ? (
            <div class="flex-1 flex flex-col gap-3 items-center justify-center p-4">
              <NEmpty description="尚無收藏快照。使用全站快照或主/子分類搜尋完成掃描後會自動保存。" />
              <NButton size="small" secondary onClick={() => void importSnapshotExportFile()}>
                快照載入（可多選）
              </NButton>
            </div>
          ) : (
            <>
              <div class="px-3 pt-2 pb-1 flex items-center justify-between gap-3">
                <span class="text-sm opacity-80">
                  共 {globalSnapshotMetas.value.length + scopedScanCaches.value.length} 個收藏快照
                </span>
                <NButton size="tiny" secondary onClick={() => void importSnapshotExportFile()}>
                  快照載入（可多選）
                </NButton>
              </div>
              <ul class="flex-1 min-h-0 overflow-auto px-2 pb-2 list-none m-0">
                {globalSnapshotMetas.value.map((snapshot) => (
                  <li
                    key={snapshot.id}
                    class="flex items-center gap-2 px-2 py-2 rounded-md hover:bg-[rgba(255,255,255,0.06)] cursor-pointer group border border-transparent hover:border-[var(--n-divider-color)]"
                    title={`${globalSnapshotLabel(snapshot)} · 共${snapshot.totalCount}本 · 掃描完成度 ${scanCacheCompletionPercent(snapshot)}%`}
                    onClick={() => void loadGlobalSnapshot(snapshot, true)}>
                    <div class="flex-1 min-w-0">
                      <div class="text-sm font-medium truncate">{globalSnapshotLabel(snapshot)}</div>
                      <div class="text-xs opacity-60 mt-0.5">
                        共{snapshot.totalCount}本 · 掃描完成度：{scanCacheCompletionPercent(snapshot)}%
                      </div>
                    </div>
                    <div class="ml-4 flex items-center gap-3 shrink-0">
                      <NButton
                        size="tiny"
                        secondary
                        title="導出全站快照"
                        onClick={(event: MouseEvent) => void exportGlobalSnapshot(event, snapshot)}>
                        導出
                      </NButton>
                      <NButton
                        size="tiny"
                        quaternary
                        title="刪除全站快照"
                        onClick={(event: MouseEvent) => requestDeleteGlobalSnapshot(event, snapshot)}>
                        {{
                          icon: () => (
                            <NIcon size={16}>
                              <PhTrash />
                            </NIcon>
                          ),
                        }}
                      </NButton>
                    </div>
                  </li>
                ))}
                {globalSnapshotMetas.value.length > 0 && scopedScanCaches.value.length > 0 && (
                  <li class="my-2 h-px bg-[rgba(255,255,255,0.28)]" />
                )}
                {scopedScanCaches.value.map((cache) => (
                  <li
                    key={cache.id}
                    class="flex items-center gap-2 px-2 py-2 rounded-md hover:bg-[rgba(255,255,255,0.06)] cursor-pointer group border border-transparent hover:border-[var(--n-divider-color)]"
                    title={`${scanCacheLabel(cache)} · 掃描完成度 ${scanCacheCompletionPercent(cache)}%`}
                    onClick={() => openScopedScanCache(cache)}>
                    <div class="flex-1 min-w-0">
                      <div class="text-sm font-medium truncate">{scanCacheLabel(cache)}</div>
                      <div class="text-xs opacity-60 mt-0.5">掃描完成度：{scanCacheCompletionPercent(cache)}%</div>
                    </div>
                    <div class="ml-4 flex items-center gap-3 shrink-0">
                      <NButton
                        size="tiny"
                        secondary
                        title="導出分頁快照"
                        onClick={(event: MouseEvent) => void exportScopedScanCache(event, cache)}>
                        導出
                      </NButton>
                      <NButton
                        size="tiny"
                        quaternary
                        class="shrink-0"
                        title="刪除收藏快照"
                        onClick={(event: MouseEvent) => requestDeleteScopedScanCache(event, cache)}>
                        {{
                          icon: () => (
                            <NIcon size={16}>
                              <PhTrash />
                            </NIcon>
                          ),
                        }}
                      </NButton>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )
    }

    function resolveScopedSearchConfirm(confirmed: boolean) {
      scopedSearchConfirmShowing.value = false
      scopedSearchEstimateToken++
      const resolve = scopedSearchConfirmResolve
      scopedSearchConfirmResolve = undefined
      resolve?.(confirmed)
    }

    function resolveScopedCacheChoice(result: SnapshotSearchChoiceResult) {
      scopedCacheChoiceShowing.value = false
      scopedCacheChoiceRequest.value = null
      scopedCacheChoiceGlobalSnapshot.value = null
      scopedSearchEstimateToken++
      globalSnapshotPageEstimateToken++
      const resolve = scopedCacheChoiceResolve
      scopedCacheChoiceResolve = undefined
      resolve?.(result)
    }

    function submitScopedCacheChoice() {
      if (isActiveScanEstimateLoading()) {
        return
      }
      if (scopedSearchPathChoice.value === 'scanGlobal') {
        resolveScopedCacheChoice({ action: 'scanGlobal' })
        return
      }
      if (scopedSearchPathChoice.value === 'useGlobal' && scopedCacheChoiceGlobalSnapshot.value !== null) {
        resolveScopedCacheChoice({ action: 'useGlobal', snapshot: scopedCacheChoiceGlobalSnapshot.value })
        return
      }
      resolveScopedCacheChoice({ action: 'scoped' })
    }

    function handleScopedCacheChoiceEnter(event: KeyboardEvent) {
      if (!scopedCacheChoiceShowing.value || event.key !== 'Enter' || event.isComposing) {
        return
      }
      event.preventDefault()
      submitScopedCacheChoice()
    }

    async function chooseScopedSearchPath(
      scope: { cateId: number; label: string } | null,
      request: ScopedSearchEstimateRequest,
    ): Promise<SnapshotSearchChoiceResult> {
      if (scope === null) {
        return { action: 'scoped' }
      }
      const matches = findMatchingScopedScanCaches(scope, request)
      const latestGlobalSnapshot = request.kind === 'keyword' ? findLatestGlobalSnapshotForScope(scope) ?? null : null
      scopedCacheChoiceRequest.value = request
      scopedCacheChoiceCaches.value = matches
      scopedCacheChoiceGlobalSnapshot.value = latestGlobalSnapshot
      if (latestGlobalSnapshot !== null) {
        scopedSearchPathChoice.value = 'useGlobal'
      } else if (scopedSearchPathChoice.value === 'useGlobal') {
        scopedSearchPathChoice.value = 'scoped'
      }
      scopedSearchPageEstimate.value = { status: 'idle' }
      globalSnapshotPageEstimate.value = { status: 'idle' }
      scopedCacheChoiceShowing.value = true
      void estimateScopedSearchPages(request)
      return new Promise<SnapshotSearchChoiceResult>((resolve) => {
        scopedCacheChoiceResolve = resolve
      })
    }

    function scanPageCountFromResult(result: SearchResult) {
      if (result.totalPage > 0) {
        return result.totalPage
      }
      if (result.totalCount > 0) {
        return Math.max(1, Math.ceil(result.totalCount / SERVER_PAGE_SIZE))
      }
      return Math.max(1, result.comics.length > 0 ? 1 : 0)
    }

    function scopedSearchEstimateLabel() {
      const estimate = scopedSearchPageEstimate.value
      if (estimate.status === 'loading') {
        return '正在估算需要掃描的頁數...'
      }
      if (estimate.status === 'ready') {
        return `預計需要掃描 ${estimate.totalPages} 頁`
      }
      if (estimate.status === 'error') {
        return '暫時無法預估掃描頁數，仍可開始掃描。'
      }
      return '尚未估算掃描頁數。'
    }

    function globalSnapshotPageEstimateLabel() {
      const estimate = globalSnapshotPageEstimate.value
      if (estimate.status === 'loading') {
        return '正在估算需要掃描的頁數...'
      }
      if (estimate.status === 'ready') {
        return `預計需要掃描 ${estimate.totalPages} 頁`
      }
      if (estimate.status === 'error') {
        return '暫時無法預估掃描頁數，仍可開始掃描。'
      }
      return '尚未估算掃描頁數。'
    }

    function activeScanEstimateLabel() {
      if (scopedSearchPathChoice.value === 'useGlobal') {
        const snapshot = scopedCacheChoiceGlobalSnapshot.value
        return snapshot === null
          ? '沒有可用的同分類快照。'
          : `使用 ${globalSnapshotLabel(snapshot)}，不影響目前載入的快照。`
      }
      return scopedSearchPathChoice.value === 'scanGlobal' ? globalSnapshotPageEstimateLabel() : scopedSearchEstimateLabel()
    }

    function isActiveScanEstimateLoading() {
      if (scopedSearchPathChoice.value === 'useGlobal') {
        return false
      }
      return scopedSearchPathChoice.value === 'scanGlobal'
        ? globalSnapshotPageEstimate.value.status === 'loading'
        : scopedSearchPageEstimate.value.status === 'loading'
    }

    async function estimateGlobalSnapshotScanPages() {
      const token = ++globalSnapshotPageEstimateToken
      globalSnapshotPageEstimate.value = { status: 'loading' }
      try {
        const firstPage = await fetchGlobalSnapshotPage(1)
        if (token !== globalSnapshotPageEstimateToken || !scopedCacheChoiceShowing.value) {
          return
        }
        if (firstPage === undefined) {
          globalSnapshotPageEstimate.value = { status: 'error' }
          return
        }
        globalSnapshotPageEstimate.value = {
          status: 'ready',
          totalPages: scanPageCountFromResult(firstPage),
          totalCount: firstPage.totalCount,
        }
      } catch (error) {
        if (token !== globalSnapshotPageEstimateToken || !scopedCacheChoiceShowing.value) {
          return
        }
        console.error(error)
        globalSnapshotPageEstimate.value = { status: 'error' }
      }
    }

    function setScopedSearchPathChoice(value: ScopedSearchPathChoice) {
      scopedSearchPathChoice.value = value
      saveScopedSearchPathChoice(value)
      if (value === 'scanGlobal' && globalSnapshotPageEstimate.value.status === 'idle') {
        void estimateGlobalSnapshotScanPages()
      }
    }

    async function estimateScopedSearchPages(request: ScopedSearchEstimateRequest) {
      const query = request.query.trim()
      if (query === '') {
        scopedSearchPageEstimate.value = { status: 'error' }
        return
      }

      const token = ++scopedSearchEstimateToken
      scopedSearchPageEstimate.value = { status: 'loading' }

      try {
        const result =
          request.kind === 'tag'
            ? await commands.searchByTag(query, 1, null, null)
            : await commands.searchByKeyword(query, 1, null, null)

        if (token !== scopedSearchEstimateToken || (!scopedSearchConfirmShowing.value && !scopedCacheChoiceShowing.value)) {
          return
        }
        if (result.status === 'error') {
          console.error(result.error)
          scopedSearchPageEstimate.value = { status: 'error' }
          return
        }

        scopedSearchPageEstimate.value = {
          status: 'ready',
          totalPages: scanPageCountFromResult(result.data),
          totalCount: result.data.totalCount,
        }
      } catch (error) {
        if (token !== scopedSearchEstimateToken || (!scopedSearchConfirmShowing.value && !scopedCacheChoiceShowing.value)) {
          return
        }
        console.error(error)
        scopedSearchPageEstimate.value = { status: 'error' }
      }
    }

    function confirmScopedSearchIfNeeded(
      scope: { cateId: number; label: string } | null,
      estimateRequest: ScopedSearchEstimateRequest,
    ): Promise<boolean> {
      if (scope === null) {
        return Promise.resolve(true)
      }
      clearScopedSearchProgress()
      if (scopedSearchConfirmShowing.value) {
        return Promise.resolve(false)
      }
      scopedSearchPageEstimate.value = { status: 'idle' }
      scopedSearchConfirmShowing.value = true
      void estimateScopedSearchPages(estimateRequest)
      return new Promise((resolve) => {
        scopedSearchConfirmResolve = resolve
      })
    }

    async function applyGlobalSnapshotKeywordSearch(
      scope: { cateId: number; label: string },
      request: ScopedSearchEstimateRequest,
      snapshot: GlobalSnapshotMeta,
    ) {
      if (request.kind !== 'keyword') {
        message.warning('全站快照不包含標籤資訊，標籤詞仍需使用分類掃描')
        return false
      }
      globalSnapshotKeywordSearchProgress.value = {
        current: 0,
        total: snapshot.totalCount,
        matchedCount: 0,
        detail: '正在載入全站快照',
      }
      searchingKeywordOrComicLink.value = true
      await nextTick()
      const record = await getGlobalSnapshotRecord(snapshot.id)
      if (record === undefined) {
        searchingKeywordOrComicLink.value = false
        globalSnapshotKeywordSearchProgress.value = null
        message.warning('找不到這次選用的快照內容')
        return false
      }
      try {
        const matches = await filterGlobalSnapshotByKeywordWithProgress(record.comics, scope, request.query)
        const keywordSummary =
          matches.length === 0
            ? await summarizeGlobalSnapshotKeywordMatchesWithProgress(record.comics, request.query)
            : { totalCount: matches.length, categories: [] }
        persistActiveTabBeforeNewSearch()
        keywordOrComicLinkInput.value = request.query
        tagOrLinkInput.value = ''
        searchInputMode.value = 'keywordOrComicLink'
        searchSource.value = { type: 'keyword', cateId: scope.cateId }
        searchScopeCategory.value = scope
        activeTagLabel.value = ''
        activeCategoryLabel.value = `${scope.label} · 全站快照`
        store.activeBrowseLabel = scope.label
        const session = beginSearchSession()
        await completeNewSearchTab(`${scope.label} · ${request.query} · 全站快照`, buildCollectedSearchResult(matches), {
          offlineComics: matches,
        })
        if (!isActiveSearchSession(session)) {
          return false
        }
        if (matches.length === 0 && keywordSummary.totalCount > 0) {
          const topCategories = keywordSummary.categories.slice(0, 5).join('、')
          const moreCategories =
            keywordSummary.categories.length > 5 ? ` 等 ${keywordSummary.categories.length} 個分類` : ''
          message.warning(
            `快照內有 ${keywordSummary.totalCount} 本符合關鍵詞，但不屬於「${scope.label}」分類；位於：${topCategories}${moreCategories}`,
          )
        } else {
          message.success(`已使用 ${globalSnapshotLabel(snapshot)} 搜尋，找到 ${matches.length} 本`)
        }
      } finally {
        searchingKeywordOrComicLink.value = false
        globalSnapshotKeywordSearchProgress.value = null
      }
      return true
    }

    async function prepareScopedSearchIfNeeded(
      scope: { cateId: number; label: string } | null,
      estimateRequest: ScopedSearchEstimateRequest,
    ) {
      if (scope === null) {
        return true
      }
      const choice = await chooseScopedSearchPath(scope, estimateRequest)
      if (choice.action === 'cancel') {
        return false
      }
      if (choice.action === 'loadScoped') {
        openScopedScanCache(choice.cache)
        return false
      }
      if (choice.action === 'useGlobal') {
        await applyGlobalSnapshotKeywordSearch(scope, estimateRequest, choice.snapshot)
        return false
      }
      if (choice.action === 'scanGlobal') {
        const meta = await scanGlobalSnapshot()
        if (meta !== undefined) {
          await applyGlobalSnapshotKeywordSearch(scope, estimateRequest, meta)
        }
        return false
      }
      return choice.action === 'scoped'
    }

    async function searchByKeywordImpl(keyword: string) {
      const scope = searchScopeCategory.value
      if (!(await prepareScopedSearchIfNeeded(scope, { kind: 'keyword', query: keyword }))) {
        return
      }
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
      searchInputMode.value = 'keywordOrComicLink'
      searchSource.value = scope !== null ? { type: 'keyword', cateId: scope.cateId } : { type: 'keyword' }
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

      const result = await commands.searchByKeyword(keyword, 1, scope?.cateId ?? null, scopedSearchScanModeParam.value)
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
      if (result.data.comics.length === 0) {
        message.warning(`沒有搜尋到「${keyword}」`)
      }

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
      return runExclusiveSearch(() => searchByKeywordImpl(keyword))
    }

    async function searchByTagImpl(tagName: string, pageNum: number, useCategoryScope: boolean) {
      if (!useCategoryScope) {
        clearScopedSearchProgress()
        void commands.cancelScopedSearchScan()
      }
      if (pageNum === 1) {
        persistActiveTabBeforeNewSearch()
      }
      tagOrLinkInput.value = tagName
      searchInputMode.value = 'tagOrLink'
      activeTagSearchSource.value = 'name'
      const scope = useCategoryScope ? searchScopeCategory.value : null
      if (pageNum === 1 && !(await prepareScopedSearchIfNeeded(scope, { kind: 'tag', query: tagName }))) {
        searchingTagOrLink.value = false
        return
      }
      searchSource.value =
        scope !== null ? { type: 'tag', source: 'name', cateId: scope.cateId } : { type: 'tag', source: 'name' }
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

      const result = await commands.searchByTag(
        tagName,
        pageNum,
        scope?.cateId ?? null,
        scopedSearchScanModeParam.value,
      )
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
        if (result.data.comics.length === 0) {
          message.warning(`沒有搜尋到標籤「${tagName.trim()}」`)
        }
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
      return runExclusiveSearch(() => searchByTagImpl(tagName, pageNum, false))
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
      searchInputMode.value = 'tagOrLink'
      activeTagSearchSource.value = 'link'
      const scope = searchScopeCategory.value
      if (pageNum === 1 && !(await prepareScopedSearchIfNeeded(scope, { kind: 'tag', query: parsed.tagSlug }))) {
        searchingTagOrLink.value = false
        return
      }
      searchSource.value =
        scope !== null ? { type: 'tag', source: 'link', cateId: scope.cateId } : { type: 'tag', source: 'link' }
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

      const result = await commands.searchByTag(
        parsed.tagSlug,
        pageToFetch,
        scope?.cateId ?? null,
        scopedSearchScanModeParam.value,
      )
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
        if (result.data.comics.length === 0) {
          message.warning(`沒有搜尋到標籤「${parsed.tagSlug}」`)
        }
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
      return runExclusiveSearch(() => searchByTagLinkImpl(rawLink, pageNum))
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
          searchScopeCategory: { label },
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
        searchInputMode.value = 'keywordOrComicLink'
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
        searchInputMode.value = 'keywordOrComicLink'
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
        cateId === null ? '全部分類' : (listRankingScopes().find((s) => s.cateId === cateId)?.label ?? '全部分類')
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

      const result = list === 'home' ? await commands.browseHome(pageNum) : await commands.browseAlbumsList(pageNum)
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
        searchInputMode.value = 'keywordOrComicLink'
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

    function updateActiveSearchInput(value: string) {
      keywordOrComicLinkInput.value = value
    }

    async function submitActiveSearchInput() {
      await submitKeywordOrComicLink()
    }

    function onPageSizeChange(size: number) {
      if (!PAGE_SIZE_OPTIONS.includes(size as (typeof PAGE_SIZE_OPTIONS)[number])) {
        return
      }
      const firstItemIndex = (viewPage.value - 1) * pageSize.value
      pageSize.value = size
      localStorage.setItem(SEARCH_PAGE_SIZE_STORAGE_KEY, String(size))
      if (totalCountHint.value > 0) {
        const nextPage = Math.min(displayPageCount.value, Math.max(1, Math.floor(firstItemIndex / size) + 1))
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
            .filter(([, { state }]) => state === 'Pending' || state === 'Downloading' || state === 'Paused')
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
          const result = await enqueueComicIds(
            comics.map((c) => c.id),
            jobOptions,
            (handled, enqueued) => {
              updateDownloadBatchEnqueueProgress(handled, enqueued)
            },
          )

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
        const tag = activeTagLabel.value || getTagLabelFromSearch(tagOrLinkInput.value, activeTagSearchSource.value)
        return scope !== null && source.cateId !== undefined ? `${scope.label} · ${tag}` : tag
      }
      if (source.type === 'category' || source.type === 'albums' || source.type === 'ranking') {
        return activeCategoryLabel.value || store.activeBrowseLabel
      }
      return ''
    }

    function resolveCatalogAnalysisTagLabel(): string | undefined {
      const source = searchSource.value
      if (source.type === 'tag') {
        const tag = activeTagLabel.value || getTagLabelFromSearch(tagOrLinkInput.value, activeTagSearchSource.value)
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

        const analysis = analyzePageCatalogDuplicates(comicsSnapshot, result.data, {
          tagLabel: tagLabelSnapshot,
        })
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

    function renderGlobalSnapshotTabControls() {
      return (
        <NDropdown
          trigger="hover"
          options={[
            { label: '快照掃描', key: 'scan' },
            { label: '接續掃描', key: 'resume' },
          ]}
          onSelect={(key) => {
            if (key === 'scan') {
              store.currentTabName = 'search'
              void scanGlobalSnapshot()
              return
            }
            if (key === 'resume') {
              openGlobalSnapshotResumeDialog()
              return
            }
          }}>
          <span class="whitespace-nowrap">全站快照</span>
        </NDropdown>
      )
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
        message.error(`沒有找到 ID ${comicId}，或網站暫時無法回應`)
        return
      }

      store.pickedComic = result.data
      store.currentTabName = 'comic'
    }

    const render = () => (
      <div class="h-full flex flex-col gap-2 relative">
        <NInputGroup class="box-border px-2 pt-2">
          <NDropdown
            trigger="hover"
            options={SEARCH_SCOPE_DROPDOWN_OPTIONS}
            onSelect={(key) => {
              if (key === 'all') {
                searchScopeCategory.value = null
                return
              }
              const found = CATEGORY_SEARCH_SCOPE_OPTIONS.find((o) => String(o.cateId) === key)
              if (found !== undefined) {
                searchScopeCategory.value = found
              }
            }}>
            <NButton size="small" class="max-w-56 truncate">
              搜尋範圍：{searchScopeCategory.value?.label ?? '全站'}
            </NButton>
          </NDropdown>
          <FloatLabelInput
            size="small"
            label=""
            value={activeSearchInputValue.value}
            onUpdate:value={updateActiveSearchInput}
            clearable
            {...{
              onKeydown: async (e: KeyboardEvent) => {
                if (e.key === 'Enter') {
                  await submitActiveSearchInput()
                }
              },
            }}
          />
          <NButton
            loading={activeSearchInputLoading.value}
            type="primary"
            size="small"
            class="w-14! min-w-14! shrink-0"
            onClick={() => submitActiveSearchInput()}>
            {{
              icon: () => (
                <NIcon size={22}>
                  <PhMagnifyingGlass />
                </NIcon>
              ),
            }}
          </NButton>
        </NInputGroup>
        {activeGlobalSnapshotLabel.value !== '' && (
          <div class="px-2 -mt-1 text-xs opacity-70 truncate">{activeGlobalSnapshotLabel.value}</div>
        )}

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
                disabled={isKoreanModeLoading.value ? false : !canUseKoreanDownloadMode.value || isSearchBusy.value}
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
              {(isInitialSearchBusy.value || isViewPageLoading.value) && !isScopedScanOverlay.value && (
                <div class="absolute inset-0 z-10 flex items-center justify-center pointer-events-none bg-black/45">
                  <div class="flex flex-col items-center gap-3 px-8 py-6 rounded-xl bg-[#2a2a2a] border border-[rgba(255,255,255,0.14)] shadow-xl">
                    <NSpin show size="large" />
                    <span class="text-sm text-gray-100 text-center leading-relaxed">{loadingDescription.value}</span>
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

        <NModal
          show={scopedSearchCompleteSummary.value !== null}
          onUpdate:show={(v) => {
            if (!v) {
              scopedSearchCompleteSummary.value = null
            }
          }}>
          <NDialog
            showIcon={false}
            title="分類掃描完成"
            style={{ width: '28rem', maxWidth: '92vw' }}
            positiveText="知道了"
            onPositiveClick={() => (scopedSearchCompleteSummary.value = null)}
            onClose={() => (scopedSearchCompleteSummary.value = null)}>
            {scopedSearchCompleteSummary.value !== null && (
              <div class="flex flex-col gap-2 text-sm leading-relaxed opacity-85">
                <div>本次掃描總耗時：{scopedSearchCompleteSummary.value.elapsedText}</div>
                <div>共搜索到：{scopedSearchCompleteSummary.value.matchedCount} 本</div>
                <div>
                  掃描頁數：{scopedSearchCompleteSummary.value.scannedPages}/
                  {scopedSearchCompleteSummary.value.totalPages} 頁
                </div>
              </div>
            )}
          </NDialog>
        </NModal>

        <NModal
          show={scopedCacheChoiceShowing.value}
          onUpdate:show={(v) => !v && resolveScopedCacheChoice({ action: 'cancel' })}>
          <NDialog
            showIcon={false}
            title="選擇分類搜尋方式"
            style={{ width: '24rem', maxWidth: '92vw' }}
            onClose={() => resolveScopedCacheChoice({ action: 'cancel' })}>
            {{
              default: () => (
                <div class="flex flex-col gap-3 text-sm leading-relaxed opacity-85">
                  <NRadioGroup
                    value={scopedSearchPathChoice.value}
                    onUpdate:value={(value) => {
                      if (value === 'scoped' || value === 'useGlobal' || value === 'scanGlobal') {
                        setScopedSearchPathChoice(value)
                      }
                    }}>
                    <div class="flex flex-col gap-1.5">
                      <NRadio value="scoped">分類掃描，較慢</NRadio>
                      {scopedCacheChoiceRequest.value?.kind === 'keyword' && (
                        <NRadio value="useGlobal" disabled={scopedCacheChoiceGlobalSnapshot.value === null}>
                          <div class="flex flex-col leading-relaxed">
                            <span>快照掃描，迅速</span>
                            <span class="text-xs opacity-75">
                              {scopedCacheChoiceGlobalSnapshot.value === null
                                ? '(收藏快照內沒有同分類快照)'
                                : `(${globalSnapshotLabel(scopedCacheChoiceGlobalSnapshot.value)})`}
                            </span>
                          </div>
                        </NRadio>
                      )}
                    </div>
                  </NRadioGroup>
                  {scopedCacheChoiceRequest.value?.kind === 'tag' && (
                    <div class="rounded border border-[var(--n-border-color)] px-3 py-2">
                      更新列表頁不包含標籤資訊，標籤詞不能使用全站快照，只能使用分類標籤掃描。
                    </div>
                  )}
                  <div class="rounded border border-[var(--n-border-color)] px-3 py-2">{activeScanEstimateLabel()}</div>
                  {scopedSearchPathChoice.value !== 'useGlobal' && (
                    <div class="flex flex-col gap-2 rounded border border-[var(--n-border-color)] px-3 py-2">
                      <span class="font-medium opacity-90">掃描模式</span>
                      <NRadioGroup
                        value={scopedSearchScanMode.value}
                        onUpdate:value={(value) => {
                          if (value === 'conservative' || value === 'aggressive') {
                            setScopedSearchScanMode(value)
                          }
                        }}>
                        <div class="flex flex-col gap-1.5">
                          <NRadio value="conservative">保守模式</NRadio>
                          <NRadio value="aggressive">激進模式(搭配VPN使用)</NRadio>
                        </div>
                      </NRadioGroup>
                    </div>
                  )}
                </div>
              ),
              action: () => (
                <div class="w-full flex justify-center">
                  <NButton
                    type="primary"
                    disabled={isActiveScanEstimateLoading()}
                    onClick={() => submitScopedCacheChoice()}>
                    {scopedSearchPathChoice.value === 'useGlobal' ? '搜索' : '掃描'}
                  </NButton>
                </div>
              ),
            }}
          </NDialog>
        </NModal>

        <NModal show={snapshotDeleteTarget.value !== null} onUpdate:show={(v) => !v && closeSnapshotDeleteConfirm()}>
          <NDialog
            showIcon={false}
            title={snapshotDeleteConfirmTitle()}
            style={{ width: '28rem', maxWidth: '92vw' }}
            positiveText="刪除"
            negativeText="取消"
            positiveButtonProps={{ type: 'error' }}
            onPositiveClick={() => void confirmSnapshotDelete()}
            onNegativeClick={() => closeSnapshotDeleteConfirm()}
            onClose={() => closeSnapshotDeleteConfirm()}>
            <div class="text-sm leading-relaxed opacity-85">{snapshotDeleteConfirmDescription()}</div>
          </NDialog>
        </NModal>

        <NModal
          show={snapshotRepairShowing.value}
          maskClosable={false}
          onUpdate:show={(v) => {
            if (!v) {
              if (snapshotRepairRunning.value) {
                cancelSnapshotRepair()
              }
              snapshotRepairShowing.value = false
            }
          }}>
          <NDialog
            showIcon={false}
            title="校準快照"
            style={{ width: '42rem', maxWidth: '94vw' }}
            onClose={() => {
              if (snapshotRepairRunning.value) {
                cancelSnapshotRepair()
              }
              snapshotRepairShowing.value = false
            }}>
            {{
              default: () => (
                <div class="flex flex-col gap-4 text-sm leading-relaxed">
                  <div class="opacity-75">
                    載入已導出的全站快照存檔後，可執行「排序校準」或「缺號修復」；缺號修復會先在本機排除不自然空號區段。
                  </div>
                  <div
                    class={[
                      'rounded border px-3 py-3 flex flex-col gap-2',
                      snapshotRepairSortChecked.value ? 'border-[var(--n-border-color)]' : 'border-[rgba(255,255,255,0.08)] opacity-55',
                    ]}>
                    <div class="flex items-center gap-3">
                      <NCheckbox
                        checked={snapshotRepairSortChecked.value}
                        disabled={snapshotRepairRunning.value}
                        onUpdate:checked={(checked) => setSnapshotRepairSortChecked(Boolean(checked))}>
                        排序校準
                      </NCheckbox>
                      <NButton
                        size="tiny"
                        secondary
                        disabled={!snapshotRepairSortChecked.value || snapshotRepairRunning.value}
                        onClick={() => void loadSnapshotRepairFile('sort')}>
                        載入
                      </NButton>
                      <span class="text-xs opacity-70 truncate">
                        {snapshotRepairSortFile.value?.name ?? '尚未載入快照存檔'}
                      </span>
                    </div>
                    <div class="text-xs opacity-70">
                      從 ID 1 掃描到最大 ID，按 ID 由大到小重建快照順序，遇到空號先跳過。
                    </div>
                  </div>
                  <div
                    class={[
                      'rounded border px-3 py-3 flex flex-col gap-2',
                      snapshotRepairMissingChecked.value ? 'border-[var(--n-border-color)]' : 'border-[rgba(255,255,255,0.08)] opacity-55',
                    ]}>
                    <div class="flex items-center gap-3">
                      <NCheckbox
                        checked={snapshotRepairMissingChecked.value}
                        disabled={snapshotRepairRunning.value}
                        onUpdate:checked={(checked) => setSnapshotRepairMissingChecked(Boolean(checked))}>
                        缺號修復
                      </NCheckbox>
                      <NButton
                        size="tiny"
                        secondary
                        disabled={!snapshotRepairMissingChecked.value || snapshotRepairRunning.value}
                        onClick={() => void loadSnapshotRepairFile('missing')}>
                        載入
                      </NButton>
                      <span class="text-xs opacity-70 truncate">
                        {snapshotRepairMissingFile.value?.name ?? '尚未載入快照存檔'}
                      </span>
                    </div>
                    <div class="text-xs opacity-70">
                      掃出空號後會先排除不自然大段空號，再依下方模式查詢剩餘 ID。
                    </div>
                    <div class="rounded border border-[var(--n-border-color)] px-3 py-2 flex flex-col gap-2">
                      <div class="flex items-center gap-2 flex-wrap">
                        <span class="shrink-0">不正常空號值：連續空號超過</span>
                        <NInputNumber
                          size="tiny"
                          class="w-24"
                          min={0}
                          precision={0}
                          value={snapshotRepairGapLimit.value}
                          disabled={snapshotRepairRunning.value}
                          onUpdate:value={(value) => {
                            snapshotRepairGapLimit.value = Math.max(0, Math.floor(Number(value ?? 0)))
                          }}
                        />
                        <span>個就排除</span>
                        <NButton
                          size="tiny"
                          secondary
                          disabled={snapshotRepairMissingFile.value === null || snapshotRepairRunning.value}
                          onClick={() => refreshSnapshotRepairGapAnalysis()}>
                          掃描
                        </NButton>
                      </div>
                      {snapshotRepairMissingGapAnalysis.value !== null && (
                        <div class="flex flex-col gap-2">
                          <div class="text-xs opacity-75">
                            最大 ID：{snapshotRepairMissingGapAnalysis.value.maxId}，總空號：
                            {snapshotRepairMissingGapAnalysis.value.totalMissing}。不自然區段排除{' '}
                            {snapshotRepairMissingGapAnalysis.value.unnaturalMissingTotal} 個編號；排除後剩餘編號{' '}
                            {snapshotRepairMissingGapAnalysis.value.remainingIdCount} 個，剩餘空號{' '}
                            {snapshotRepairMissingGapAnalysis.value.remainingMissingCount} 個。
                          </div>
                          {snapshotRepairMissingGapAnalysis.value.ranges.length > 0 && (
                            <div class="max-h-32 overflow-auto rounded bg-black/20 p-2 flex flex-col gap-1">
                              {snapshotRepairMissingGapAnalysis.value.ranges.map((range) => (
                                <div key={`${range.start}-${range.end}`} class="text-yellow-300">
                                  ID {range.start} - {range.end}，連續缺號 {range.count} 個
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    <div class="rounded border border-[var(--n-border-color)] px-3 py-2 flex flex-col gap-2">
                      <span class="font-medium opacity-90">修復搜尋模式</span>
                      <NRadioGroup
                        value={snapshotRepairSearchMode.value}
                        disabled={snapshotRepairRunning.value}
                        onUpdate:value={(value) => {
                          if (value === 'conservative' || value === 'aggressive') {
                            snapshotRepairSearchMode.value = value
                          }
                        }}>
                        <div class="flex flex-col gap-1.5">
                          <NRadio value="conservative">保守模式</NRadio>
                          <NRadio value="aggressive">激進模式(搭配VPN使用)</NRadio>
                        </div>
                      </NRadioGroup>
                    </div>
                  </div>
                  {snapshotRepairProgress.value !== null && (
                    <div class="rounded border border-[var(--n-border-color)] px-3 py-3 flex flex-col gap-2">
                      <div class="font-medium">{snapshotRepairProgress.value.phase}</div>
                      <div class="text-xs opacity-75">{snapshotRepairProgress.value.detail}</div>
                      <div class="text-xs opacity-75">已用時：{snapshotRepairElapsedText.value}</div>
                      <div class="h-2 rounded bg-black/30 overflow-hidden">
                        <div
                          class="h-full bg-[var(--n-color-target)] transition-all"
                          style={{
                            width: `${Math.min(
                              100,
                              snapshotRepairProgress.value.total <= 0
                                ? 0
                                : (snapshotRepairProgress.value.current / snapshotRepairProgress.value.total) * 100,
                            )}%`,
                          }}
                        />
                      </div>
                      <div class="text-xs opacity-75">
                        {snapshotRepairProgress.value.current} / {snapshotRepairProgress.value.total}
                      </div>
                    </div>
                  )}
                </div>
              ),
              action: () => (
                <div class="w-full flex justify-center gap-3">
                  {snapshotRepairRunning.value && (
                    <NButton type="warning" onClick={() => cancelSnapshotRepair()}>
                      終止
                    </NButton>
                  )}
                  <NButton type="primary" loading={snapshotRepairRunning.value} onClick={() => void startSnapshotRepair()}>
                    開始
                  </NButton>
                </div>
              ),
            }}
          </NDialog>
        </NModal>

        <NModal show={snapshotRepairSortDone.value !== null} onUpdate:show={(v) => !v && completeSnapshotSortDone()}>
          <NDialog
            showIcon={false}
            title="排序校準完成"
            style={{ width: '32rem', maxWidth: '92vw' }}
            positiveText="完成"
            onPositiveClick={() => completeSnapshotSortDone()}
            onClose={() => completeSnapshotSortDone()}>
            {snapshotRepairSortDone.value !== null && (
              <div class="flex flex-col gap-2 text-sm leading-relaxed opacity-85">
                <div>已生成排序校準快照存檔。</div>
                <div>空號數量：{snapshotRepairSortDone.value.missingCount}</div>
                <div class="break-all">檔案：{snapshotRepairSortDone.value.path}</div>
                <div>按「完成」後會自動勾選缺號修復，並載入這份校準後存檔。</div>
              </div>
            )}
          </NDialog>
        </NModal>

        <NModal show={snapshotRepairResultShowing.value} onUpdate:show={(v) => !v && (snapshotRepairResultShowing.value = false)}>
          <NDialog
            showIcon={false}
            title="缺號修復結果"
            style={{ width: '38rem', maxWidth: '94vw' }}
            onClose={() => (snapshotRepairResultShowing.value = false)}>
            {{
              default: () => (
                <div class="flex flex-col gap-3 text-sm leading-relaxed">
                  <div class="opacity-80">
                    找到 {snapshotRepairSearchResults.value.filter((item) => item.found).length} 個，未找到{' '}
                    {snapshotRepairSearchResults.value.filter((item) => !item.found).length} 個。
                  </div>
                  {snapshotRepairFoundSnapshotPath.value !== null && (
                    <div class="text-xs opacity-75 break-all">修復快照：{snapshotRepairFoundSnapshotPath.value}</div>
                  )}
                  {snapshotRepairLogPath.value !== null && (
                    <div class="text-xs opacity-75 break-all">LOG：{snapshotRepairLogPath.value}</div>
                  )}
                  <div class="max-h-72 overflow-auto rounded border border-[var(--n-border-color)] p-2 flex flex-col gap-1">
                    {snapshotRepairSearchResults.value.map((item) => (
                      <div key={item.id} class={item.found ? 'text-green-400' : 'text-red-400'}>
                        ID {item.id}：{item.found ? '找到' : '未找到'}
                      </div>
                    ))}
                  </div>
                </div>
              ),
              action: () => (
                <div class="w-full flex justify-center">
                  <NButton type="primary" onClick={() => void mergeSnapshotRepairResults()}>
                    開始合併
                  </NButton>
                </div>
              ),
            }}
          </NDialog>
        </NModal>

        <NModal show={scopedSearchConfirmShowing.value} onUpdate:show={(v) => !v && resolveScopedSearchConfirm(false)}>
          <NDialog
            showIcon={false}
            title="分類搜尋確認"
            style={{ width: '34rem', maxWidth: '92vw' }}
            positiveText="確定開始"
            negativeText="取消"
            positiveButtonProps={{ disabled: scopedSearchPageEstimate.value.status === 'loading' }}
            onPositiveClick={() => resolveScopedSearchConfirm(true)}
            onNegativeClick={() => resolveScopedSearchConfirm(false)}
            onClose={() => resolveScopedSearchConfirm(false)}>
            <div class="flex flex-col gap-3 text-sm leading-relaxed opacity-85">
              <div>主/子分類搜尋需要先掃描目前分類，可能會花比較多時間。</div>
              <div>掃描完成後，快照會儲存在「我的收藏」內的「收藏快照」。</div>
              <div>若預計掃描頁數低於 100 頁，會使用快速並行掃描，通常可瞬間完成。</div>
              <div class="rounded border border-[var(--n-border-color)] px-3 py-2">{scopedSearchEstimateLabel()}</div>
              <div class="flex flex-col gap-2 rounded border border-[var(--n-border-color)] px-3 py-2">
                <span class="font-medium opacity-90">掃描模式</span>
                <NRadioGroup
                  value={scopedSearchScanMode.value}
                  onUpdate:value={(value) => {
                    if (value === 'conservative' || value === 'aggressive') {
                      setScopedSearchScanMode(value)
                    }
                  }}>
                  <div class="flex flex-col gap-1.5">
                    <NRadio value="conservative">保守模式</NRadio>
                    <NRadio value="aggressive">激進模式</NRadio>
                  </div>
                </NRadioGroup>
              </div>
            </div>
          </NDialog>
        </NModal>

        <NModal
          show={globalSnapshotResumeShowing.value}
          zIndex={20000}
          maskClosable={false}
          onUpdate:show={(v) => {
            if (!v) {
              resolveGlobalSnapshotResume(false)
            }
          }}>
          <NDialog
            showIcon={false}
            title="選擇接續掃描快照"
            style={{ width: '32rem', maxWidth: '92vw' }}
            positiveText={
              globalSnapshotResumeSelectedIds.value.length > 0
                ? `接續掃描（${globalSnapshotResumeSelectedIds.value.length} 項）`
                : '接續掃描'
            }
            onPositiveClick={() => {
              if (globalSnapshotResumeSelectedIds.value.length === 0) {
                message.warning('請至少選擇一個要接續的快照')
                return false
              }
              resolveGlobalSnapshotResume(true)
              return true
            }}
            onClose={() => resolveGlobalSnapshotResume(false)}>
            <div class="flex flex-col gap-2 text-sm">
              <div class="opacity-75">
                可複選多個分類快照，將依列表順序排隊接續掃描。完成度 100% 會走更新掃描；未滿 100% 會從目前完成度接續到最新。
              </div>
              <NCheckbox
                checked={globalSnapshotResumeAllSelected.value}
                indeterminate={globalSnapshotResumeSelectIndeterminate.value}
                onUpdate:checked={(checked) => setGlobalSnapshotResumeSelectAll(checked)}>
                全選
              </NCheckbox>
              <div class="max-h-72 overflow-auto flex flex-col gap-1 border border-[var(--n-border-color)] rounded px-2 py-1">
                {globalSnapshotMetas.value.map((snapshot) => {
                  const isComplete = isSnapshotScanComplete(snapshot)
                  const checked = globalSnapshotResumeSelectedIds.value.includes(snapshot.id)
                  return (
                    <NCheckbox
                      key={snapshot.id}
                      checked={checked}
                      onUpdate:checked={(value) => toggleGlobalSnapshotResumeSelection(snapshot.id, value)}>
                      <div class="flex flex-col leading-snug">
                        <span>
                          {globalSnapshotLabel(snapshot)} · {isComplete ? '更新' : '接續'}
                        </span>
                        <span class="text-xs opacity-60">
                          共{snapshot.totalCount}本 · 完成度 {scanCacheCompletionPercent(snapshot)}% · 已掃{' '}
                          {snapshot.scanCompletedPages ?? 0}/{snapshot.totalPages} 頁
                        </span>
                      </div>
                    </NCheckbox>
                  )
                })}
              </div>
              <div class="flex flex-col gap-2 rounded border border-[var(--n-border-color)] px-3 py-2">
                <span class="font-medium opacity-90">掃描模式</span>
                <div class="flex flex-col gap-2">
                  <div
                    role="button"
                    tabIndex={0}
                    class={
                      globalSnapshotScanMode.value === 'conservative'
                        ? 'cursor-pointer rounded border border-blue-500 bg-blue-500/10 px-3 py-2'
                        : 'cursor-pointer rounded border border-[var(--n-border-color)] px-3 py-2 hover:border-blue-400/60'
                    }
                    onClick={() => selectGlobalSnapshotScanMode('conservative')}
                    onKeydown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        selectGlobalSnapshotScanMode('conservative')
                      }
                    }}>
                    <div class="font-medium">保守模式</div>
                    {globalSnapshotResumeStrategy.value === 'idUpdate' && (
                      <div class="text-xs opacity-70 mt-0.5">
                        ID 更新：模擬手點（10～30 頁／批，間隔 500～1500 ms）與並行請求（30～40
                        頁／批）交替進行；首輪必為模擬手點；遇 Cloudflare 挑戰等待 20 秒重試。
                      </div>
                    )}
                  </div>
                  <div
                    role="button"
                    tabIndex={0}
                    class={
                      globalSnapshotScanMode.value === 'aggressive'
                        ? 'cursor-pointer rounded border border-blue-500 bg-blue-500/10 px-3 py-2'
                        : 'cursor-pointer rounded border border-[var(--n-border-color)] px-3 py-2 hover:border-blue-400/60'
                    }
                    onClick={() => selectGlobalSnapshotScanMode('aggressive')}
                    onKeydown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        selectGlobalSnapshotScanMode('aggressive')
                      }
                    }}>
                    <div class="font-medium">激進模式(搭配VPN使用)</div>
                    {globalSnapshotResumeStrategy.value === 'idUpdate' && (
                      <div class="text-xs opacity-70 mt-0.5">ID 更新：每批 100～200 頁並行請求（與全量快照激進相同）。</div>
                    )}
                  </div>
                </div>
              </div>
              <div class="flex flex-col gap-2 rounded border border-[var(--n-border-color)] px-3 py-2">
                <span class="font-medium opacity-90">接續方式</span>
                <div class="flex flex-col gap-2">
                  <div
                    role="button"
                    tabIndex={0}
                    class={
                      globalSnapshotResumeStrategy.value === 'page'
                        ? 'cursor-pointer rounded border border-blue-500 bg-blue-500/10 px-3 py-2'
                        : 'cursor-pointer rounded border border-[var(--n-border-color)] px-3 py-2 hover:border-blue-400/60'
                    }
                    onClick={() => selectGlobalSnapshotResumeStrategy('page')}
                    onKeydown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        selectGlobalSnapshotResumeStrategy('page')
                      }
                    }}>
                    <div class="font-medium">頁碼接續</div>
                    <div class="text-xs opacity-70 mt-0.5">從斷點與待補掃頁繼續，適合剛中斷後馬上接續。</div>
                  </div>
                  <div
                    role="button"
                    tabIndex={0}
                    class={
                      globalSnapshotResumeStrategy.value === 'idUpdate'
                        ? 'cursor-pointer rounded border border-blue-500 bg-blue-500/10 px-3 py-2'
                        : 'cursor-pointer rounded border border-[var(--n-border-color)] px-3 py-2 hover:border-blue-400/60'
                    }
                    onClick={() => selectGlobalSnapshotResumeStrategy('idUpdate')}
                    onKeydown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        selectGlobalSnapshotResumeStrategy('idUpdate')
                      }
                    }}>
                    <div class="font-medium">ID 更新式接續</div>
                    <div class="text-xs opacity-70 mt-0.5">從第 1 頁開始掃描，遇到已存在 ID 即略過，適合隔一段時間後接續。</div>
                    {globalSnapshotResumeStrategy.value === 'idUpdate' && (
                      <div
                        class="flex items-center gap-2 flex-wrap mt-2 pt-2 border-t border-[var(--n-border-color)]"
                        onClick={(event) => event.stopPropagation()}>
                        <span class="text-xs opacity-70 shrink-0">超過</span>
                        <NInputNumber
                          size="tiny"
                          class="w-24"
                          min={0}
                          precision={0}
                          value={globalSnapshotIdUpdateDuplicateLimit.value}
                          onUpdate:value={(value) => {
                            const next = normalizeGlobalSnapshotIdUpdateDuplicateLimit(value)
                            globalSnapshotIdUpdateDuplicateLimit.value = next
                            saveGlobalSnapshotIdUpdateDuplicateLimit(next)
                          }}
                        />
                        <span class="text-xs opacity-70">個重複 ID 時停止</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </NDialog>
        </NModal>

        <NModal
          show={globalSnapshotConfirmShowing.value}
          zIndex={20000}
          onUpdate:show={(v) => !v && resolveGlobalSnapshotConfirm(false)}>
          <NDialog
            showIcon={false}
            title={
              globalSnapshotConfirmMode.value === 'resume'
                ? '快照接續掃描確認'
                : globalSnapshotConfirmMode.value === 'update'
                  ? '快照更新確認'
                  : '快照掃描確認'
            }
            style={{ width: '32rem', maxWidth: '92vw' }}
            positiveText="確定開始"
            onPositiveClick={() => resolveGlobalSnapshotConfirm(true)}
            onClose={() => resolveGlobalSnapshotConfirm(false)}>
            <div class="flex flex-col gap-3 text-sm leading-relaxed opacity-85">
              <div>
                {globalSnapshotConfirmMode.value === 'update'
                  ? '更新快照會以同分類已完成快照為基底，重新掃描分類並合併新增內容。'
                  : '快照掃描會花上一段時間，完成後會依分類分別保存為快照。'}
              </div>
              <div>掃描期間可隨時取消，已掃描到的內容仍會保存；單一分類掃描 100% 完成後會自動生成最終快照存檔。</div>
              {globalSnapshotConfirmMode.value === 'scan' && (
                <div class="flex flex-col gap-2 rounded border border-[var(--n-border-color)] px-3 py-2">
                  <span class="font-medium opacity-90">掃描分類</span>
                  <div class="max-h-56 overflow-auto flex flex-col gap-1 pr-1">
                    {SNAPSHOT_SCAN_TARGET_OPTIONS.map((target) => (
                      <NCheckbox
                        key={target.key}
                        checked={globalSnapshotScanTargetKeys.value.includes(target.key)}
                        onUpdate:checked={(checked) => toggleGlobalSnapshotScanTarget(target.key, Boolean(checked))}>
                        {target.label}
                      </NCheckbox>
                    ))}
                  </div>
                </div>
              )}
              <div class="flex flex-col gap-2 rounded border border-[var(--n-border-color)] px-3 py-2">
                <span class="font-medium opacity-90">掃描模式</span>
                <NRadioGroup
                  value={globalSnapshotScanMode.value}
                  onUpdate:value={(value) => {
                    if (value === 'conservative' || value === 'aggressive') {
                      globalSnapshotScanMode.value = value
                    }
                  }}>
                  <div class="flex flex-col gap-1.5">
                    <NRadio value="conservative">保守模式</NRadio>
                    <NRadio value="aggressive">激進模式(搭配VPN使用)</NRadio>
                  </div>
                </NRadioGroup>
              </div>
            </div>
          </NDialog>
        </NModal>

        {isScopedScanOverlay.value && (
          <Teleport to="body">
            <div class="fixed inset-0 z-[9998] flex items-center justify-center bg-black/55">
              <div class="flex flex-col items-center gap-4 px-8 py-6 rounded-xl bg-[#2a2a2a] border border-[rgba(255,255,255,0.14)] shadow-xl min-w-80 max-w-[92vw]">
                <NSpin show={!isManualScanRequestWaiting.value && !scopedSearchProgress.value?.paused} size="large" />
                <span class="text-sm text-gray-100 text-center leading-relaxed">{loadingDescription.value}</span>
                <div class="flex items-center gap-8">
                  {isManualScanRequestWaiting.value && (
                    <NButton type="primary" onClick={() => sendManualScanRequest()}>
                      發送請求
                    </NButton>
                  )}
                  <NButton type="warning" onClick={() => cancelScopedSearch()}>
                    取消掃描
                  </NButton>
                </div>
              </div>
            </div>
          </Teleport>
        )}

        {globalSnapshotKeywordSearchProgress.value !== null && !isGlobalSnapshotDialogOpen.value && (
          <Teleport to="body">
            <div class="fixed inset-0 z-[9998] flex items-center justify-center bg-black/55">
              <div class="flex flex-col items-center gap-4 px-8 py-6 rounded-xl bg-[#2a2a2a] border border-[rgba(255,255,255,0.14)] shadow-xl min-w-80 max-w-[92vw]">
                <NSpin show size="large" />
                <span class="text-sm text-gray-100 text-center leading-relaxed">{loadingDescription.value}</span>
                {globalSnapshotKeywordSearchProgress.value.total > 0 && (
                  <div class="w-72 max-w-full flex flex-col gap-1">
                    <div class="h-2 rounded bg-black/30 overflow-hidden">
                      <div
                        class="h-full bg-blue-500 transition-all"
                        style={{ width: `${globalSnapshotKeywordSearchPercent.value}%` }}
                      />
                    </div>
                    <div class="text-xs text-center opacity-75">{globalSnapshotKeywordSearchPercent.value}%</div>
                  </div>
                )}
              </div>
            </div>
          </Teleport>
        )}

        {koreanModeLoadProgress.value !== null && !isGlobalSnapshotDialogOpen.value && (
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
      renderScopedScanCachesPane,
      renderGlobalSnapshotTabControls,
    }
  },

  render() {
    return this.render()
  },
})
