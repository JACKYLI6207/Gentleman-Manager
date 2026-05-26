import * as OpenCC from 'opencc-js'

const cnToTw = OpenCC.Converter({ from: 'cn', to: 'tw' }) as (text: string) => string
const twToCn = OpenCC.Converter({ from: 'tw', to: 'cn' }) as (text: string) => string

/** 將簡體或混用中文統一為繁體中文（臺灣）。已是繁體時通常維持不變。 */
export function toTraditionalChinese(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '') {
    return trimmed
  }
  return cnToTw(trimmed)
}

/** 將繁體或混用中文統一為簡體中文。已是簡體時通常維持不變。 */
export function toSimplifiedChinese(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '') {
    return trimmed
  }
  return twToCn(trimmed)
}

/** 用於搜尋：產生原文、簡體、繁體三種標準化形式，讓簡繁互搜。 */
export function chineseSearchVariants(text: string): string[] {
  const trimmed = text.trim().toLocaleLowerCase()
  if (trimmed === '') {
    return []
  }
  return [...new Set([trimmed, toSimplifiedChinese(trimmed), toTraditionalChinese(trimmed)].filter((item) => item !== ''))]
}
