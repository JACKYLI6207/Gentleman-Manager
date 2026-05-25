/** 將冗長 API / HTML 錯誤壓成可讀的一行摘要 */
export function summarizeEnqueueError(raw: string): string {
  const text = raw.trim()
  if (text.length === 0) {
    return '未知錯誤'
  }

  if (
    text.includes('403 Forbidden') ||
    text.includes('Just a moment') ||
    text.includes('challenges.cloudflare.com')
  ) {
    return '網站拒絕連線（403 / Cloudflare 驗證頁）'
  }

  if (text.includes('429') || text.toLowerCase().includes('too many requests')) {
    return '請求過於頻繁（429）'
  }

  if (text.includes('503') || text.toLowerCase().includes('service unavailable')) {
    return '伺服器暫時不可用（503）'
  }

  if (text.includes('timeout') || text.includes('逾時')) {
    return '連線逾時'
  }

  const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? text
  if (firstLine.length <= 120) {
    return firstLine
  }

  return `${firstLine.slice(0, 120)}…`
}
