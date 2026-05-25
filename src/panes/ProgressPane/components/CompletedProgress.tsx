import { computed, defineComponent } from 'vue'
import { useStore } from '../../../store.ts'
import { ProgressData } from '../../../types.ts'
import { commands } from '../../../bindings.ts'
import { NCheckbox } from 'naive-ui'
import { path } from '@tauri-apps/api'
import { PhFolderOpen } from '@phosphor-icons/vue'
import CompletedToolbar from './CompletedToolbar.tsx'
import { useProgressSelection } from './useProgressSelection.ts'
import { groupProgressEntries } from '../groupedProgress.ts'
import DownloadSeriesGroupBlock from './DownloadSeriesGroupBlock.tsx'
import { useScrollContainerWheelFix } from './useScrollContainerWheelFix.ts'
import { useSeriesGroupAccordion } from './useSeriesGroupAccordion.ts'
import styles from './UncompletedProgresses.module.css'

export default defineComponent({
  name: 'CompletedProgress',
  setup() {
    const store = useStore()
    const { listEl } = useScrollContainerWheelFix()
    const { isSeriesGroupExpanded, toggleSeriesGroup } = useSeriesGroupAccordion()

    const completedProgresses = computed<[number, ProgressData][]>(() =>
      Array.from(store.progresses.entries())
        .filter(([, { state }]) => state === 'Completed')
        .sort((a, b) => b[1].totalImgCount - a[1].totalImgCount),
    )

    const grouped = computed(() => groupProgressEntries(completedProgresses.value))

    const listIds = computed(() => completedProgresses.value.map(([id]) => id))
    const { checkedIds, allChecked, setSelectAll, setItemChecked } = useProgressSelection(listIds)

    async function clearCheckedRecords() {
      const ids = [...checkedIds.value]
      for (const comicId of ids) {
        const result = await commands.removeDownloadTaskRecord(comicId)
        if (result.status === 'error') {
          console.error(result.error)
        }
        store.deleteProgress(comicId)
      }
      checkedIds.value = new Set()
    }

    async function openFolder(downloadPath: string | undefined, comicTitle: string) {
      if (store.config === undefined) return
      const targetPath = downloadPath ?? (await path.join(store.config.downloadDir, comicTitle))
      const result = await commands.showPathInFileManager(targetPath)
      if (result.status === 'error') {
        console.error(result.error)
      }
    }

    function renderCompletedRow(
      comicId: number,
      { comic, downloadPath, totalImgCount }: ProgressData,
      isChild = false,
    ) {
      const pages = totalImgCount > 0 ? totalImgCount : comic.imageCount
      return (
        <div
          key={comicId}
          class={[
            isChild ? styles.seriesChildRow : styles.row,
            'flex items-center gap-2 p-2.5 rounded-lg',
            checkedIds.value.has(comicId) ? 'selected' : '',
          ]}>
          {!isChild && (
            <NCheckbox
              class="shrink-0"
              checked={checkedIds.value.has(comicId)}
              onUpdate:checked={(v) => setItemChecked(comicId, v === true)}
            />
          )}
          <button
            class="shrink-0 flex items-center justify-center w-7 h-7 rounded opacity-55 hover:opacity-100 text-[var(--n-text-color)] transition-opacity cursor-pointer bg-transparent border-0 p-0"
            title="開啟下載目錄"
            onClick={() => void openFolder(downloadPath, comic.title)}>
            <PhFolderOpen size={18} />
          </button>
          <div class="flex-1 min-w-0">
            <div class="font-bold text-sm truncate leading-snug" title={comic.title}>
              {comic.title}
            </div>
            <div class="text-xs text-green-500 mt-0.5">
              已完成 · {pages}P
            </div>
          </div>
        </div>
      )
    }

    function renderCompletedChild(comicId: number, data: ProgressData) {
      return renderCompletedRow(comicId, data, true)
    }

    return () => (
      <div class="h-full min-h-0 flex flex-col gap-2">
        <CompletedToolbar
          allChecked={allChecked.value}
          onSelectAllChange={setSelectAll}
          onClearRecords={clearCheckedRecords}
        />

        <div ref={listEl} class={`${styles.listContainer} flex flex-col gap-1.5 p-2`}>
          {grouped.value.seriesGroups.map((group) => (
            <DownloadSeriesGroupBlock
              key={group.seriesParentDir}
              group={group}
              checkedIds={checkedIds.value}
              expanded={isSeriesGroupExpanded(group.seriesParentDir)}
              onToggle={() => toggleSeriesGroup(group.seriesParentDir)}
              showGroupActions={false}
              onItemCheckedChange={setItemChecked}
              renderChild={renderCompletedChild}
            />
          ))}
          {grouped.value.standalone.map(([id, data]) => renderCompletedRow(id, data, false))}
        </div>
      </div>
    )
  },
})
