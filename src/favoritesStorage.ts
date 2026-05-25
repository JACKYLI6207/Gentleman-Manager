import type { ComicInSearch } from './bindings.ts'

const STORAGE_KEY = 'myFavoriteComics'

export function loadFavoriteComics(): ComicInSearch[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null || raw === '') {
      return []
    }
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.filter(
      (item): item is ComicInSearch =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as ComicInSearch).id === 'number' &&
        typeof (item as ComicInSearch).title === 'string' &&
        typeof (item as ComicInSearch).cover === 'string',
    )
  } catch {
    return []
  }
}

export function saveFavoriteComics(comics: ComicInSearch[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(comics))
}
