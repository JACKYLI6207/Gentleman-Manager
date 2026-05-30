import { computed, defineComponent } from 'vue'
import { useStore } from '../../../store.ts'
import { ProgressData } from '../../../types.ts'
import { commands } from '../../../bindings.ts'
import { NCheckbox } from 'naive-ui'
import DownloadTaskToolbar from './DownloadTaskToolbar.tsx'
import DownloadTaskRowActions from './DownloadTaskRowActions.tsx'
import { useProgressSelection } from './useProgressSelection.ts'
import { groupProgressEntries } from '../groupedProgress.ts'
import DownloadSeriesGroupBlock from './DownloadSeriesGroupBlock.tsx'
import { useScrollContainerWheelFix } from './useScrollContainerWheelFix.ts'
import { useSeriesGroupAccordion } from './useSeriesGroupAccordion.ts'
import styles from './UncompletedProgresses.module.css'

export default defineComponent({
  name: 'FailedProgress',
  setup() {
    const store = useStore()
    const { listEl } = useScrollContainerWheelFix()
    const { isSeriesGroupExpanded, toggleSeriesGroup } = useSeriesGroupAccordion()

    const failedProgresses = computed<[number, ProgressData][]>(() =>
      Array.from(store.progresses.entries())
        .filter(([, { state }]) => state === 'Failed')
        .sort((a, b) => b[0] - a[0]),
    )

    const grouped = computed(() => groupProgressEntries(failedProgresses.value))

    const listIds = computed(() => failedProgresses.value.map(([id]) => id))
    const { checkedIds, allChecked, setSelectAll, setItemChecked } = useProgressSelection(listIds)

    async function resumeChecked() {
      for (const comicId of checkedIds.value) {
        const result = await commands.resumeDownloadTask(comicId)
        if (result.status === 'error') {
          console.error(result.error)
        }
      }
    }

    async function pauseChecked() {
      for (const comicId of checkedIds.value) {
        const result = await commands.pauseDownloadTask(comicId)
        if (result.status === 'error') {
          console.error(result.error)
        }
      }
    }

    async function cancelChecked() {
      for (const comicId of checkedIds.value) {
        const result = await commands.cancelDownloadTask(comicId)
        if (result.status === 'error') {
          console.error(result.error)
        }
      }
    }

    function renderFailedRow(comicId: number, { comic, indicator }: ProgressData, isChild = false) {
      return (
        <div
          key={comicId}
          class={[
            isChild ? styles.seriesChildRow : styles.row,
            'flex items-center gap-2 p-2.5 rounded-lg',
            isChild ? '' : 'mb-1.5',
            checkedIds.value.has(comicId) ? 'selected' : '',
          ]}>
          {!isChild && (
            <NCheckbox
              class="mt-0.5 shrink-0"
              checked={checkedIds.value.has(comicId)}
              onUpdate:checked={(v) => setItemChecked(comicId, v === true)}
            />
          )}
          <DownloadTaskRowActions comicId={comicId} />
          <div class="flex flex-col flex-1 min-w-0">
            <span class="font-bold text-sm truncate" title={comic.title}>
              {comic.title}
            </span>
            <span class="text-xs text-red-4 mt-0.5 truncate">{indicator}</span>
          </div>
        </div>
      )
    }

    function renderFailedChild(comicId: number, data: ProgressData) {
      return renderFailedRow(comicId, data, true)
    }

    function renderFailedStandalone(comicId: number, data: ProgressData) {
      return renderFailedRow(comicId, data, false)
    }

    return () => (
      <div class="h-full min-h-0 flex flex-col gap-2 box-border">
        <DownloadTaskToolbar
          allChecked={allChecked.value}
          onSelectAllChange={setSelectAll}
          onResume={resumeChecked}
          onPause={pauseChecked}
          onCancel={cancelChecked}
        />

        <div ref={listEl} class={`${styles.listContainer} select-none p-2`}>
          {grouped.value.seriesGroups.map((group) => (
            <DownloadSeriesGroupBlock
              key={group.seriesParentDir}
              group={group}
              checkedIds={checkedIds.value}
              expanded={isSeriesGroupExpanded(group.seriesParentDir)}
              onToggle={() => toggleSeriesGroup(group.seriesParentDir)}
              onItemCheckedChange={setItemChecked}
              renderChild={renderFailedChild}
            />
          ))}
          {grouped.value.standalone.map(([id, data]) => renderFailedStandalone(id, data))}
        </div>
      </div>
    )
  },
})
