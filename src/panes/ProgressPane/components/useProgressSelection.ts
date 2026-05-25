import { computed, ref, watch, type ComputedRef } from 'vue'

export function useProgressSelection(listIds: ComputedRef<number[]>) {
  const checkedIds = ref<Set<number>>(new Set())

  const allChecked = computed(
    () => listIds.value.length > 0 && listIds.value.every((id) => checkedIds.value.has(id)),
  )

  watch(listIds, (ids) => {
    const idSet = new Set(ids)
    checkedIds.value = new Set([...checkedIds.value].filter((id) => idSet.has(id)))
  })

  function setSelectAll(checked: boolean) {
    if (checked) {
      checkedIds.value = new Set(listIds.value)
    } else {
      checkedIds.value.clear()
    }
  }

  function setItemChecked(comicId: number, checked: boolean) {
    const next = new Set(checkedIds.value)
    if (checked) {
      next.add(comicId)
    } else {
      next.delete(comicId)
    }
    checkedIds.value = next
  }

  function selectOnly(comicId: number) {
    checkedIds.value = new Set([comicId])
  }

  return { checkedIds, allChecked, setSelectAll, setItemChecked, selectOnly }
}
