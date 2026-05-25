import { commands } from '../bindings.ts'
import { comicQueueStub } from './comicQueueStub.ts'
import { isDownloadBatchEnqueueCancelled } from './downloadBatchEnqueue.ts'

export type BatchEnqueueOptions = {
  seriesFolder: string | null
  titleById: Map<number, string>
  /** 搜尋結果中的預估圖片數（可選，僅顯示用） */
  imageCountById?: Map<number, number>
  /** 官網標記已下載則不加入（僅「全部下載本頁」使用） */
  skipDownloaded?: boolean
  isDownloadedById?: Map<number, boolean>
  /** 已在佇列中則不重新加入（僅「全部下載本頁」使用） */
  skipInQueue?: boolean
  isInQueue?: (comicId: number) => boolean
}

export type EnqueueFailureItem = {
  comicId: number
  title: string
  errorMessage: string
}

export type EnqueueComicsResult = {
  failures: EnqueueFailureItem[]
  handled: number
  enqueued: number
  cancelled: boolean
}

export async function enqueueComicIds(
  ids: number[],
  options: BatchEnqueueOptions,
  onProgress: (handled: number, enqueued: number) => void,
  initialHandled = 0,
  initialEnqueued = 0,
): Promise<EnqueueComicsResult> {
  let handled = initialHandled
  let enqueued = initialEnqueued
  const failures: EnqueueFailureItem[] = []

  const titleOf = (comicId: number) => options.titleById.get(comicId) ?? `漫畫 #${comicId}`

  for (const comicId of ids) {
    if (isDownloadBatchEnqueueCancelled()) {
      return { failures, handled, enqueued, cancelled: true }
    }

    if (options.skipInQueue && options.isInQueue?.(comicId)) {
      handled++
      enqueued++
      onProgress(handled, enqueued)
      continue
    }

    if (options.skipDownloaded && options.isDownloadedById?.get(comicId) === true) {
      handled++
      enqueued++
      onProgress(handled, enqueued)
      continue
    }

    const imageCount = options.imageCountById?.get(comicId) ?? 0
    const stub = comicQueueStub(comicId, titleOf(comicId), imageCount)

    try {
      await commands.createDownloadTask(stub, options.seriesFolder)
      enqueued++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      failures.push({
        comicId,
        title: titleOf(comicId),
        errorMessage: message || '加入下載佇列失敗',
      })
    }

    handled++
    onProgress(handled, enqueued)
  }

  return { failures, handled, enqueued, cancelled: false }
}
