import { computed, defineComponent } from 'vue'
import { useStore } from '../../../store.ts'
import { ProgressData } from '../../../types.ts'
import { commands, DownloadTaskState } from '../../../bindings.ts'
import { NCheckbox } from 'naive-ui'
import styles from './UncompletedProgresses.module.css'
import DownloadTaskToolbar from './DownloadTaskToolbar.tsx'
import DownloadTaskRowActions from './DownloadTaskRowActions.tsx'
import { useProgressSelection } from './useProgressSelection.ts'
import { groupProgressEntries } from '../groupedProgress.ts'
import DownloadSeriesGroupBlock from './DownloadSeriesGroupBlock.tsx'
import { DownloadProgress } from './DownloadProgress.tsx'
import { useScrollContainerWheelFix } from './useScrollContainerWheelFix.ts'
import { useSeriesGroupAccordion } from './useSeriesGroupAccordion.ts'

export default defineComponent({
  name: 'UncompletedProgress',
  setup: function () {
    const store = useStore()
    const { listEl } = useScrollContainerWheelFix()
    const { isSeriesGroupExpanded, toggleSeriesGroup } = useSeriesGroupAccordion()

    const uncompletedProgresses = computed<[number, ProgressData][]>(() =>
      Array.from(store.progresses.entries())
        .filter(([, { state }]) => state === 'Pending' || state === 'Downloading' || state === 'Paused')
        .sort((a, b) => b[1].totalImgCount - a[1].totalImgCount),
    )

    const grouped = computed(() => groupProgressEntries(uncompletedProgresses.value))

    const listIds = computed(() => uncompletedProgresses.value.map(([id]) => id))
    const { checkedIds, allChecked, setSelectAll, setItemChecked } = useProgressSelection(listIds)

    async function handleProgressDoubleClick(state: DownloadTaskState, comicId: number) {
      if (state === 'Downloading' || state === 'Pending') {
        const result = await commands.pauseDownloadTask(comicId)
        if (result.status === 'error') {
          console.error(result.error)
        }
      } else {
        const result = await commands.resumeDownloadTask(comicId)
        if (result.status === 'error') {
          console.error(result.error)
        }
      }
    }

    async function handleGroupDoubleClick(_state: DownloadTaskState, comicIds: number[]) {
      for (const comicId of comicIds) {
        const child = store.progresses.get(comicId)
        if (child !== undefined) {
          await handleProgressDoubleClick(child.state, comicId)
        }
      }
    }

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

    function renderChildRow(comicId: number, { state, comic, percentage, indicator, totalBytes, totalImgCount, downloadedBytes }: ProgressData) {
      return (
        <div
          key={comicId}
          class={[
            `${styles.seriesChildRow} flex items-center gap-2 p-2 rounded-lg`,
            checkedIds.value.has(comicId) ? 'selected' : '',
          ]}
          onDblclick={() => handleProgressDoubleClick(state, comicId)}>
          <DownloadTaskRowActions comicId={comicId} />
          <DownloadProgress
            class="flex-1 min-w-0"
            percentage={percentage}
            state={state}
            title={comic.title}
            indicator={indicator}
            hasProgress={totalBytes > 0 || totalImgCount > 0 || downloadedBytes > 0}
          />
        </div>
      )
    }

    function renderStandaloneRow(comicId: number, data: ProgressData) {
      const { state, comic, percentage, indicator, totalBytes, totalImgCount, downloadedBytes } = data
      return (
        <div
          key={comicId}
          class={[
            `${styles.row} flex items-center gap-2 p-3 mb-1.5 rounded-lg`,
            checkedIds.value.has(comicId) ? 'selected' : '',
          ]}
          onDblclick={() => handleProgressDoubleClick(state, comicId)}>
          <span class="mt-0.5 shrink-0" onClick={(e: MouseEvent) => e.stopPropagation()}>
            <NCheckbox
              checked={checkedIds.value.has(comicId)}
              onUpdate:checked={(v) => setItemChecked(comicId, v === true)}
            />
          </span>
          <DownloadTaskRowActions comicId={comicId} />
          <DownloadProgress
            class="flex-1 min-w-0"
            percentage={percentage}
            state={state}
            title={comic.title}
            indicator={indicator}
            hasProgress={totalBytes > 0 || totalImgCount > 0 || downloadedBytes > 0}
          />
        </div>
      )
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
              onGroupDoubleClick={handleGroupDoubleClick}
              renderChild={renderChildRow}
            />
          ))}
          {grouped.value.standalone.map(([comicId, data]) => renderStandaloneRow(comicId, data))}
        </div>
      </div>
    )
  },
})
