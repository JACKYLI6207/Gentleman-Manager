import { computed, nextTick, ref, watch, type Ref } from 'vue'
import type { ComicInSearch } from '../bindings.ts'
import {
  COVER_LOAD_BATCH,
  comicCardLayout,
  gridColsClass,
  gridColsNumber,
  isGridSearchLayout,
  layoutOptionLabel,
  loadSavedPageSize,
  loadSavedSearchLayout,
  savePageSize,
  saveSearchLayout,
  type SearchResultLayout,
} from '../comicBrowseLayout.ts'
import { sortSearchComics, SEARCH_SORT_OPTIONS, type SearchSortOrder } from '../utils.ts'

export function useLocalComicBrowseList(comicsSource: Ref<ComicInSearch[]>) {
  const viewPage = ref(1)
  const pageSize = ref(loadSavedPageSize())
  const sortOrder = ref<SearchSortOrder>('createDateDesc')
  const searchResultLayout = ref<SearchResultLayout>(loadSavedSearchLayout())
  const sortedComics = ref<ComicInSearch[]>([])
  const visibleComics = ref<ComicInSearch[]>([])
  const comicListScrollArea = ref<HTMLElement>()
  const coverLoadLimit = ref(COVER_LOAD_BATCH)

  const sortButtonLabel = computed(
    () => SEARCH_SORT_OPTIONS.find((o) => o.key === sortOrder.value)?.label ?? '排列方式',
  )

  const pageSizeButtonLabel = computed(() => `每頁 ${pageSize.value}`)

  const displayPageCount = computed(() => {
    const total = sortedComics.value.length
    if (total <= 0) {
      return 1
    }
    return Math.max(1, Math.ceil(total / pageSize.value))
  })

  function applySortAndVisiblePage() {
    const source = comicsSource.value
    sortedComics.value = sortSearchComics([...source], sortOrder.value)
    const total = sortedComics.value.length
    const pageCount = total <= 0 ? 1 : Math.max(1, Math.ceil(total / pageSize.value))
    const page = Math.min(Math.max(1, viewPage.value), pageCount)
    viewPage.value = page
    const start = (page - 1) * pageSize.value
    visibleComics.value = sortedComics.value.slice(start, start + pageSize.value)
    resetCoverLoadWindow()
  }

  function resetCoverLoadWindow() {
    coverLoadLimit.value = COVER_LOAD_BATCH
    void nextTick(() => {
      const el = comicListScrollArea.value
      if (el !== undefined) {
        el.scrollTop = 0
      }
      onComicListScroll()
    })
  }

  function setSearchResultLayout(layout: SearchResultLayout) {
    if (searchResultLayout.value === layout) {
      return
    }
    searchResultLayout.value = layout
    saveSearchLayout(layout)
    resetCoverLoadWindow()
  }

  function onComicListScroll() {
    const container = comicListScrollArea.value
    if (container === undefined || visibleComics.value.length === 0) {
      return
    }

    const listRoot = container.querySelector<HTMLElement>('[data-comic-list]')
    if (listRoot === null) {
      return
    }

    const children = listRoot.children
    let lastVisibleIndex = 0
    const containerBottom = container.getBoundingClientRect().bottom

    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      if (child === undefined) {
        continue
      }
      if (child.getBoundingClientRect().top < containerBottom) {
        lastVisibleIndex = i
      }
    }

    const needCount = Math.min(
      visibleComics.value.length,
      Math.max(COVER_LOAD_BATCH, Math.ceil((lastVisibleIndex + 1) / COVER_LOAD_BATCH) * COVER_LOAD_BATCH),
    )

    if (needCount > coverLoadLimit.value) {
      coverLoadLimit.value = needCount
    }
  }

  function goToViewPage(page: number) {
    const pageCount = displayPageCount.value
    if (page < 1 || page > pageCount) {
      return
    }
    viewPage.value = page
    applySortAndVisiblePage()
  }

  function onSortChange(key: SearchSortOrder) {
    sortOrder.value = key
    applySortAndVisiblePage()
  }

  function onPageSizeChange(size: number) {
    pageSize.value = size
    savePageSize(size)
    viewPage.value = 1
    applySortAndVisiblePage()
  }

  watch(
    comicsSource,
    () => {
      applySortAndVisiblePage()
    },
    { deep: true, immediate: true },
  )

  return {
    viewPage,
    pageSize,
    sortOrder,
    searchResultLayout,
    visibleComics,
    comicListScrollArea,
    coverLoadLimit,
    sortButtonLabel,
    pageSizeButtonLabel,
    displayPageCount,
    setSearchResultLayout,
    onComicListScroll,
    goToViewPage,
    onSortChange,
    onPageSizeChange,
    comicCardLayout,
    gridColsClass,
    gridColsNumber,
    isGridSearchLayout,
    layoutOptionLabel,
  }
}
