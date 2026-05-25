import { defineComponent, PropType } from 'vue'
import { NPopover } from 'naive-ui'
import navStyles from './CategoryNavBar.module.css'
import styles from './SubmenuTabLabel.module.css'

export interface SubmenuTabItem {
  key: string
  label: string
}

export default defineComponent({
  name: 'SubmenuTabLabel',
  props: {
    label: {
      type: String,
      required: true,
    },
    menuActive: {
      type: Boolean,
      required: true,
    },
    activeItemKey: {
      type: String,
      required: true,
    },
    items: {
      type: Array as PropType<SubmenuTabItem[]>,
      required: true,
    },
    onSelect: {
      type: Function as PropType<(key: string) => void>,
      required: true,
    },
  },
  setup(props) {
    return () => (
      <NPopover
        trigger="hover"
        placement="bottom-start"
        showArrow={false}
        keepAliveOnHover
        contentStyle={{ padding: 0 }}
        style={{ display: 'block' }}>
        {{
          trigger: () => (
            <span class={[styles.tabTrigger, props.menuActive && styles.tabTriggerActive]}>
              {props.label}
            </span>
          ),
          default: () => (
            <div class={navStyles.dropdownMenu}>
              {props.items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  class={[
                    navStyles.dropdownItem,
                    props.menuActive &&
                      props.activeItemKey === item.key &&
                      navStyles.dropdownItemActive,
                  ]}
                  onClick={() => props.onSelect(item.key)}>
                  {item.label}
                </button>
              ))}
            </div>
          ),
        }}
      </NPopover>
    )
  },
})
