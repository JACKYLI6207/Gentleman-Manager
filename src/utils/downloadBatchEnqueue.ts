import { ref } from 'vue'
import type { BatchEnqueueOptions, EnqueueFailureItem } from './batchEnqueueRunner.ts'

/** 序列化「加入下載佇列」批次，避免多個韓漫批次並行搶佇列。 */
let enqueueTail: Promise<void> = Promise.resolve()
let enqueueRunning = 0
let cancelRequested = false
let dismissWaiter: (() => void) | null = null

export type BatchEnqueuePhase = 'running' | 'failures' | 'done'

export const batchEnqueueUi = {
  visible: ref(false),
  phase: ref<BatchEnqueuePhase>('running'),
  current: ref(0),
  total: ref(0),
  enqueued: ref(0),
  failures: ref<EnqueueFailureItem[]>([]),
  checkedFailureIds: ref<Set<number>>(new Set()),
  jobOptions: ref<BatchEnqueueOptions | null>(null),
  doneSummary: ref(''),
  retrying: ref(false),
  seriesFolderLabel: ref<string | undefined>(undefined),
  abandonedCount: ref(0),
}

export function isDownloadBatchEnqueueRunning(): boolean {
  return enqueueRunning > 0
}

export function isDownloadBatchEnqueueCancelled(): boolean {
  return cancelRequested
}

export function requestCancelDownloadBatchEnqueue(): void {
  cancelRequested = true
}

export function beginDownloadBatchEnqueueProgress(total: number, seriesFolder?: string): void {
  cancelRequested = false
  batchEnqueueUi.phase.value = 'running'
  batchEnqueueUi.current.value = 0
  batchEnqueueUi.total.value = total
  batchEnqueueUi.enqueued.value = 0
  batchEnqueueUi.failures.value = []
  batchEnqueueUi.checkedFailureIds.value = new Set()
  batchEnqueueUi.jobOptions.value = null
  batchEnqueueUi.doneSummary.value = ''
  batchEnqueueUi.retrying.value = false
  batchEnqueueUi.abandonedCount.value = 0
  batchEnqueueUi.seriesFolderLabel.value = seriesFolder
  batchEnqueueUi.visible.value = true
}

export function updateDownloadBatchEnqueueProgress(handled: number, enqueued: number): void {
  batchEnqueueUi.current.value = handled
  batchEnqueueUi.enqueued.value = enqueued
}

export function showBatchEnqueueFailures(
  failures: EnqueueFailureItem[],
  jobOptions: BatchEnqueueOptions,
  enqueued: number,
): void {
  batchEnqueueUi.phase.value = 'failures'
  batchEnqueueUi.failures.value = failures
  batchEnqueueUi.checkedFailureIds.value = new Set(failures.map((f) => f.comicId))
  batchEnqueueUi.jobOptions.value = jobOptions
  batchEnqueueUi.enqueued.value = enqueued
  batchEnqueueUi.retrying.value = false
}

export function showBatchEnqueueDone(summary: string, options?: { requireDismiss?: boolean }): void {
  batchEnqueueUi.doneSummary.value = summary
  batchEnqueueUi.retrying.value = false
  if (options?.requireDismiss) {
    batchEnqueueUi.phase.value = 'done'
    return
  }
  dismissDownloadBatchEnqueueOverlay()
}

export function dismissDownloadBatchEnqueueOverlay(): void {
  batchEnqueueUi.visible.value = false
  batchEnqueueUi.phase.value = 'running'
  cancelRequested = false
  batchEnqueueUi.jobOptions.value = null
  const resolve = dismissWaiter
  dismissWaiter = null
  resolve?.()
}

export function waitForBatchEnqueueOverlayDismissed(): Promise<void> {
  if (!batchEnqueueUi.visible.value) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    dismissWaiter = resolve
  })
}

export function runSerializedDownloadBatch(work: () => Promise<void>): Promise<void> {
  enqueueRunning++
  const job = enqueueTail
    .then(async () => {
      await work()
      await waitForBatchEnqueueOverlayDismissed()
    })
    .finally(() => {
      enqueueRunning--
    })
  enqueueTail = job.catch(() => {})
  return job
}

/** @deprecated 僅供舊引用；請改用 batchEnqueueUi */
export const downloadBatchEnqueueProgress = batchEnqueueUi
