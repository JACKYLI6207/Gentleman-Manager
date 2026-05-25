/** 官網頂部分類（對應 albums-index-cate-*.html） */
export type SiteCategoryItem = {
  label: string
  /** 分類 id，對應 /albums-index-cate-{id}.html */
  cateId?: number
  /** 首頁或更新列表等特殊路徑 */
  browse?: 'home' | 'albums' | 'ranking'
  /** 排行榜子分類 id；`null` 表示全部分類 */
  rankingCateId?: number | null
  children?: SiteCategoryItem[]
}

export type RankingScope = {
  label: string
  cateId?: number
}

export type RankingPeriod = 'Day' | 'Week' | 'Month' | 'Year'

export const RANKING_PERIOD_OPTIONS: { key: RankingPeriod; label: string }[] = [
  { key: 'Day', label: '今日' },
  { key: 'Week', label: '本週' },
  { key: 'Month', label: '本月' },
  { key: 'Year', label: '今年' },
]

/** 排行榜頁「全部分類」下拉選項（對應 albums-favorite_ranking-cate-*.html） */
export function listRankingScopes(): RankingScope[] {
  return [
    { label: '全部分類' },
    { label: '同人誌 / 日語', cateId: 12 },
    { label: '同人誌 / English', cateId: 16 },
    { label: '同人誌 / 漢化', cateId: 1 },
    { label: '同人誌 / CG畫集', cateId: 2 },
    { label: '單行本 / 日語', cateId: 13 },
    { label: '單行本 / English', cateId: 17 },
    { label: '單行本 / 漢化', cateId: 9 },
    { label: '雜誌&短篇 / 日語', cateId: 14 },
    { label: '雜誌&短篇 / English', cateId: 18 },
    { label: '雜誌&短篇 / 漢化', cateId: 10 },
    { label: '寫真&Cosplay', cateId: 3 },
    { label: '韓漫 / 生肉', cateId: 21 },
    { label: '韓漫 / 漢化', cateId: 20 },
    { label: '3D&漫畫 / 漢化', cateId: 23 },
    { label: '3D&漫畫 / 其他', cateId: 24 },
    { label: 'AI圖集', cateId: 37 },
  ]
}

/** 可選為「分類內搜尋」範圍的主/子分類（不含「更新」等特殊列表） */
export function listCategorySearchScopes(): { label: string; cateId: number }[] {
  const out: { label: string; cateId: number }[] = []

  function walk(items: SiteCategoryItem[], parentLabel?: string) {
    for (const item of items) {
      if (item.browse !== undefined) {
        continue
      }
      const label =
        parentLabel !== undefined ? `${parentLabel} / ${item.label}` : item.label
      if (item.cateId !== undefined) {
        out.push({ label, cateId: item.cateId })
      }
      if (item.children !== undefined) {
        walk(item.children, item.label)
      }
    }
  }

  walk(SITE_CATEGORIES)
  return out
}

export const SITE_CATEGORIES: SiteCategoryItem[] = [
  { label: '更新', browse: 'albums' },
  {
    label: '同人誌',
    cateId: 5,
    children: [
      { label: '漢化', cateId: 1 },
      { label: '日語', cateId: 12 },
      { label: 'English', cateId: 16 },
      { label: 'CG畫集', cateId: 2 },
      { label: 'AI圖集', cateId: 37 },
      { label: '3D漫畫', cateId: 22 },
      { label: 'Cosplay', cateId: 3 },
    ],
  },
  {
    label: '單行本',
    cateId: 6,
    children: [
      { label: '漢化', cateId: 9 },
      { label: '日語', cateId: 13 },
      { label: 'English', cateId: 17 },
    ],
  },
  {
    label: '雜誌&短篇',
    cateId: 7,
    children: [
      { label: '漢化', cateId: 10 },
      { label: '日語', cateId: 14 },
      { label: 'English', cateId: 18 },
    ],
  },
  {
    label: '韓漫',
    cateId: 19,
    children: [
      { label: '漢化', cateId: 20 },
      { label: '其他', cateId: 21 },
    ],
  },
  {
    label: '排行',
    browse: 'ranking',
    children: listRankingScopes().map((scope) => ({
      label: scope.label,
      rankingCateId: scope.cateId ?? null,
    })),
  },
]
