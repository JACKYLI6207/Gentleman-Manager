import type { ComicInSearch, SearchResult } from '../bindings.ts'
import type { SearchResultTabState, SearchSource } from './searchResultTabTypes.ts'

const COVER_LOAD_BATCH = 20
/** 後端 from_collected 每頁筆數，與官網列表 20 不同 */
export const SCOPED_COLLECTED_PAGE_SIZE = 20

export interface SearchTabBookmark {
  id: string
  sourceTabId: string
  savedAt: string
  title: string
  tabState: SearchResultTabState
}

/** 收藏分頁列表：關鍵詞／標籤詞搜尋類型標記 */
export function searchTabBookmarkKindLabel(source: SearchSource): string | null {
  if (source.type === 'keyword') {
    return '關鍵詞'
  }
  if (source.type === 'tag') {
    return '標籤詞'
  }
  return null
}

export function isScopedSearchSource(source: SearchSource): boolean {
  if (source.type === 'keyword' && source.cateId !== undefined) {
    return true
  }
  return source.type === 'tag' && source.cateId !== undefined
}

/** 收藏只存遠端封面 URL，不存已下載的 blob／圖檔。 */
function isRemoteCoverUrl(cover: string): boolean {
  const trimmed = cover.trim()
  return trimmed.startsWith('http://') || trimmed.startsWith('https://')
}

export function comicForBookmarkStorage(comic: ComicInSearch): ComicInSearch {
  if (isRemoteCoverUrl(comic.cover)) {
    return comic
  }
  if (comic.cover === '') {
    return comic
  }
  return { ...comic, cover: '' }
}

export function comicsForBookmarkStorage(comics: ComicInSearch[]): ComicInSearch[] {
  return comics.map(comicForBookmarkStorage)
}

/** 收藏分頁：保留離線列表與封面 URL；不存當前頁快照與已載入圖。 */
export function sanitizeTabStateForBookmark(tab: SearchResultTabState): SearchResultTabState {
  const scoped = isScopedSearchSource(tab.searchSource)

  if (scoped) {
    return {
      ...tab,
      allSearchComics: [],
      sortedComics: [],
      visibleComics: [],
      scopedOfflineMatches:
        tab.scopedOfflineMatches !== undefined
          ? comicsForBookmarkStorage(tab.scopedOfflineMatches)
          : undefined,
      pageCacheEntries: [],
      catalogAnalysisEntries: [],
      coverLoadLimit: COVER_LOAD_BATCH,
      searchResult: undefined,
      listScrollTop: 0,
    }
  }

  const searchResult =
    tab.searchResult === undefined
      ? undefined
      : {
          ...tab.searchResult,
          comics: comicsForBookmarkStorage(tab.searchResult.comics),
        }

  return {
    ...tab,
    allSearchComics: comicsForBookmarkStorage(tab.allSearchComics),
    sortedComics: comicsForBookmarkStorage(tab.sortedComics),
    visibleComics: comicsForBookmarkStorage(tab.visibleComics),
    pageCacheEntries: [...tab.pageCacheEntries],
    catalogAnalysisEntries: [],
    coverLoadLimit: COVER_LOAD_BATCH,
    searchResult,
    listScrollTop: 0,
  }
}

export function cloneTabStateForRestore(
  tab: SearchResultTabState,
  newTabId: string,
): SearchResultTabState {
  return {
    ...tab,
    id: newTabId,
    scopedOfflineMatches:
      tab.scopedOfflineMatches !== undefined
        ? comicsForBookmarkStorage(tab.scopedOfflineMatches)
        : undefined,
    pageCacheEntries: isScopedSearchSource(tab.searchSource) ? [] : [...tab.pageCacheEntries],
    coverLoadLimit: COVER_LOAD_BATCH,
    listScrollTop: 0,
  }
}

export function buildCollectedPageResult(
  matches: ComicInSearch[],
  collectedPage: number,
  isSearchByTag: boolean,
): SearchResult {
  const totalCount = matches.length
  const totalPage = Math.max(1, Math.ceil(totalCount / SCOPED_COLLECTED_PAGE_SIZE))
  const pageNum = Math.min(Math.max(1, collectedPage), totalPage)
  const start = (pageNum - 1) * SCOPED_COLLECTED_PAGE_SIZE
  const end = Math.min(start + SCOPED_COLLECTED_PAGE_SIZE, matches.length)
  const comics = matches.slice(start, end)

  return {
    comics,
    currentPage: pageNum,
    totalPage,
    totalCount,
    isSearchByTag,
  }
}
