import { ref, watchEffect, type Ref } from 'vue'
import { attachScrollContainerWheelFix } from '../scrollWheel.ts'

/** 綁定可捲動列表的滾輴修正（WebView2 / 展開子項目時必需）。 */
export function useScrollContainerWheelFix(): {
  listEl: Ref<HTMLElement | undefined>
} {
  const listEl = ref<HTMLElement>()

  watchEffect((onCleanup) => {
    const el = listEl.value
    if (el === undefined) {
      return
    }
    const detach = attachScrollContainerWheelFix(el)
    onCleanup(detach)
  })

  return { listEl }
}
