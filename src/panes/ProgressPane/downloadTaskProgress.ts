import type { DownloadTaskEvent, DownloadTaskState } from '../../bindings.ts'
import type { ProgressData } from '../../types.ts'
import { commands } from '../../bindings.ts'

export type DownloadFormatMode = 'JpegZipPack' | 'Server2Zip'

export function formatDownloadBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${bytes} B`
}

export function buildProgressData(
  downloadTaskEvent: DownloadTaskEvent,
  options: { downloadFormat: DownloadFormatMode; downloadRetryCount: number },
): ProgressData {
  const {
    state,
    downloadedImgCount,
    totalImgCount,
    downloadPath,
    downloadedBytes,
    totalBytes,
  } = downloadTaskEvent

  let percentage = NaN
  if (totalBytes > 0) {
    percentage = (downloadedBytes / totalBytes) * 100
  } else if (totalImgCount > 0) {
    percentage = (downloadedImgCount / totalImgCount) * 100
  }

  const isServer2 = options.downloadFormat === 'Server2Zip'
  const isJpegPack = options.downloadFormat === 'JpegZipPack'

  let indicator = ''
  if (state === 'Pending') {
    indicator = `排隊中`
  } else if (state === 'Downloading') {
    if (isServer2) {
      indicator = downloadPath !== undefined ? `下載中 (Server 2)` : `獲取 zip 資訊…`
    } else if (isJpegPack) {
      indicator =
        totalImgCount > 0 && downloadedImgCount >= totalImgCount
          ? `打包 ZIP…`
          : `下載圖片 (JPEG)…`
    } else {
      indicator = `下載中`
    }
  } else if (state === 'Paused') {
    indicator = isServer2 ? `已暫停 (Server 2)` : isJpegPack ? `已暫停 (JPEG→ZIP)` : `已暫停`
  } else if (state === 'Cancelled') {
    indicator = `已取消`
  } else if (state === 'Completed') {
    indicator = isServer2 ? `下載完成 (Server 2)` : isJpegPack ? `下載完成 (JPEG→ZIP)` : `下載完成`
  } else if (state === 'Failed') {
    const maxAttempts = options.downloadRetryCount + 1
    indicator = isServer2
      ? `下載失敗 (已嘗試 ${maxAttempts} 次)`
      : isJpegPack
        ? `下載/打包失敗 (已嘗試 ${maxAttempts} 次)`
        : `下載失敗 (已嘗試 ${maxAttempts} 次)`
  }
  if (totalBytes > 0) {
    indicator += ` ${formatDownloadBytes(downloadedBytes)}/${formatDownloadBytes(totalBytes)}`
  } else if (totalImgCount !== 0) {
    indicator += ` ${downloadedImgCount}/${totalImgCount}`
  } else if (isServer2 && downloadedBytes > 0) {
    indicator += ` ${formatDownloadBytes(downloadedBytes)}`
  }

  return { ...downloadTaskEvent, percentage, indicator }
}

export function applyCompletedSideEffects(
  state: DownloadTaskState,
  comicId: number,
  store: {
    getShelfResult?: { comics: { id: number; isDownloaded?: boolean }[] }
    searchResult?: { comics: { id: number; isDownloaded?: boolean }[] }
  },
) {
  if (state !== 'Completed') {
    return
  }
  if (store.getShelfResult !== undefined) {
    const completedResult = store.getShelfResult.comics.find((comic) => comic.id === comicId)
    if (completedResult !== undefined) {
      completedResult.isDownloaded = true
    }
  }
  if (store.searchResult !== undefined) {
    const completedResult = store.searchResult.comics.find((comic) => comic.id === comicId)
    if (completedResult !== undefined) {
      completedResult.isDownloaded = true
    }
  }
}

function normalizeDownloadFormat(raw: string | undefined): DownloadFormatMode {
  if (raw === 'JpegZipPack' || raw === 'Jpeg' || raw === 'Png' || raw === 'Webp' || raw === 'Original') {
    return 'JpegZipPack'
  }
  return 'Server2Zip'
}

export function progressOptionsFromConfig(config: {
  downloadFormat?: string
  downloadRetryCount?: number
} | undefined) {
  return {
    downloadFormat: normalizeDownloadFormat(config?.downloadFormat),
    downloadRetryCount: config?.downloadRetryCount ?? 1,
  }
}

export async function hydratePersistedDownloadTasks(
  store: {
    config?: { downloadFormat?: string; downloadRetryCount?: number }
    setProgress: (comicId: number, data: ProgressData) => void
    getShelfResult?: { comics: { id: number; isDownloaded?: boolean }[] }
    searchResult?: { comics: { id: number; isDownloaded?: boolean }[] }
  },
) {
  const result = await commands.getDownloadTaskSnapshots()
  if (result.status === 'error') {
    console.error(result.error)
    return
  }
  const options = progressOptionsFromConfig(store.config)
  for (const snapshot of result.data) {
    const event: DownloadTaskEvent = {
      state: snapshot.state,
      comic: snapshot.comic,
      downloadedImgCount: snapshot.downloadedImgCount,
      totalImgCount: snapshot.totalImgCount,
      downloadPath: snapshot.downloadPath,
      zipServer: snapshot.zipServer,
      downloadedBytes: snapshot.downloadedBytes,
      totalBytes: snapshot.totalBytes,
      seriesParentDir: snapshot.seriesParentDir,
    }
    if (snapshot.state === 'Completed') {
      snapshot.comic.isDownloaded = true
    }
    applyCompletedSideEffects(snapshot.state, snapshot.comic.id, store)
    store.setProgress(snapshot.comic.id, buildProgressData(event, options))
  }
}
