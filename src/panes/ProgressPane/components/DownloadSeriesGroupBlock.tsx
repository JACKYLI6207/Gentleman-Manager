import { computed, defineComponent, type PropType, type VNode } from 'vue'
import { NCheckbox } from 'naive-ui'
import { PhCaretDown, PhCaretRight, PhFolders } from '@phosphor-icons/vue'
import type { DownloadTaskState } from '../../../bindings.ts'
import type { ProgressData } from '../../../types.ts'
import {
  aggregateGroupProgress,
  groupChildIds,
  isGroupFullyChecked,
  isGroupPartiallyChecked,
  type SeriesGroup,
} from '../groupedProgress.ts'
import { DownloadProgress } from './DownloadProgress.tsx'
import DownloadTaskGroupActions from './DownloadTaskGroupActions.tsx'
import SeriesGroupChildrenList from './SeriesGroupChildrenList.tsx'
import styles from './UncompletedProgresses.module.css'

export default defineComponent({
  name: 'DownloadSeriesGroupBlock',
  props: {
    group: {
      type: Object as PropType<SeriesGroup>,
      required: true,
    },
    checkedIds: {
      type: Object as PropType<Set<number>>,
      required: true,
    },
    expanded: {
      type: Boolean,
      required: true,
    },
    onToggle: {
      type: Function as PropType<() => void>,
      required: true,
    },
    onItemCheckedChange: {
      type: Function as PropType<(comicId: number, checked: boolean) => void>,
      required: true,
    },
    renderChild: {
      type: Function as PropType<(comicId: number, data: ProgressData) => VNode>,
      required: true,
    },
    onGroupDoubleClick: {
      type: Function as PropType<(state: DownloadTaskState, comicIds: number[]) => void>,
    },
    showGroupActions: {
      type: Boolean,
      default: true,
    },
    childIndent: {
      type: Boolean,
      default: true,
    },
  },
  setup(props) {
    const childIds = computed(() => groupChildIds(props.group))
    const aggregated = computed(() => aggregateGroupProgress(props.group.children.map(([, data]) => data)))

    function setGroupChecked(checked: boolean) {
      for (const id of childIds.value) {
        props.onItemCheckedChange(id, checked)
      }
    }

    return () => {
      const groupChecked = isGroupFullyChecked(childIds.value, props.checkedIds)
      const groupIndeterminate = isGroupPartiallyChecked(childIds.value, props.checkedIds)

      return (
        <div class={`${styles.seriesGroup} mb-2 rounded-lg overflow-hidden`}>
          <div
            class={[
              `${styles.seriesGroupHeader} flex items-center gap-2 p-3 cursor-pointer`,
              groupChecked || groupIndeterminate ? `selected ${styles.seriesGroupHeaderSelected}` : '',
            ]}
            onClick={() => {
              props.onToggle()
            }}
            onDblclick={(e: MouseEvent) => {
              e.stopPropagation()
              props.onGroupDoubleClick?.(aggregated.value.state, childIds.value)
            }}>
            <span class="mt-0.5 shrink-0" onClick={(e: MouseEvent) => e.stopPropagation()}>
              <NCheckbox
                checked={groupChecked}
                indeterminate={groupIndeterminate}
                onUpdate:checked={(v) => setGroupChecked(v === true)}
              />
            </span>
            {props.showGroupActions && <DownloadTaskGroupActions comicIds={childIds.value} />}
            <span class="shrink-0 text-gray-400" title={props.expanded ? '收合' : '展開'}>
              {props.expanded ? <PhCaretDown size={18} /> : <PhCaretRight size={18} />}
            </span>
            <PhFolders size={20} class="shrink-0 text-amber-400" />
            <DownloadProgress
              class="flex-1 min-w-0"
              percentage={aggregated.value.percentage}
              state={aggregated.value.state}
              title={props.group.seriesParentDir}
              subtitle="韓漫批次下載"
              indicator={aggregated.value.indicator}
              hasProgress={aggregated.value.hasProgress}
            />
          </div>
          {props.expanded && (
            <SeriesGroupChildrenList indented={props.childIndent}>
              {props.group.children.map(([comicId, data]) => props.renderChild(comicId, data))}
            </SeriesGroupChildrenList>
          )}
        </div>
      )
    }
  },
})
