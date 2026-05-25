import { defineStore } from 'pinia'
import { Comic, ComicInSearch, commands, Config, GetShelfResult, SearchResult, Tag, UserProfile } from './bindings.ts'
import { loadFavoriteComics, saveFavoriteComics } from './favoritesStorage.ts'
import { loadFavoriteSearchTabs, saveFavoriteSearchTabs } from './searchTabBookmarksStorage.ts'
import type { SearchTabBookmark } from './panes/searchTabBookmarkTypes.ts'
import { sanitizeTabStateForBookmark } from './panes/searchTabBookmarkTypes.ts'
import type { SearchResultTabState } from './panes/searchResultTabTypes.ts'
import { CurrentTabName, FavoritesSection, ProgressData, ReadSection } from './types.ts'
import { computed, ref } from 'vue'

export const useStore = defineStore('store', () => {
  const config = ref<Config>()
  const userProfile = ref<UserProfile>()
  const pickedComic = ref<Comic>()
  const currentTabName = ref<CurrentTabName>('search')
  const favoritesSection = ref<FavoritesSection>('comics')
  const readSection = ref<ReadSection>('online')
  /** 僅在「漫畫詳情」點擊「閱讀」後為 true，直接點「漫畫閱讀」分頁不會載入 */
  const readingActive = ref(false)
  /** 頂部分類列目前選中的標籤 */
  const activeBrowseLabel = ref('')
  const progresses = ref<Map<number, ProgressData>>(new Map())
  const getShelfResult = ref<GetShelfResult>()
  const searchResult = ref<SearchResult>()
  const covers = ref<Map<number, string>>(new Map())
  const comicTags = ref<Map<number, Tag[]>>(new Map())
  const comicTagsInflight = new Map<number, Promise<void>>()
  const favoriteComics = ref<ComicInSearch[]>(loadFavoriteComics())
  const favoriteSearchTabs = ref<SearchTabBookmark[]>(loadFavoriteSearchTabs())

  const favoriteIdSet = computed(() => new Set(favoriteComics.value.map((c) => c.id)))
  const favoriteSearchTabSourceIdSet = computed(
    () => new Set(favoriteSearchTabs.value.map((b) => b.sourceTabId)),
  )

  function isFavoriteComic(comicId: number) {
    return favoriteIdSet.value.has(comicId)
  }

  function toggleFavoriteComic(comic: ComicInSearch) {
    if (isFavoriteComic(comic.id)) {
      favoriteComics.value = favoriteComics.value.filter((c) => c.id !== comic.id)
    } else {
      favoriteComics.value = [...favoriteComics.value, comic]
    }
    saveFavoriteComics(favoriteComics.value)
  }

  function reloadFavoriteComics() {
    favoriteComics.value = loadFavoriteComics()
  }

  function isFavoriteSearchTab(sourceTabId: string) {
    return favoriteSearchTabSourceIdSet.value.has(sourceTabId)
  }

  function addFavoriteSearchTab(sourceTabId: string, tab: SearchResultTabState) {
    if (isFavoriteSearchTab(sourceTabId)) {
      return
    }
    const bookmark: SearchTabBookmark = {
      id: crypto.randomUUID(),
      sourceTabId,
      savedAt: new Date().toISOString(),
      title: tab.title,
      tabState: sanitizeTabStateForBookmark(tab),
    }
    favoriteSearchTabs.value = [...favoriteSearchTabs.value, bookmark]
    saveFavoriteSearchTabs(favoriteSearchTabs.value)
  }

  function removeFavoriteSearchTab(sourceTabId: string) {
    const next = favoriteSearchTabs.value.filter((b) => b.sourceTabId !== sourceTabId)
    if (next.length === favoriteSearchTabs.value.length) {
      return
    }
    favoriteSearchTabs.value = next
    saveFavoriteSearchTabs(favoriteSearchTabs.value)
  }

  function toggleFavoriteSearchTab(sourceTabId: string, tab: SearchResultTabState) {
    if (isFavoriteSearchTab(sourceTabId)) {
      removeFavoriteSearchTab(sourceTabId)
    } else {
      addFavoriteSearchTab(sourceTabId, tab)
    }
  }

  function removeFavoriteSearchTabById(bookmarkId: string) {
    favoriteSearchTabs.value = favoriteSearchTabs.value.filter((b) => b.id !== bookmarkId)
    saveFavoriteSearchTabs(favoriteSearchTabs.value)
  }

  function reloadFavoriteSearchTabs() {
    favoriteSearchTabs.value = loadFavoriteSearchTabs()
  }

  function openFavorites(section: FavoritesSection) {
    favoritesSection.value = section
    currentTabName.value = 'favorites'
  }

  function openRead(section: ReadSection) {
    readSection.value = section
    currentTabName.value = 'read'
  }

  const MAX_CONCURRENT_TAG_LOADS = 4
  let tagLoadActive = 0
  const tagLoadQueue: Array<() => void> = []

  function acquireTagLoadSlot(): Promise<void> {
    if (tagLoadActive < MAX_CONCURRENT_TAG_LOADS) {
      tagLoadActive++
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      tagLoadQueue.push(() => {
        tagLoadActive++
        resolve()
      })
    })
  }

  function releaseTagLoadSlot() {
    tagLoadActive--
    const next = tagLoadQueue.shift()
    if (next !== undefined) {
      next()
    }
  }

  async function loadComicTags(id: number) {
    if (comicTags.value.has(id)) {
      return
    }
    const inflight = comicTagsInflight.get(id)
    if (inflight !== undefined) {
      await inflight
      return
    }

    const task = (async () => {
      await acquireTagLoadSlot()
      try {
        const result = await commands.getComicTags(id)
        const next = new Map(comicTags.value)
        if (result.status === 'error') {
          console.error(result.error)
          // 失敗時不寫入空陣列，避免翻頁後誤顯示「無標籤」且無法重試
        } else {
          next.set(id, result.data)
          comicTags.value = next
        }
      } catch (error) {
        console.error(error)
        // 失敗時不寫入空陣列，保留 undefined 以便重試
      } finally {
        releaseTagLoadSlot()
        comicTagsInflight.delete(id)
      }
    })()

    comicTagsInflight.set(id, task)
    await task
  }

  async function loadCover(id: number, url: string) {
    const trimmed = url.trim()
    if (trimmed === '' || (!trimmed.startsWith('http://') && !trimmed.startsWith('https://'))) {
      return
    }
    const result = await commands.getCoverData(trimmed)
    if (result.status === 'error') {
      console.error(result.error)
      return
    }
    const coverData: number[] = result.data
    const coverBlob = new Blob([new Uint8Array(coverData)])
    const cover = URL.createObjectURL(coverBlob)
    const prev = covers.value.get(id)
    if (prev !== undefined) {
      URL.revokeObjectURL(prev)
    }
    const next = new Map(covers.value)
    next.set(id, cover)
    covers.value = next
  }

  function clearCoversForComicIds(ids: number[]) {
    if (ids.length === 0) {
      return
    }
    const idSet = new Set(ids)
    const next = new Map(covers.value)
    let changed = false
    for (const id of idSet) {
      const blobUrl = next.get(id)
      if (blobUrl !== undefined) {
        URL.revokeObjectURL(blobUrl)
        next.delete(id)
        changed = true
      }
    }
    if (changed) {
      covers.value = next
    }
  }

  /** 以新 Map 寫入，確保 Pinia / Vue 能偵測 progresses 變更並刷新列表 */
  function setProgress(comicId: number, data: ProgressData) {
    const next = new Map(progresses.value)
    next.set(comicId, data)
    progresses.value = next
  }

  function deleteProgress(comicId: number) {
    if (!progresses.value.has(comicId)) {
      return
    }
    const next = new Map(progresses.value)
    next.delete(comicId)
    progresses.value = next
  }

  function updateProgressIndicator(comicId: number, indicator: string) {
    const existing = progresses.value.get(comicId)
    if (existing === undefined) {
      return
    }
    setProgress(comicId, { ...existing, indicator })
  }

  function startReading() {
    readingActive.value = true
    openRead('online')
  }

  function endReading() {
    readingActive.value = false
  }

  async function prepareAndStartReading(comicId: number) {
    const result = await commands.getComic(comicId)
    if (result.status === 'error') {
      console.error(result.error)
      return
    }
    pickedComic.value = result.data
    const nextTags = new Map(comicTags.value)
    nextTags.set(comicId, result.data.tags)
    comicTags.value = nextTags
    readingActive.value = true
    openRead('online')
  }

  return {
    config,
    userProfile,
    pickedComic,
    currentTabName,
    favoritesSection,
    openFavorites,
    readSection,
    openRead,
    readingActive,
    activeBrowseLabel,
    startReading,
    endReading,
    prepareAndStartReading,
    progresses,
    getShelfResult,
    searchResult,
    covers,
    comicTags,
    loadCover,
    clearCoversForComicIds,
    loadComicTags,
    isFavoriteComic,
    toggleFavoriteComic,
    reloadFavoriteComics,
    favoriteComics,
    favoriteSearchTabs,
    isFavoriteSearchTab,
    toggleFavoriteSearchTab,
    removeFavoriteSearchTabById,
    reloadFavoriteSearchTabs,
    setProgress,
    deleteProgress,
    updateProgressIndicator,
  }
})
