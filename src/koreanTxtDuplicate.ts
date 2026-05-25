import * as OpenCC from 'opencc-js'
import type { ComicInSearch } from './bindings.ts'
import { prefixBeforeRange } from './koreanWebtoon.ts'
import { toTraditionalChinese } from './chineseText.ts'

const toSimplified = OpenCC.Converter({ from: 'tw', to: 'cn' }) as (text: string) => string

/** 比對時剔除的完結相關詞（先長後短） */
const COMPLETION_PHRASES = [
  '未完結',
  '已完結',
  '連載中',
  '完結',
  '完结',
  '完',
] as const

export const CATALOG_NO_DUPLICATE_MESSAGE = '未在目錄中發現重複'

const MIN_COMPARABLE_LEN = 2

export type KoreanTxtDuplicateAnalysis = {
  catalogLineCount: number
  /** 系列層級匹配（通常為標籤名） */
  seriesMatches: string[]
  /** 漫畫 id → 重複說明 */
  itemMessages: Map<number, string>
}

/** 只保留中文與英文字母，並剔除完結類詞彙 */
export function extractComparableText(text: string): string {
  let buf = ''
  for (const ch of text.normalize('NFKC')) {
    if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(ch) || /[a-zA-Z]/.test(ch)) {
      buf += ch
    }
  }
  let result = buf.toLowerCase()
  for (const phrase of COMPLETION_PHRASES) {
    result = result.replaceAll(phrase, '')
  }
  return result
}

export function isIgnorableCatalogLine(line: string): boolean {
  return extractComparableText(line).length < MIN_COMPARABLE_LEN
}

function comparableForms(text: string): string[] {
  const base = extractComparableText(text)
  if (base.length < MIN_COMPARABLE_LEN) {
    return []
  }
  const simplified = extractComparableText(toSimplified(text))
  const traditional = extractComparableText(toTraditionalChinese(text))
  return [...new Set([base, simplified, traditional].filter((s) => s.length >= MIN_COMPARABLE_LEN))]
}

/** 剥除開頭 [韓漫][作者 & 作者] 等中括號元資料 */
function stripLeadingBracketGroups(text: string): string {
  let rest = text.trim()
  while (/^\[[^\]]*\]/.test(rest)) {
    rest = rest.replace(/^\[[^\]]*\]\s*/, '')
  }
  return rest.trim()
}

/** 去掉 TXT 條目前綴（未分類916. 等） */
function stripCatalogLinePrefix(line: string): string {
  return line
    .trim()
    .replace(/^(?:未)?分類\s*\d+\s*[.．、:：\-]\s*/iu, '')
    .replace(/^\d+\s*[.．、:：\-]\s*/, '')
    .trim()
}

/** 去掉 (無碼版)、(有碼版) 等版本標記 */
function stripEditionMarkers(text: string): string {
  return text
    .replace(/[(（\[]\s*无?(?:碼|码)版\s*[)）\]]/giu, '')
    .replace(/[(（\[]\s*完整版\s*[)）\]]/giu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 去掉話數／範圍／完結尾綴，保留系列名本體 */
function stripEpisodeSuffix(text: string): string {
  let rest = text.trim()
  rest = rest.replace(
    /[-–—~～_－]\s*\d[\d\s~～\-–—]*(?:[话話章回集])?(?:\s*[-_－—]\s*(?:完|完结|end))?\s*(?:\[[^\]]*\])?\s*$/iu,
    '',
  )
  rest = rest.replace(/\s+\d+\s*[-~～]\s*\d+\s*[话話].*$/iu, '')
  rest = rest.replace(/\s+\d+\s*[话話].*$/iu, '')
  rest = rest.replace(/[-_－—]\s*(?:完|完结|end)\s*$/iu, '')
  return rest.trim()
}

function trimNameEdges(text: string): string {
  return text.trim().replace(/^[「『【（(\s]+|[」』】）)\s]+$/g, '')
}

/** 去掉「第二季」「第一二季」等季別標記，保留系列核心名 */
function stripSeasonMarkers(text: string): string {
  return text
    .replace(/[(（\[]\s*第(?:[一二三四五六七八九十百千万\d]+)+季\s*[)）\]]/gu, '')
    .replace(/第(?:[一二三四五六七八九十百千万\d]+)+季/gu, '')
    .replace(/\b[Ss]eason\s*\d+\b/gu, '')
    .replace(/\b[Ss]\d+\b/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function coreNameForms(text: string): string[] {
  const stripped = stripSeasonMarkers(trimNameEdges(text))
  if (stripped === '') {
    return []
  }
  return comparableForms(stripped)
}

function pushUniqueName(raw: string, seen: Set<string>, out: string[]) {
  const trimmed = trimNameEdges(raw)
  const key = extractComparableText(trimmed)
  if (key.length < MIN_COMPARABLE_LEN || seen.has(key)) {
    return
  }
  seen.add(key)
  out.push(trimmed)

  const seasonStripped = stripSeasonMarkers(trimmed)
  if (seasonStripped !== trimmed) {
    const coreKey = extractComparableText(seasonStripped)
    if (coreKey.length >= MIN_COMPARABLE_LEN && !seen.has(coreKey)) {
      seen.add(coreKey)
      out.push(seasonStripped)
    }
  }
}

/** 將「A / B / C」拆成多譯名 */
export function splitSeriesNameAliases(text: string): string[] {
  const trimmed = text.trim()
  if (trimmed === '') {
    return []
  }
  const segments = trimmed
    .split(/[/／|｜]+/)
    .map((s) => trimNameEdges(s))
    .filter((s) => extractComparableText(s).length >= MIN_COMPARABLE_LEN)
  return segments.length > 0 ? segments : [trimNameEdges(trimmed)]
}

/**
 * 從標題或任意文字提取系列名候選（話數前、去中括號元資料、多譯名）。
 */
export function extractSeriesNameCandidates(source: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const beforeRange = prefixBeforeRange(source).trim()

  function absorb(text: string) {
    const chunks = [
      text,
      stripLeadingBracketGroups(text),
      stripEditionMarkers(text),
      stripEditionMarkers(stripLeadingBracketGroups(text)),
      stripEpisodeSuffix(text),
      stripEpisodeSuffix(stripLeadingBracketGroups(text)),
      stripEpisodeSuffix(stripEditionMarkers(text)),
    ]
    for (const chunk of chunks) {
      for (const alias of splitSeriesNameAliases(chunk)) {
        pushUniqueName(alias, seen, out)
        pushUniqueName(stripLeadingBracketGroups(alias), seen, out)
        pushUniqueName(stripEditionMarkers(alias), seen, out)
        pushUniqueName(stripEpisodeSuffix(alias), seen, out)
      }
    }
  }

  absorb(beforeRange)
  return out
}

/** 從 TXT 目錄列提取系列名候選 */
export function extractCatalogLineNameCandidates(line: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const stripped = stripCatalogLinePrefix(line)

  function absorb(text: string) {
    const chunks = [
      text,
      stripLeadingBracketGroups(text),
      stripEpisodeSuffix(text),
      stripEpisodeSuffix(stripLeadingBracketGroups(text)),
    ]
    for (const chunk of chunks) {
      for (const alias of splitSeriesNameAliases(chunk)) {
        pushUniqueName(alias, seen, out)
        pushUniqueName(stripEpisodeSuffix(alias), seen, out)
      }
    }
  }

  absorb(stripped)
  absorb(line.trim())
  return out
}

/** 系列名與目錄列是否匹配：兩側提取候選名，任一精確相等或目錄名包含系列名 */
function seriesNameMatchesCatalogLine(seriesName: string, line: string): boolean {
  const nameForms = comparableForms(seriesName)
  if (nameForms.length === 0) {
    return false
  }

  const lineNames = extractCatalogLineNameCandidates(line)
  if (lineNames.length === 0) {
    return false
  }

  for (const lineName of lineNames) {
    const lineForms = comparableForms(lineName)
    const lineCoreForms = coreNameForms(lineName)
    const nameCoreForms = coreNameForms(seriesName)

    for (const nf of nameForms) {
      for (const lf of lineForms) {
        if (nf === lf) {
          return true
        }
        if (nf.length >= MIN_COMPARABLE_LEN && lf.includes(nf)) {
          return true
        }
        // 標題含 (無碼版) 等尾綴時，目錄系列名可能是較短的子串
        if (lf.length >= 3 && nf.length > lf.length && nf.includes(lf)) {
          return true
        }
      }
    }

    // 季別寫法不同（第二季 vs 第一二季）時，以去掉季別後的核心名比對
    if (
      nameCoreForms.length > 0 &&
      lineCoreForms.some((lc) => nameCoreForms.some((nc) => nc === lc && nc.length >= MIN_COMPARABLE_LEN))
    ) {
      return true
    }
  }
  return false
}

/**
 * TXT 條目是否包含系列名（繁簡轉換後）。
 * 保留舊 API，內部改用雙向候選名比對。
 */
export function tagAppearsInCatalogLine(tagLabel: string, line: string): boolean {
  const candidates = extractSeriesNameCandidates(tagLabel)
  const labels = candidates.length > 0 ? candidates : [tagLabel.trim()]
  return labels.some((name) => seriesNameMatchesCatalogLine(name, line))
}

function findMatchingCatalogLines(candidates: string[], catalogLines: string[]): string[] {
  const matches: string[] = []
  for (const line of catalogLines) {
    if (isIgnorableCatalogLine(line)) {
      continue
    }
    if (candidates.some((name) => seriesNameMatchesCatalogLine(name, line))) {
      matches.push(line)
    }
  }
  return matches
}

function findFirstCatalogMatch(candidates: string[], catalogLines: string[]): string | undefined {
  const ordered = [...candidates].sort(
    (a, b) => extractComparableText(a).length - extractComparableText(b).length,
  )
  for (const line of catalogLines) {
    if (isIgnorableCatalogLine(line)) {
      continue
    }
    if (ordered.some((name) => seriesNameMatchesCatalogLine(name, line))) {
      return line
    }
  }
  return undefined
}

export function formatDuplicateMessage(catalogLine: string): string {
  return `與列表中「${catalogLine}」重複`
}

/** 去掉「韓漫 · 戀愛實境」這類搜尋範圍前綴，只保留系列名 */
export function normalizePageTagLabel(raw?: string): string | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined
  }
  const trimmed = raw.trim()
  const parts = trimmed
    .split('·')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (parts.length > 1) {
    const last = parts[parts.length - 1]
    if (extractComparableText(last).length >= MIN_COMPARABLE_LEN) {
      return last
    }
  }
  return trimmed
}

/** 從漫畫標題取得目錄比對候選名 */
export function seriesNameCandidatesFromTitle(title: string): string[] {
  return extractSeriesNameCandidates(title)
}

function expandLabelCandidates(...labels: (string | undefined)[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const raw of labels) {
    if (raw === undefined || raw.trim() === '') {
      continue
    }
    const normalized = normalizePageTagLabel(raw) ?? raw.trim()
    for (const name of extractSeriesNameCandidates(normalized)) {
      pushUniqueName(name, seen, unique)
    }
    for (const name of extractSeriesNameCandidates(raw.trim())) {
      pushUniqueName(name, seen, unique)
    }
  }
  return unique
}

/** 目錄比對用的系列名：取標題第一候選 */
export function resolveCatalogLabelForComic(comic: ComicInSearch, pageTagLabel?: string): string {
  const candidates = seriesNameCandidatesFromTitle(comic.title)
  if (candidates.length > 0) {
    return candidates[0]
  }
  const normalized = normalizePageTagLabel(pageTagLabel)
  return normalized ?? prefixBeforeRange(comic.title).trim()
}

export function analyzeKoreanTxtDuplicates(
  tagLabel: string,
  comics: ComicInSearch[],
  catalogLines: string[],
): KoreanTxtDuplicateAnalysis {
  const validLines = catalogLines.filter((line) => !isIgnorableCatalogLine(line))
  const labelCandidates = expandLabelCandidates(tagLabel)
  const itemMessages = new Map<number, string>()

  const primaryLine = findFirstCatalogMatch(labelCandidates, validLines)
  const seriesMatches =
    primaryLine !== undefined ? findMatchingCatalogLines(labelCandidates, validLines) : []

  if (primaryLine !== undefined) {
    const msg = formatDuplicateMessage(primaryLine)
    for (const comic of comics) {
      itemMessages.set(comic.id, msg)
    }
    return {
      catalogLineCount: catalogLines.length,
      seriesMatches: [...new Set(seriesMatches)],
      itemMessages,
    }
  }

  for (const comic of comics) {
    const comicCandidates = expandLabelCandidates(...seriesNameCandidatesFromTitle(comic.title), ...labelCandidates)
    const matchedLine = findFirstCatalogMatch(comicCandidates, validLines)
    if (matchedLine !== undefined) {
      itemMessages.set(comic.id, formatDuplicateMessage(matchedLine))
    }
  }

  return {
    catalogLineCount: catalogLines.length,
    seriesMatches: [],
    itemMessages,
  }
}

/** 搜尋結果本頁：以各漫畫標題候選名比對 TXT 目錄 */
export function analyzePageCatalogDuplicates(
  comics: ComicInSearch[],
  catalogLines: string[],
  options?: { tagLabel?: string },
): Map<number, string> {
  const normalizedPageTag = normalizePageTagLabel(options?.tagLabel)
  const validLines = catalogLines.filter((line) => !isIgnorableCatalogLine(line))
  const results = new Map<number, string>()

  for (const comic of comics) {
    const candidates = expandLabelCandidates(...seriesNameCandidatesFromTitle(comic.title), normalizedPageTag)
    const matchedLine = findFirstCatalogMatch(candidates, validLines)
    results.set(
      comic.id,
      matchedLine !== undefined ? formatDuplicateMessage(matchedLine) : CATALOG_NO_DUPLICATE_MESSAGE,
    )
  }
  return results
}
