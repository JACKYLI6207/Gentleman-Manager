import type { SearchTabBookmark } from './panes/searchTabBookmarkTypes.ts'

const STORAGE_KEY = 'wnacg.favoriteSearchTabs.v1'

function isSearchTabBookmark(value: unknown): value is SearchTabBookmark {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const item = value as SearchTabBookmark
  return (
    typeof item.id === 'string' &&
    typeof item.savedAt === 'string' &&
    typeof item.title === 'string' &&
    typeof item.tabState === 'object' &&
    item.tabState !== null &&
    typeof item.tabState.id === 'string' &&
    typeof item.tabState.title === 'string' &&
    Array.isArray(item.tabState.allSearchComics)
  )
}

export function loadFavoriteSearchTabs(): SearchTabBookmark[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null || raw === '') {
      return []
    }
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.filter(isSearchTabBookmark)
  } catch {
    return []
  }
}

export function saveFavoriteSearchTabs(bookmarks: SearchTabBookmark[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(bookmarks))
}
