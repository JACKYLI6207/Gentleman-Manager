function findScrollableAncestor(from: HTMLElement | null, stopBefore?: HTMLElement): HTMLElement | null {
  let node = from
  while (node !== null && node !== stopBefore) {
    const { overflowY } = getComputedStyle(node)
    if (
      (overflowY === 'auto' || overflowY === 'scroll') &&
      node.scrollHeight > node.clientHeight
    ) {
      return node
    }
    node = node.parentElement
  }
  return null
}

function canScrollInDirection(el: HTMLElement, deltaY: number): boolean {
  if (el.scrollHeight <= el.clientHeight) {
    return false
  }
  if (deltaY > 0) {
    return el.scrollTop + el.clientHeight < el.scrollHeight - 1
  }
  return el.scrollTop > 0
}

function applyScroll(el: HTMLElement, deltaY: number): boolean {
  const maxScroll = el.scrollHeight - el.clientHeight
  const nextScroll = Math.max(0, Math.min(maxScroll, el.scrollTop + deltaY))
  if (nextScroll === el.scrollTop) {
    return false
  }
  el.scrollTop = nextScroll
  return true
}

/** WebView2 下子元素（如 NCard）常無法觸發 overflow 捲動，改由容器統一處理滾輪。 */
export function attachScrollContainerWheelFix(container: HTMLElement): () => void {
  const onWheel = (e: WheelEvent) => {
    const target = e.target instanceof HTMLElement ? e.target : null
    if (target !== null && target !== container && container.contains(target)) {
      const nested = findScrollableAncestor(target, container)
      if (nested !== null && canScrollInDirection(nested, e.deltaY)) {
        return
      }
    }

    if (container.scrollHeight <= container.clientHeight) {
      return
    }

    if (applyScroll(container, e.deltaY)) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  container.addEventListener('wheel', onWheel, { passive: false, capture: true })
  return () => container.removeEventListener('wheel', onWheel, { capture: true })
}

/** 韓漫批次展開區：子項目區域獨立捲動；到頂/底時把剩餘滾動交給外層列表。 */
export function attachNestedScrollContainerWheelFix(container: HTMLElement): () => void {
  const onWheel = (e: WheelEvent) => {
    if (container.scrollHeight <= container.clientHeight) {
      return
    }

    if (canScrollInDirection(container, e.deltaY)) {
      if (applyScroll(container, e.deltaY)) {
        e.preventDefault()
        e.stopPropagation()
      }
      return
    }

    const outer = findScrollableAncestor(container.parentElement, container)
    if (outer !== null && applyScroll(outer, e.deltaY)) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  container.addEventListener('wheel', onWheel, { passive: false, capture: true })
  return () => container.removeEventListener('wheel', onWheel, { capture: true })
}
