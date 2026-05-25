import type { SearchResultTabState } from './panes/searchResultTabTypes.ts'

const STORAGE_KEY = 'wnacg.searchResultTabs.v1'

export interface SavedSearchResultTabs {
  tabs: SearchResultTabState[]
  activeTabId: string | null
}

function isSearchResultTabState(value: unknown): value is SearchResultTabState {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const tab = value as SearchResultTabState
  return (
    typeof tab.id === 'string' &&
    typeof tab.title === 'string' &&
    typeof tab.keywordOrComicLinkInput === 'string' &&
    typeof tab.tagOrLinkInput === 'string' &&
    Array.isArray(tab.allSearchComics) &&
    Array.isArray(tab.pageCacheEntries)
  )
}

export function loadSearchResultTabs(): SavedSearchResultTabs | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null || raw === '') {
      return null
    }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      return null
    }
    const tabs = (parsed as SavedSearchResultTabs).tabs
    if (!Array.isArray(tabs) || tabs.length === 0) {
      return null
    }
    const validTabs = tabs.filter(isSearchResultTabState)
    if (validTabs.length === 0) {
      return null
    }
    const activeTabId = (parsed as SavedSearchResultTabs).activeTabId
    const resolvedActiveId =
      typeof activeTabId === 'string' && validTabs.some((t) => t.id === activeTabId)
        ? activeTabId
        : validTabs[0]!.id
    return { tabs: validTabs, activeTabId: resolvedActiveId }
  } catch {
    return null
  }
}

export function saveSearchResultTabs(tabs: SearchResultTabState[], activeTabId: string | null) {
  if (tabs.length === 0) {
    localStorage.removeItem(STORAGE_KEY)
    return
  }
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      tabs,
      activeTabId,
    } satisfies SavedSearchResultTabs),
  )
}
