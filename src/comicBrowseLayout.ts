export type SearchResultLayout = 'list' | 'grid4' | 'grid6' | 'grid8' | 'grid10'

export const COVER_LOAD_BATCH = 20
export const PAGE_SIZE_OPTIONS = [20, 40, 60, 80, 100] as const
export const SEARCH_PAGE_SIZE_STORAGE_KEY = 'searchDisplayPageSize'
export const SEARCH_LAYOUT_STORAGE_KEY = 'searchResultLayout'

export const SEARCH_LAYOUT_OPTIONS: { key: SearchResultLayout; label: string }[] = [
  { key: 'grid4', label: '每排 4 個' },
  { key: 'grid6', label: '每排 6 個' },
  { key: 'grid8', label: '每排 8 個' },
  { key: 'grid10', label: '每排 10 個' },
  { key: 'list', label: '列表顯示' },
]

export function isGridSearchLayout(layout: SearchResultLayout): boolean {
  return layout === 'grid4' || layout === 'grid6' || layout === 'grid8' || layout === 'grid10'
}

export function comicCardLayout(layout: SearchResultLayout): 'list' | 'grid' {
  return isGridSearchLayout(layout) ? 'grid' : 'list'
}

export function gridColsClass(layout: SearchResultLayout): string {
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

export function gridColsNumber(layout: SearchResultLayout): number {
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

export function layoutOptionLabel(layout: SearchResultLayout): string {
  return SEARCH_LAYOUT_OPTIONS.find((o) => o.key === layout)?.label ?? '檢視模式'
}

export function loadSavedPageSize(): number {
  const saved = localStorage.getItem(SEARCH_PAGE_SIZE_STORAGE_KEY)
  if (saved !== null) {
    const n = parseInt(saved, 10)
    if (PAGE_SIZE_OPTIONS.includes(n as (typeof PAGE_SIZE_OPTIONS)[number])) {
      return n
    }
  }
  return 20
}

export function loadSavedSearchLayout(): SearchResultLayout {
  const saved = localStorage.getItem(SEARCH_LAYOUT_STORAGE_KEY)
  if (saved === 'list' || saved === 'grid4' || saved === 'grid6' || saved === 'grid8' || saved === 'grid10') {
    return saved
  }
  if (saved === 'grid') {
    return 'grid4'
  }
  return 'list'
}

export function saveSearchLayout(layout: SearchResultLayout) {
  localStorage.setItem(SEARCH_LAYOUT_STORAGE_KEY, layout)
}

export function savePageSize(size: number) {
  localStorage.setItem(SEARCH_PAGE_SIZE_STORAGE_KEY, String(size))
}
