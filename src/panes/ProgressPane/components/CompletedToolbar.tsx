import { defineComponent, PropType } from 'vue'
import { NButton, NCheckbox } from 'naive-ui'

export default defineComponent({
  name: 'CompletedToolbar',
  props: {
    allChecked: {
      type: Boolean,
      required: true,
    },
    onSelectAllChange: {
      type: Function as PropType<(checked: boolean) => void>,
      required: true,
    },
    onClearRecords: {
      type: Function as PropType<() => void>,
      required: true,
    },
  },
  setup(props) {
    return () => (
      <div class="flex flex-wrap items-center gap-2 px-2 pt-0.5">
        <NCheckbox checked={props.allChecked} onUpdate:checked={(v) => props.onSelectAllChange(v === true)}>
          全選
        </NCheckbox>
        <NButton size="small" onClick={props.onClearRecords}>
          清除紀錄
        </NButton>
      </div>
    )
  },
})
