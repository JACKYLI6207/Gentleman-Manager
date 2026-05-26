import type { ComicInSearch, SearchResult } from '../bindings.ts'
import type { RankingPeriod } from '../categories.ts'
import { DEFAULT_SEARCH_SORT_ORDER, type SearchSortOrder } from '../utils.ts'
import { getTagLabelFromSearch } from '../koreanWebtoon.ts'
import { RANKING_PERIOD_OPTIONS } from '../categories.ts'

export type SearchSource =
  | { type: 'keyword'; cateId?: number }
  | { type: 'tag'; source: 'name' | 'link'; cateId?: number }
  | { type: 'category'; cateId: number }
  | { type: 'albums'; list: 'home' | 'albums' }
  | { type: 'ranking'; period: RankingPeriod; cateId: number | null }

export interface SearchResultTabState {
  id: string
  title: string
  keywordOrComicLinkInput: string
  tagOrLinkInput: string
  activeTagSearchSource: 'name' | 'link'
  searchSource: SearchSource
  searchScopeCategory: { cateId: number; label: string } | null
  activeTagLabel: string
  activeCategoryLabel: string
  rankingPeriod: RankingPeriod
  viewPage: number
  allSearchComics: ComicInSearch[]
  sortedComics: ComicInSearch[]
  visibleComics: ComicInSearch[]
  pageCacheEntries: [number, SearchResult][]
  sortOrder: SearchSortOrder
  catalogAnalysisEntries: [number, string][]
  totalServerPagesHint: number
  totalCountHint: number
  /** 已依實際尾端下修總筆數；勿再用官網 <b> 放大 */
  totalCountRefined?: boolean
  lastCommittedViewPage: number
  searchSession: number
  coverLoadLimit: number
  searchResult?: SearchResult
  listScrollTop: number
  /** 慢速掃描分類完成後的完整列表；收藏分頁還原時離線分頁，不再觸發全站掃描 */
  scopedOfflineMatches?: ComicInSearch[]
}

const TAB_TITLE_MAX = 28

function truncateTitle(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= TAB_TITLE_MAX) {
    return trimmed
  }
  return `${trimmed.slice(0, TAB_TITLE_MAX)}…`
}

export function formatSearchResultTabTitle(input: {
  searchSource: SearchSource
  keywordOrComicLinkInput: string
  tagOrLinkInput: string
  activeTagSearchSource: 'name' | 'link'
  activeTagLabel: string
  activeCategoryLabel: string
  searchScopeCategory: { label: string } | null
  rankingPeriod: RankingPeriod
}): string {
  const scope = input.searchScopeCategory
  const source = input.searchSource

  if (source.type === 'keyword') {
    const kw = input.keywordOrComicLinkInput.trim()
    if (kw === '') {
      return truncateTitle(input.activeCategoryLabel || '關鍵詞搜尋')
    }
    return truncateTitle(scope !== null ? `${scope.label} · ${kw}` : kw)
  }

  if (source.type === 'tag') {
    const tag =
      input.activeTagLabel ||
      getTagLabelFromSearch(input.tagOrLinkInput, input.activeTagSearchSource)
    if (tag === '') {
      return truncateTitle(input.activeCategoryLabel || '標籤搜尋')
    }
    return truncateTitle(scope !== null && source.cateId !== undefined ? `${scope.label} · ${tag}` : tag)
  }

  if (source.type === 'ranking') {
    const periodLabel = RANKING_PERIOD_OPTIONS.find((o) => o.key === source.period)?.label ?? ''
    const base = input.activeCategoryLabel || '排行'
    const label = periodLabel !== '' ? `${periodLabel} · ${base}` : base
    return truncateTitle(label)
  }

  if (source.type === 'category') {
    return truncateTitle(input.activeCategoryLabel || '分類瀏覽')
  }

  if (source.type === 'albums') {
    return truncateTitle(input.activeCategoryLabel || (source.list === 'home' ? '首頁' : '專輯'))
  }

  return '搜尋結果'
}

export function createEmptySearchResultTab(title: string, searchSession: number): SearchResultTabState {
  return {
    id: crypto.randomUUID(),
    title: truncateTitle(title),
    keywordOrComicLinkInput: '',
    tagOrLinkInput: '',
    activeTagSearchSource: 'name',
    searchSource: { type: 'keyword' },
    searchScopeCategory: null,
    activeTagLabel: '',
    activeCategoryLabel: '',
    rankingPeriod: 'Week',
    viewPage: 1,
    allSearchComics: [],
    sortedComics: [],
    visibleComics: [],
    pageCacheEntries: [],
    sortOrder: DEFAULT_SEARCH_SORT_ORDER,
    catalogAnalysisEntries: [],
    totalServerPagesHint: 1,
    totalCountHint: 0,
    lastCommittedViewPage: 1,
    searchSession,
    coverLoadLimit: 20,
    searchResult: undefined,
    listScrollTop: 0,
    scopedOfflineMatches: undefined,
  }
}
