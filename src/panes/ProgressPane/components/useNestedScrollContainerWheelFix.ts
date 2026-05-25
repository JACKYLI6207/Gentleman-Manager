import { ref, watchEffect, type Ref } from 'vue'
import { attachNestedScrollContainerWheelFix } from '../scrollWheel.ts'

/** 韓漫批次展開子列表的滾輪修正。 */
export function useNestedScrollContainerWheelFix(): {
  scrollEl: Ref<HTMLElement | undefined>
} {
  const scrollEl = ref<HTMLElement>()

  watchEffect((onCleanup) => {
    const el = scrollEl.value
    if (el === undefined) {
      return
    }
    const detach = attachNestedScrollContainerWheelFix(el)
    onCleanup(detach)
  })

  return { scrollEl }
}
