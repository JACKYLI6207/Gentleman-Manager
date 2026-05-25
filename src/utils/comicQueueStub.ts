import type { Comic } from '../bindings.ts'

/** 僅用於加入下載佇列的佔位資料；完整漫畫資訊於輪到下載時再由後端取得 */
export function comicQueueStub(id: number, title: string, imageCount = 0): Comic {
  return {
    id,
    title,
    cover: '',
    category: '',
    imageCount,
    tags: [],
    intro: '',
    isDownloaded: undefined,
    imgList: [],
  }
}
