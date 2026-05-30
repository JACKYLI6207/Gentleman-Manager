import { computed, defineComponent, ref, watch, PropType } from 'vue'
import {
  NModal,
  NDialog,
  NRadioGroup,
  NRadio,
  NCheckbox,
  NAlert,
  NSpin,
  useMessage,
} from 'naive-ui'
import { useStore } from '../store.ts'
import { commands, ComicInSearch } from '../bindings.ts'
import { stripLeadingTitleMeta } from '../comicSearchName.ts'
import {
  analyzeKoreanWebtoon,
  defaultCheckedIds,
  type KoreanDownloadStrategy,
  type KoreanWebtoonAnalysis,
} from '../koreanWebtoon.ts'
import {
  analyzeKoreanTxtDuplicates,
  normalizePageTagLabel,
  type KoreanTxtDuplicateAnalysis,
} from '../koreanTxtDuplicate.ts'
import { enqueueComicIds } from '../utils/batchEnqueueRunner.ts'
import {
  beginDownloadBatchEnqueueProgress,
  dismissDownloadBatchEnqueueOverlay,
  runSerializedDownloadBatch,
  showBatchEnqueueDone,
  showBatchEnqueueFailures,
  updateDownloadBatchEnqueueProgress,
} from '../utils/downloadBatchEnqueue.ts'

export default defineComponent({
  name: 'KoreanDownloadModeDialog',
  props: {
    showing: {
      type: Boolean,
      required: true,
    },
    comics: {
      type: Array as PropType<ComicInSearch[]>,
      required: true,
    },
    tagLabel: {
      type: String,
      required: true,
    },
  },
  emits: {
    'update:showing': (_value: boolean) => true,
  },
  setup(props, { emit }) {
    const store = useStore()
    const message = useMessage()

    const analysis = computed<KoreanWebtoonAnalysis>(() =>
      analyzeKoreanWebtoon(props.comics, props.tagLabel),
    )

    const strategy = ref<KoreanDownloadStrategy>('episodes')
    const checkedIds = ref<Set<number>>(new Set())
    const submitting = ref(false)
    const txtDuplicateLoading = ref(false)
    const txtDuplicateAnalysis = ref<KoreanTxtDuplicateAnalysis | null>(null)
    const txtDuplicateError = ref<string | null>(null)
    const similarFolderDialogShowing = ref(false)
    const similarFolderChoices = ref<string[]>([])
    const similarFolderChoice = ref<'new' | string>('new')
    let similarFolderResolver: ((value: 'cancel' | 'new' | string) => void) | null = null

    const folderSeriesLabel = computed(() => {
      const normalized =
        normalizePageTagLabel(analysis.value.tagLabel) ?? analysis.value.tagLabel
      return stripLeadingTitleMeta(normalized)
    })

    function askSimilarFolderChoice(candidates: string[]): Promise<'cancel' | 'new' | string> {
      similarFolderChoices.value = candidates
      similarFolderChoice.value = candidates[0] ?? 'new'
      similarFolderDialogShowing.value = true
      return new Promise((resolve) => {
        similarFolderResolver = resolve
      })
    }

    function resolveSimilarFolderChoice(value: 'cancel' | 'new' | string) {
      similarFolderDialogShowing.value = false
      similarFolderChoices.value = []
      similarFolderResolver?.(value)
      similarFolderResolver = null
    }

    async function runTxtDuplicateAnalysis() {
      txtDuplicateAnalysis.value = null
      txtDuplicateError.value = null

      const config = store.config
      if (config === undefined || !config.koreanTxtDuplicateCheckEnabled) {
        return
      }
      const catalogDir = config.koreanTxtCatalogDir?.trim() ?? ''
      if (catalogDir === '') {
        return
      }

      txtDuplicateLoading.value = true
      try {
        const result = await commands.readKoreanTxtCatalog(catalogDir)
        if (result.status === 'error') {
          txtDuplicateError.value = result.error.err_message || '讀取 TXT 目錄失敗'
          return
        }
        txtDuplicateAnalysis.value = analyzeKoreanTxtDuplicates(
          normalizePageTagLabel(analysis.value.tagLabel) ?? analysis.value.tagLabel,
          props.comics,
          result.data,
        )
      } finally {
        txtDuplicateLoading.value = false
      }
    }

    function applyDefaultChecks() {
      checkedIds.value = new Set(defaultCheckedIds(analysis.value, strategy.value))
    }

    watch(
      () => props.showing,
      (show) => {
        if (!show) {
          txtDuplicateAnalysis.value = null
          txtDuplicateError.value = null
          return
        }
        if (analysis.value.episodes.length > 0) {
          strategy.value = 'episodes'
        } else if (analysis.value.anthologies.length > 0) {
          strategy.value = 'anthology'
        }
        applyDefaultChecks()
        void runTxtDuplicateAnalysis()
      },
      { immediate: true },
    )

    watch(strategy, () => {
      applyDefaultChecks()
    })

    const previewItems = computed(() => {
      if (strategy.value === 'anthology') {
        return analysis.value.anthologies
      }
      return analysis.value.episodes
    })

    const episodesDisabled = computed(() => analysis.value.episodes.length === 0)
    const anthologyDisabled = computed(() => analysis.value.anthologies.length === 0)

    function toggleItem(id: number, checked: boolean) {
      const next = new Set(checkedIds.value)
      if (checked) {
        next.add(id)
      } else {
        next.delete(id)
      }
      checkedIds.value = next
    }

    async function confirm() {
      if (store.config === undefined) {
        return
      }

      if (checkedIds.value.size === 0) {
        message.warning('請至少勾選一項')
        return
      }

      submitting.value = true

      const seriesLabel = folderSeriesLabel.value
      const similarResult = await commands.listSimilarKoreanSeriesFolders(
        seriesLabel,
        analysis.value.rangeMin,
        analysis.value.rangeMax,
      )
      if (similarResult.status === 'error') {
        submitting.value = false
        message.error(similarResult.error.err_message)
        console.error(similarResult.error)
        return
      }

      let existingFolderName: string | null = null
      if (similarResult.data.length > 0) {
        const choice = await askSimilarFolderChoice(similarResult.data)
        if (choice === 'cancel') {
          submitting.value = false
          return
        }
        if (choice !== 'new') {
          existingFolderName = choice
        }
      }

      const folderResult = await commands.prepareKoreanSeriesFolder(
        seriesLabel,
        analysis.value.rangeMin,
        analysis.value.rangeMax,
        existingFolderName,
      )
      if (folderResult.status === 'error') {
        submitting.value = false
        message.error(folderResult.error.err_message)
        console.error(folderResult.error)
        return
      }

      const seriesFolder = folderResult.data
      // 快照：以勾選的預覽項目為準，避免 checkedIds 與 props.comics 不一致
      const selectedItems = previewItems.value.filter((item) => checkedIds.value.has(item.comic.id))
      if (selectedItems.length === 0) {
        submitting.value = false
        message.warning('請至少勾選一項')
        return
      }
      if (selectedItems.length < checkedIds.value.size) {
        submitting.value = false
        message.error('部分勾選項目無法對應漫畫資料，請關閉對話框後重新開啟韓漫下載模式')
        return
      }

      const parseImageCount = (info: string): number => {
        const match = info.match(/(\d+)\s*張/)
        return match !== null ? parseInt(match[1], 10) : 0
      }

      const enqueueJob = {
        seriesFolder,
        ids: selectedItems.map((item) => item.comic.id),
        titleById: new Map(selectedItems.map((item) => [item.comic.id, item.comic.title] as const)),
        imageCountById: new Map(
          selectedItems.map((item) => [item.comic.id, parseImageCount(item.comic.additionalInfo)] as const),
        ),
      }

      emit('update:showing', false)
      submitting.value = false

      void runSerializedDownloadBatch(async () => {
        const jobOptions = {
          seriesFolder: enqueueJob.seriesFolder,
          titleById: enqueueJob.titleById,
          imageCountById: enqueueJob.imageCountById,
        }

        beginDownloadBatchEnqueueProgress(enqueueJob.ids.length, enqueueJob.seriesFolder)

        try {
          const result = await enqueueComicIds(enqueueJob.ids, jobOptions, (handled, enqueued) => {
            updateDownloadBatchEnqueueProgress(handled, enqueued)
          })

          if (result.cancelled) {
            dismissDownloadBatchEnqueueOverlay()
            return
          }

          if (result.failures.length > 0) {
            showBatchEnqueueFailures(result.failures, jobOptions, result.enqueued)
            return
          }

          showBatchEnqueueDone(
            `已加入下載佇列 ${result.enqueued} 本，目錄：${enqueueJob.seriesFolder}`,
          )
        } catch (err) {
          console.error(err)
          showBatchEnqueueDone('加入下載佇列時發生錯誤，請關閉後重試', { requireDismiss: true })
        }
      })
    }

    return () => (
      <>
      <NModal show={props.showing} onUpdate:show={(v) => emit('update:showing', v)}>
        <NDialog
          showIcon={false}
          title={`韓漫下載模式 · ${props.tagLabel}`}
          style={{ width: '36rem', maxWidth: '92vw' }}
          positiveText="加入下載佇列"
          loading={submitting.value}
          onPositiveClick={() => {
            void confirm()
            return false
          }}
          onClose={() => emit('update:showing', false)}>
          <div class="flex flex-col gap-3 max-h-[70vh]">
            <div class="text-sm opacity-80">
              話數範圍：{analysis.value.rangeMin}～{analysis.value.rangeMax}
              {analysis.value.marksComplete ? '（含完結）' : ''}
            </div>

            {analysis.value.coherenceWarning !== undefined && (
              <NAlert type="warning" showIcon={false}>
                {analysis.value.coherenceWarning}
              </NAlert>
            )}

            {txtDuplicateLoading.value && (
              <div class="flex items-center gap-2 text-sm opacity-80">
                <NSpin size="small" />
                <span>正在比對韓漫 TXT 收藏列表…</span>
              </div>
            )}

            {txtDuplicateError.value !== null && (
              <NAlert type="error" showIcon={false}>
                {txtDuplicateError.value}
              </NAlert>
            )}

            {txtDuplicateAnalysis.value !== null &&
              txtDuplicateAnalysis.value.seriesMatches.length > 0 && (
                <NAlert type="info" showIcon={false}>
                  <div class="flex flex-col gap-1">
                    <span>
                      已在 TXT 列表找到 {txtDuplicateAnalysis.value.seriesMatches.length}{' '}
                      筆可能重複（共讀取 {txtDuplicateAnalysis.value.catalogLineCount} 行）
                    </span>
                    {txtDuplicateAnalysis.value.seriesMatches.slice(0, 5).map((line) => (
                      <span key={line} class="text-xs opacity-90 break-words">
                        · {line}
                      </span>
                    ))}
                    {txtDuplicateAnalysis.value.seriesMatches.length > 5 && (
                      <span class="text-xs opacity-60">
                        …另有 {txtDuplicateAnalysis.value.seriesMatches.length - 5} 筆
                      </span>
                    )}
                  </div>
                </NAlert>
              )}

            {txtDuplicateAnalysis.value !== null &&
              txtDuplicateAnalysis.value.catalogLineCount > 0 &&
              txtDuplicateAnalysis.value.seriesMatches.length === 0 && (
                <NAlert type="success" showIcon={false}>
                  TXT 列表中未發現與「{analysis.value.tagLabel}」重複的項目
                </NAlert>
              )}

            <NRadioGroup v-model:value={strategy.value}>
              <div class="flex flex-col gap-2">
                <NRadio value="episodes" disabled={episodesDisabled.value}>
                  分集連載（{analysis.value.episodes.length} 項，依話數批次下載）
                </NRadio>
                <NRadio value="anthology" disabled={anthologyDisabled.value}>
                  完整合集（{analysis.value.anthologies.length} 項，單檔收齊全篇）
                </NRadio>
              </div>
            </NRadioGroup>

            <div class="text-xs opacity-70">
              將下載至資料夾：
              {folderSeriesLabel.value}-{analysis.value.rangeMin}~{analysis.value.rangeMax}-完
              （若下載目錄已有其他資料夾，會自動加上「未分類序號」前綴；已排除韓漫/漢化等前綴）
            </div>

            <div class="flex flex-col gap-2 overflow-auto max-h-64 border border-[var(--n-border-color)] rounded p-2">
              {previewItems.value.length === 0 && (
                <span class="text-sm opacity-60">此標籤下沒有可辨識的韓漫分集或合集</span>
              )}
              {previewItems.value.map((item) => {
                const dupMsg = txtDuplicateAnalysis.value?.itemMessages.get(item.comic.id)
                return (
                  <div key={item.comic.id} class="flex items-start gap-2">
                    <NCheckbox
                      checked={checkedIds.value.has(item.comic.id)}
                      onUpdate:checked={(v) => toggleItem(item.comic.id, v === true)}
                    />
                    <div class="flex flex-col min-w-0">
                      <span class="text-sm line-clamp-2" title={item.comic.title}>
                        {item.comic.title}
                      </span>
                      <span class="text-xs opacity-60">
                        {item.rangeStart === item.rangeEnd
                          ? `第 ${item.rangeStart} 話`
                          : `第 ${item.rangeStart}–${item.rangeEnd} 話`}
                        ，{item.imageCount} 張
                        {item.comic.isDownloaded ? ' · 已下載' : ''}
                      </span>
                      {dupMsg !== undefined && (
                        <span class="text-xs text-amber-400 mt-0.5 break-words">{dupMsg}</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </NDialog>
      </NModal>
      <NModal
        show={similarFolderDialogShowing.value}
        onUpdate:show={(v) => {
          if (!v) {
            resolveSimilarFolderChoice('cancel')
          }
        }}>
        <NDialog
          showIcon={false}
          title="發現相似漫畫資料夾"
          style={{ width: '32rem', maxWidth: '92vw' }}
          positiveText="確認"
          negativeText="取消"
          onPositiveClick={() => {
            resolveSimilarFolderChoice(
              similarFolderChoice.value === 'new' ? 'new' : similarFolderChoice.value,
            )
            return true
          }}
          onNegativeClick={() => {
            resolveSimilarFolderChoice('cancel')
            return true
          }}
          onClose={() => resolveSimilarFolderChoice('cancel')}>
          <div class="flex flex-col gap-3">
            <div class="text-sm opacity-80">
              下載目錄中已有名稱相似的資料夾，請選擇要新建資料夾，或使用現有資料夾繼續下載。
            </div>
            <NRadioGroup v-model:value={similarFolderChoice.value}>
              <div class="flex flex-col gap-2">
                <NRadio value="new">新建資料夾</NRadio>
                {similarFolderChoices.value.map((name) => (
                  <NRadio key={name} value={name}>
                    使用現有：{name}
                  </NRadio>
                ))}
              </div>
            </NRadioGroup>
          </div>
        </NDialog>
      </NModal>
      </>
    )
  },
})
