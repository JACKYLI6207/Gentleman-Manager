import * as OpenCC from 'opencc-js'

const cnToTw = OpenCC.Converter({ from: 'cn', to: 'tw' }) as (text: string) => string

/** 將簡體或混用中文統一為繁體中文（臺灣）。已是繁體時通常維持不變。 */
export function toTraditionalChinese(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '') {
    return trimmed
  }
  return cnToTw(trimmed)
}
