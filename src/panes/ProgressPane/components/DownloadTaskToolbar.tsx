import { defineComponent, PropType } from 'vue'
import { NButton, NCheckbox, NDropdown } from 'naive-ui'

export default defineComponent({
  name: 'DownloadTaskToolbar',
  props: {
    allChecked: {
      type: Boolean,
      required: true,
    },
    onSelectAllChange: {
      type: Function as PropType<(checked: boolean) => void>,
      required: true,
    },
    onResume: {
      type: Function as PropType<() => void>,
      required: true,
    },
    onPause: {
      type: Function as PropType<() => void>,
      required: true,
    },
    onCancel: {
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
        <NButton size="small" onClick={props.onResume}>
          繼續下載
        </NButton>
        <NButton size="small" onClick={props.onPause}>
          暫停下載
        </NButton>
        <NDropdown
          trigger="click"
          placement="bottom-start"
          options={[{ label: '確認取消', key: 'confirm' }]}
          onSelect={() => props.onCancel()}>
          <NButton size="small">取消下載</NButton>
        </NDropdown>
      </div>
    )
  },
})
