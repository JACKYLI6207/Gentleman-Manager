import { listCategorySearchScopes } from './categories.ts'
import { extractSeriesNameCandidates } from './koreanTxtDuplicate.ts'
import { prefixBeforeRange } from './koreanWebtoon.ts'

const CATEGORY_PREFIX_LABELS = [...listCategorySearchScopes().map((option) => option.label)].sort(
  (a, b) => b.length - a.length,
)

const STANDALONE_META_TOKENS = [
  '韓漫',
  '漢化',
  '生肉',
  '日語',
  'English',
  '同人誌',
  '單行本',
  '雜誌&短篇',
  '3D&漫畫',
  'AI圖集',
] as const

function trimNameEdges(text: string): string {
  return text.trim().replace(/^[「『【（(\s]+|[」』】）)\s]+$/g, '')
}

/** 去掉標題開頭的分類／語系標記（如「韓漫 / 漢化 」） */
export function stripLeadingTitleMeta(title: string): string {
  let rest = title.trim()
  let changed = true
  while (changed) {
    changed = false
    for (const label of CATEGORY_PREFIX_LABELS) {
      for (const sep of [' / ', '/', ' ']) {
        const prefix = `${label}${sep}`
        if (rest.startsWith(prefix)) {
          rest = rest.slice(prefix.length).trim()
          changed = true
          break
        }
      }
      if (rest === label) {
        rest = ''
        changed = true
        break
      }
    }
    for (const token of STANDALONE_META_TOKENS) {
      if (rest.startsWith(`${token} `) || rest.startsWith(`${token}/`) || rest.startsWith(`${token}／`)) {
        rest = rest.slice(token.length).replace(/^[\s/／]+/, '').trim()
        changed = true
      }
    }
  }
  return rest
}

function stripTrailingBracketNotes(title: string): string {
  return title.replace(/\s*\[[^\]]*\]\s*$/u, '').trim()
}

function pickBestSearchName(candidates: string[]): string | undefined {
  const meaningful = candidates
    .map((item) => trimNameEdges(item))
    .filter((item) => item.length >= 2)
  if (meaningful.length === 0) {
    return candidates[0]
  }
  return meaningful.sort((a, b) => a.length - b.length)[0]
}

/** 從詳情標題提取純漫畫名（去除話數、完結、分類前綴等）供搜索使用 */
export function extractComicSearchName(title: string): string {
  const raw = title.trim()
  if (raw === '') {
    return ''
  }
  const metaStripped = stripLeadingTitleMeta(raw)
  const candidates = extractSeriesNameCandidates(metaStripped)
  const picked = pickBestSearchName(candidates)
  if (picked !== undefined && picked.trim() !== '') {
    return picked.trim()
  }
  const fallback = stripTrailingBracketNotes(trimNameEdges(prefixBeforeRange(metaStripped)))
  return fallback || metaStripped.trim()
}
