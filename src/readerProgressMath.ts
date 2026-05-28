/** 以「第幾頁 + 頁內捲動」計算 0–1 進度，避免 scrollHeight 未載完時比例失真 */

export function getPageElement(root: HTMLElement, pageIndex: number): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-index="${pageIndex}"]`)
}

export function getPageTopInScroller(root: HTMLElement, pageIndex: number): number {
  const el = getPageElement(root, pageIndex)
  if (!el) return 0
  const rootRect = root.getBoundingClientRect()
  const elRect = el.getBoundingClientRect()
  return root.scrollTop + (elRect.top - rootRect.top)
}

export function getPageHeight(root: HTMLElement, pageIndex: number): number {
  const el = getPageElement(root, pageIndex)
  if (!el) return 1
  const h = el.offsetHeight || el.getBoundingClientRect().height
  return h > 0 ? h : 1
}

/** 頁面底緣在捲動容器中的 scrollTop 座標 */
export function getPageBottomInScroller(root: HTMLElement, pageIndex: number): number {
  return getPageTopInScroller(root, pageIndex) + getPageHeight(root, pageIndex)
}

export function computeVisiblePageIndex(root: HTMLElement): number {
  const rootRect = root.getBoundingClientRect()
  const anchorY = rootRect.top + 48
  let best = 0
  let bestScore = -Infinity
  const nodes = root.querySelectorAll<HTMLElement>('[data-index]')
  for (const node of nodes) {
    const idx = Number(node.dataset.index)
    if (Number.isNaN(idx)) continue
    const rect = node.getBoundingClientRect()
    if (rect.bottom <= anchorY || rect.top > rootRect.bottom) continue
    const visibleTop = Math.max(rect.top, anchorY)
    const visibleBottom = Math.min(rect.bottom, rootRect.bottom)
    const visible = Math.max(0, visibleBottom - visibleTop)
    const containsAnchor = rect.top <= anchorY && rect.bottom > anchorY
    const score = (containsAnchor ? 1_000_000 : 0) + visible
    if (score > bestScore) {
      bestScore = score
      best = idx
    }
  }
  return best
}

/** 0–1：在 totalPages 個篇章中的閱讀位置（含長圖頁內偏移） */
export function computeContentRatio(
  root: HTMLElement,
  totalPages: number,
  pageIndex = computeVisiblePageIndex(root),
): number {
  if (totalPages <= 0) return 0
  if (totalPages === 1) {
    const h = getPageHeight(root, 0)
    return h > 0 ? Math.min(1, Math.max(0, root.scrollTop / h)) : 0
  }
  const pageTop = getPageTopInScroller(root, pageIndex)
  const offsetInPage = Math.max(0, root.scrollTop - pageTop)
  const pageH = getPageHeight(root, pageIndex)
  const withinPage = Math.min(1, offsetInPage / pageH)
  return Math.min(1, Math.max(0, (pageIndex + withinPage) / (totalPages - 1)))
}

export function contentRatioToPageLabel(ratio: number, totalPages: number): {
  pageIndex: number
  currentPage: number
  pageLabel: string
} {
  if (totalPages <= 0) {
    return { pageIndex: 0, currentPage: 0, pageLabel: '' }
  }
  if (totalPages === 1) {
    return { pageIndex: 0, currentPage: 1, pageLabel: '1/1頁' }
  }
  const clamped = Math.min(1, Math.max(0, ratio))
  const floatIdx = clamped * (totalPages - 1)
  const pageIndex = Math.min(totalPages - 1, Math.floor(floatIdx))
  const currentPage = pageIndex + 1
  return { pageIndex, currentPage, pageLabel: `${currentPage}/${totalPages}頁` }
}

/** 依內容比例捲動；回傳目標 pageIndex 供預載 */
export function seekToContentRatio(
  root: HTMLElement,
  totalPages: number,
  ratio: number,
): number {
  if (totalPages <= 0) return 0
  const clamped = Math.min(1, Math.max(0, ratio))

  if (totalPages === 1) {
    const h = getPageHeight(root, 0)
    root.scrollTop = clamped * h
    return 0
  }

  const floatIdx = clamped * (totalPages - 1)
  const pageIndex = Math.min(totalPages - 1, Math.floor(floatIdx))
  const withinPage = floatIdx - pageIndex
  const pageTop = getPageTopInScroller(root, pageIndex)
  const pageH = getPageHeight(root, pageIndex)
  root.scrollTop = pageTop + withinPage * pageH
  return pageIndex
}
