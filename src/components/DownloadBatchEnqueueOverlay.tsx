import { computed, defineComponent, ref } from 'vue'
import { Teleport } from 'vue'
import { NButton, NCheckbox, NProgress, NSpin } from 'naive-ui'
import { summarizeEnqueueError } from '../utils/enqueueErrorSummary.ts'
import {
  batchEnqueueUi,
  dismissDownloadBatchEnqueueOverlay,
  requestCancelDownloadBatchEnqueue,
  updateDownloadBatchEnqueueProgress,
} from '../utils/downloadBatchEnqueue.ts'
import { enqueueComicIds } from '../utils/batchEnqueueRunner.ts'

export default defineComponent({
  name: 'DownloadBatchEnqueueOverlay',
  setup() {
    const expandedFailureIds = ref<Set<number>>(new Set())

    const progressText = computed(() => {
      const { current, total, enqueued } = batchEnqueueUi
      return `正在加入下載佇列（處理 ${current.value}/${total.value}，已加入 ${enqueued.value} 本）`
    })

    const percentage = computed(() => {
      const { current, total } = batchEnqueueUi
      if (total.value <= 0) {
        return 0
      }
      return Math.min(100, Math.round((current.value / total.value) * 100))
    })

    const failureHeader = computed(() => {
      const n = batchEnqueueUi.failures.value.length
      return `以下 ${n} 本未能加入下載佇列`
    })

    const failureSubtitle = computed(() => {
      const { enqueued, total, abandonedCount } = batchEnqueueUi
      const parts = [`已成功加入 ${enqueued.value} / ${total.value} 本`]
      if (abandonedCount.value > 0) {
        parts.push(`已取消加入 ${abandonedCount.value} 本`)
      }
      return parts.join(' · ')
    })

    const allFailuresChecked = computed(() => {
      const failures = batchEnqueueUi.failures.value
      if (failures.length === 0) {
        return false
      }
      return failures.every((f) => batchEnqueueUi.checkedFailureIds.value.has(f.comicId))
    })

    const someFailuresChecked = computed(() => {
      const checked = batchEnqueueUi.checkedFailureIds.value
      return (
        checked.size > 0 && !batchEnqueueUi.failures.value.every((f) => checked.has(f.comicId))
      )
    })

    function setFailureChecked(comicId: number, checked: boolean) {
      const next = new Set(batchEnqueueUi.checkedFailureIds.value)
      if (checked) {
        next.add(comicId)
      } else {
        next.delete(comicId)
      }
      batchEnqueueUi.checkedFailureIds.value = next
    }

    function setAllFailuresChecked(checked: boolean) {
      if (checked) {
        batchEnqueueUi.checkedFailureIds.value = new Set(
          batchEnqueueUi.failures.value.map((f) => f.comicId),
        )
      } else {
        batchEnqueueUi.checkedFailureIds.value = new Set()
      }
    }

    function onCancelRunning() {
      requestCancelDownloadBatchEnqueue()
    }

    function finishIfNoFailuresLeft() {
      if (batchEnqueueUi.failures.value.length > 0) {
        return
      }
      dismissDownloadBatchEnqueueOverlay()
    }

    async function retrySelectedFailures() {
      const options = batchEnqueueUi.jobOptions.value
      if (options === null) {
        return
      }
      const ids = [...batchEnqueueUi.checkedFailureIds.value]
      if (ids.length === 0) {
        return
      }

      batchEnqueueUi.retrying.value = true
      try {
        const baseEnqueued = batchEnqueueUi.enqueued.value
        const result = await enqueueComicIds(ids, options, () => {}, 0, baseEnqueued)

        if (result.cancelled) {
          return
        }

        batchEnqueueUi.enqueued.value = result.enqueued

        const retriedSet = new Set(ids)
        const merged = new Map(
          batchEnqueueUi.failures.value
            .filter((f) => !retriedSet.has(f.comicId))
            .map((f) => [f.comicId, f] as const),
        )
        for (const failure of result.failures) {
          merged.set(failure.comicId, failure)
        }
        batchEnqueueUi.failures.value = [...merged.values()]

        batchEnqueueUi.checkedFailureIds.value = new Set(
          batchEnqueueUi.failures.value.map((f) => f.comicId),
        )

        finishIfNoFailuresLeft()
      } finally {
        batchEnqueueUi.retrying.value = false
      }
    }

    function cancelAddSelectedFailures() {
      const checked = batchEnqueueUi.checkedFailureIds.value
      if (checked.size === 0) {
        return
      }
      batchEnqueueUi.abandonedCount.value += checked.size
      batchEnqueueUi.failures.value = batchEnqueueUi.failures.value.filter(
        (f) => !checked.has(f.comicId),
      )
      batchEnqueueUi.checkedFailureIds.value = new Set(
        batchEnqueueUi.failures.value.map((f) => f.comicId),
      )
      finishIfNoFailuresLeft()
    }

    function onCloseDone() {
      dismissDownloadBatchEnqueueOverlay()
    }

    function toggleFailureDetail(comicId: number) {
      const next = new Set(expandedFailureIds.value)
      if (next.has(comicId)) {
        next.delete(comicId)
      } else {
        next.add(comicId)
      }
      expandedFailureIds.value = next
    }

    return () => {
      if (!batchEnqueueUi.visible.value) {
        return null
      }

      const phase = batchEnqueueUi.phase.value

      return (
        <Teleport to="body">
          <div
            class="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60"
            onClick={(e: MouseEvent) => e.stopPropagation()}
            onMousedown={(e: MouseEvent) => e.stopPropagation()}>
            <div
              class="flex flex-col gap-4 px-6 py-5 rounded-xl bg-[#2a2a2a] border border-[rgba(255,255,255,0.14)] shadow-xl w-[min(36rem,92vw)] max-h-[85vh]"
              role="dialog"
              aria-modal="true">
              {phase === 'running' && (
                <>
                  <div class="flex flex-col items-center gap-3">
                    <NSpin size="large" />
                    <span class="text-sm text-gray-100 text-center leading-relaxed">
                      {progressText.value}
                    </span>
                    <NProgress
                      type="line"
                      percentage={percentage.value}
                      indicator-placement="inside"
                      processing
                      class="w-full"
                    />
                    <span class="text-xs opacity-60 text-center">
                      僅建立佇列項目（不連線官網）；實際下載輪到該本時才請求。
                      <br />
                      完成或按「取消」前，無法操作其他功能
                    </span>
                  </div>
                  <NButton type="warning" block onClick={onCancelRunning}>
                    取消
                  </NButton>
                </>
              )}

              {phase === 'failures' && (
                <>
                  <div class="flex flex-col gap-1 shrink-0">
                    <span class="text-base font-medium text-gray-100">{failureHeader.value}</span>
                    <span class="text-xs opacity-70">{failureSubtitle.value}</span>
                    <span class="text-xs opacity-50">
                      請勾選項目後按「再次嘗試」或「取消加入」；處理完所有失敗項目前無法關閉此視窗
                    </span>
                  </div>

                  <div class="flex items-center gap-2 shrink-0">
                    <NCheckbox
                      checked={allFailuresChecked.value}
                      indeterminate={someFailuresChecked.value}
                      onUpdate:checked={(v) => setAllFailuresChecked(v === true)}
                    />
                    <span class="text-sm opacity-80">全選</span>
                  </div>

                  <div class="flex flex-col gap-2 overflow-y-auto min-h-0 flex-1 max-h-64 border border-[var(--n-border-color)] rounded p-2">
                    {batchEnqueueUi.failures.value.map((item) => {
                      const expanded = expandedFailureIds.value.has(item.comicId)
                      const summary = summarizeEnqueueError(item.errorMessage)
                      return (
                        <div key={item.comicId} class="flex items-start gap-2 py-1">
                          <NCheckbox
                            checked={batchEnqueueUi.checkedFailureIds.value.has(item.comicId)}
                            onUpdate:checked={(v) => setFailureChecked(item.comicId, v === true)}
                          />
                          <div class="flex flex-col min-w-0 gap-1">
                            <span class="text-sm leading-snug break-words">{item.title}</span>
                            <span class="text-xs opacity-70 break-words">{summary}</span>
                            <button
                              type="button"
                              class="text-xs text-sky-400 hover:underline w-fit text-left"
                              onClick={() => toggleFailureDetail(item.comicId)}>
                              {expanded ? '收合詳情' : '展開詳情'}
                            </button>
                            {expanded && (
                              <pre class="text-xs text-amber-400/90 whitespace-pre-wrap break-words max-h-32 overflow-y-auto rounded bg-black/25 p-2">
                                {item.errorMessage}
                              </pre>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  <div class="flex flex-col gap-2 shrink-0">
                    <NButton
                      type="primary"
                      block
                      loading={batchEnqueueUi.retrying.value}
                      disabled={batchEnqueueUi.checkedFailureIds.value.size === 0}
                      onClick={() => void retrySelectedFailures()}>
                      再次嘗試
                    </NButton>
                    <NButton
                      type="warning"
                      block
                      disabled={batchEnqueueUi.checkedFailureIds.value.size === 0}
                      onClick={cancelAddSelectedFailures}>
                      取消加入
                    </NButton>
                  </div>
                </>
              )}

              {phase === 'done' && (
                <>
                  <div class="flex flex-col items-center gap-3 py-2">
                    <span class="text-sm text-gray-100 text-center leading-relaxed whitespace-pre-wrap">
                      {batchEnqueueUi.doneSummary.value}
                    </span>
                  </div>
                  <NButton type="primary" block onClick={onCloseDone}>
                    關閉
                  </NButton>
                </>
              )}
            </div>
          </div>
        </Teleport>
      )
    }
  },
})
