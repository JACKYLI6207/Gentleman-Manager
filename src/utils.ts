import type { ImgInImgList } from './bindings.ts'

export function extractComicId(input: string): number | undefined {
  // 如果是數字，直接返回
  const comicId = parseInt(input)
  if (!isNaN(comicId)) {
    return comicId
  }
  // 否則需要從鏈接中提取
  const regex = /aid-(\d+)/
  const match = input.match(regex)
  if (match === null || match[1] === null) {
    return
  }
  return parseInt(match[1])
}

function decodeTagSlug(slug: string): string {
  try {
    return decodeURIComponent(slug)
  } catch {
    return slug
  }
}

/** 從完整 URL 或路徑取出 pathname */
function toTagLinkPath(input: string): string {
  const trimmed = input.trim()
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      return new URL(trimmed).pathname
    }
    if (trimmed.startsWith('//')) {
      return new URL(`https:${trimmed}`).pathname
    }
  } catch {
    // 非合法 URL，按路徑處理
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

/**
 * 從標籤列表頁鏈接解析標籤 slug 與頁碼。
 * 支援站內常見兩種路徑：
 * - /albums-index-tag-{slug}.html
 * - /albums-index-page-{n}-tag-{slug}.html
 */
export function parseTagSearchLink(input: string): { tagSlug: string; page: number } | undefined {
  const path = toTagLinkPath(input)

  const withPage = path.match(/\/albums-index-page-(\d+)-tag-([^/?#]+?)\.html/i)
  if (withPage?.[1] !== undefined && withPage[2] !== undefined) {
    const page = parseInt(withPage[1], 10)
    if (!isNaN(page) && page >= 1) {
      return { tagSlug: decodeTagSlug(withPage[2]), page }
    }
  }

  const tagOnly = path.match(/\/albums-index-tag-([^/?#]+?)\.html/i)
  if (tagOnly?.[1] !== undefined) {
    return { tagSlug: decodeTagSlug(tagOnly[1]), page: 1 }
  }

  return undefined
}

export type SearchSortOrder = 'createDateAsc' | 'createDateDesc' | 'titleAsc' | 'titleDesc' | 'comicIdAsc' | 'comicIdDesc'

export const DEFAULT_SEARCH_SORT_ORDER: SearchSortOrder = 'comicIdDesc'
const SEARCH_SORT_ORDER_STORAGE_KEY = 'searchSortOrder'

/** 搜尋結果卡片只顯示「N張照片/圖片」，不含創建時間等後綴 */
export function formatSearchPhotoInfo(additionalInfo: string): string {
  const match = additionalInfo.match(/\d+\s*張(?:照片|圖片)/)
  if (match !== null) {
    return match[0]
  }
  const beforeCreated = additionalInfo.split('創建於')[0]?.trim().replace(/[，,\s]+$/, '') ?? ''
  return beforeCreated || additionalInfo.trim().replace(/[，,\s]+$/, '')
}

/** 從搜尋結果 additionalInfo 解析創建時間戳（毫秒） */
export function parseComicCreatedAt(additionalInfo: string): number {
  const match = additionalInfo.match(/創建於(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}):(\d{2}):(\d{2}))?/)
  if (match === null) {
    return 0
  }
  const hour = match[2] ?? '00'
  const minute = match[3] ?? '00'
  const second = match[4] ?? '00'
  const timestamp = Date.parse(`${match[1]}T${hour}:${minute}:${second}`)
  return Number.isNaN(timestamp) ? 0 : timestamp
}

export function compareComicTitle(a: string, b: string): number {
  return a.localeCompare(b, 'zh-Hant', { numeric: true, sensitivity: 'base' })
}

export function sortSearchComics<T extends { id: number; title: string; additionalInfo: string }>(
  comics: T[],
  order: SearchSortOrder,
): T[] {
  const sorted = [...comics]
  sorted.sort((a, b) => {
    switch (order) {
      case 'createDateAsc':
        return parseComicCreatedAt(a.additionalInfo) - parseComicCreatedAt(b.additionalInfo)
      case 'createDateDesc':
        return parseComicCreatedAt(b.additionalInfo) - parseComicCreatedAt(a.additionalInfo)
      case 'titleAsc':
        return compareComicTitle(a.title, b.title)
      case 'titleDesc':
        return compareComicTitle(b.title, a.title)
      case 'comicIdAsc':
        return a.id - b.id
      case 'comicIdDesc':
        return b.id - a.id
    }
  })
  return sorted
}

export const SEARCH_SORT_OPTIONS: { label: string; key: SearchSortOrder }[] = [
  { label: 'ID編號降序', key: 'comicIdDesc' },
  { label: 'ID編號升序', key: 'comicIdAsc' },
  { label: '創建日期降序', key: 'createDateDesc' },
  { label: '創建日期升序', key: 'createDateAsc' },
  { label: '漫畫名稱降序', key: 'titleDesc' },
  { label: '漫畫名稱升序', key: 'titleAsc' },
]

export function isSearchSortOrder(value: string): value is SearchSortOrder {
  return SEARCH_SORT_OPTIONS.some((option) => option.key === value)
}

export function loadSavedSearchSortOrder(): SearchSortOrder {
  const saved = localStorage.getItem(SEARCH_SORT_ORDER_STORAGE_KEY)
  return saved !== null && isSearchSortOrder(saved) ? saved : DEFAULT_SEARCH_SORT_ORDER
}

export function saveSearchSortOrder(order: SearchSortOrder) {
  localStorage.setItem(SEARCH_SORT_ORDER_STORAGE_KEY, order)
}

/** 官網閱讀用圖片列表（過濾收藏提示圖） */
export function getReaderPages(imgList: ImgInImgList[]): ImgInImgList[] {
  return imgList.filter((img) => !img.url.endsWith('shoucang.jpg'))
}
