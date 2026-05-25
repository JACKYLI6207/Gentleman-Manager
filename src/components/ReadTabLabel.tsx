import { defineComponent, PropType } from 'vue'
import type { ReadSection } from '../types.ts'
import SubmenuTabLabel from './SubmenuTabLabel.tsx'

const READ_ITEMS = [
  { key: 'online' as const, label: '在線閱讀' },
  { key: 'local' as const, label: '本地閱讀' },
]

export default defineComponent({
  name: 'ReadTabLabel',
  props: {
    readActive: {
      type: Boolean,
      required: true,
    },
    section: {
      type: String as PropType<ReadSection>,
      required: true,
    },
    onSelectSection: {
      type: Function as PropType<(section: ReadSection) => void>,
      required: true,
    },
  },
  setup(props) {
    return () => (
      <SubmenuTabLabel
        label="漫畫閱讀"
        menuActive={props.readActive}
        activeItemKey={props.section}
        items={READ_ITEMS}
        onSelect={(key) => props.onSelectSection(key as ReadSection)}
      />
    )
  },
})
