import type { DownloadTaskState } from '../../bindings.ts'
import type { ProgressData } from '../../types.ts'

export type SeriesGroup = {
  seriesParentDir: string
  children: [number, ProgressData][]
}

export type GroupedProgressList = {
  standalone: [number, ProgressData][]
  seriesGroups: SeriesGroup[]
}

const STATE_PRIORITY: Record<DownloadTaskState, number> = {
  Downloading: 6,
  Pending: 5,
  Paused: 4,
  Failed: 3,
  Completed: 2,
  Cancelled: 1,
}

export function groupProgressEntries(entries: [number, ProgressData][]): GroupedProgressList {
  const standalone: [number, ProgressData][] = []
  const bySeries = new Map<string, [number, ProgressData][]>()

  for (const entry of entries) {
    const dir = entry[1].seriesParentDir?.trim()
    if (dir) {
      const list = bySeries.get(dir) ?? []
      list.push(entry)
      bySeries.set(dir, list)
    } else {
      standalone.push(entry)
    }
  }

  const seriesGroups: SeriesGroup[] = [...bySeries.entries()]
    .map(([seriesParentDir, children]) => ({
      seriesParentDir,
      children: children.sort((a, b) => b[1].totalImgCount - a[1].totalImgCount),
    }))
    .sort((a, b) => a.seriesParentDir.localeCompare(b.seriesParentDir, 'zh-Hant'))

  return { standalone, seriesGroups }
}

export function dominantGroupState(children: ProgressData[]): DownloadTaskState {
  return children.reduce((best, child) =>
    STATE_PRIORITY[child.state] > STATE_PRIORITY[best.state] ? child : best,
  ).state
}

export type AggregatedGroupProgress = {
  state: DownloadTaskState
  percentage: number
  indicator: string
  hasProgress: boolean
  downloadedBytes: number
  totalBytes: number
  downloadedImgCount: number
  totalImgCount: number
}

export function aggregateGroupProgress(children: ProgressData[]): AggregatedGroupProgress {
  let downloadedBytes = 0
  let totalBytes = 0
  let downloadedImgCount = 0
  let totalImgCount = 0

  for (const child of children) {
    downloadedBytes += child.downloadedBytes
    totalBytes += child.totalBytes
    downloadedImgCount += child.downloadedImgCount
    totalImgCount += child.totalImgCount
  }

  let percentage = NaN
  if (totalBytes > 0) {
    percentage = (downloadedBytes / totalBytes) * 100
  } else if (totalImgCount > 0) {
    percentage = (downloadedImgCount / totalImgCount) * 100
  }

  const state = dominantGroupState(children)
  const total = children.length
  const parts: string[] = [`共 ${total} 本`]

  const countByState = (s: DownloadTaskState) => children.filter((c) => c.state === s).length
  const downloading = countByState('Downloading')
  const pending = countByState('Pending')
  const paused = countByState('Paused')
  const failed = countByState('Failed')
  const completed = countByState('Completed')

  if (downloading > 0) {
    parts.push(`${downloading} 本下載中`)
  }
  if (pending > 0) {
    parts.push(`${pending} 本排隊`)
  }
  if (paused > 0) {
    parts.push(`${paused} 本已暫停`)
  }
  if (failed > 0) {
    parts.push(`${failed} 本失敗`)
  }
  if (completed > 0 && completed < total) {
    parts.push(`${completed} 本已完成`)
  }

  let indicator = parts.join(' · ')
  if (totalBytes > 0) {
    indicator += ` ${formatBytes(downloadedBytes)}/${formatBytes(totalBytes)}`
  } else if (totalImgCount > 0) {
    indicator += ` ${downloadedImgCount}/${totalImgCount} 張`
  }

  const hasProgress = totalBytes > 0 || totalImgCount > 0 || downloadedBytes > 0

  return {
    state,
    percentage,
    indicator,
    hasProgress,
    downloadedBytes,
    totalBytes,
    downloadedImgCount,
    totalImgCount,
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${bytes} B`
}

export function groupChildIds(group: SeriesGroup): number[] {
  return group.children.map(([id]) => id)
}

export function isGroupFullyChecked(childIds: number[], checkedIds: Set<number>): boolean {
  return childIds.length > 0 && childIds.every((id) => checkedIds.has(id))
}

export function isGroupPartiallyChecked(childIds: number[], checkedIds: Set<number>): boolean {
  const checkedCount = childIds.filter((id) => checkedIds.has(id)).length
  return checkedCount > 0 && checkedCount < childIds.length
}
