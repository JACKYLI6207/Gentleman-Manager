import { defineComponent, PropType } from 'vue'
import { NPopover } from 'naive-ui'
import { listRankingScopes, SITE_CATEGORIES, type SiteCategoryItem } from '../categories.ts'
import styles from './CategoryNavBar.module.css'

export default defineComponent({
  name: 'CategoryNavBar',
  props: {
    activeLabel: {
      type: String,
      default: '',
    },
    onBrowseCategory: {
      type: Function as PropType<(cateId: number, label: string) => void>,
      required: true,
    },
    onBrowseList: {
      type: Function as PropType<(browse: 'home' | 'albums', label: string) => void>,
      required: true,
    },
    onBrowseRanking: {
      type: Function as PropType<(cateId: number | null, label: string) => void>,
      required: true,
    },
  },
  setup(props) {
    function fullLabel(item: SiteCategoryItem, parentLabel?: string) {
      return parentLabel !== undefined ? `${parentLabel} / ${item.label}` : item.label
    }

    function selectItem(item: SiteCategoryItem, parentLabel?: string) {
      if (item.browse === 'ranking') {
        props.onBrowseRanking(null, '排行')
        return
      }
      if (parentLabel === '排行') {
        props.onBrowseRanking(item.rankingCateId ?? null, item.label)
        return
      }
      const label = fullLabel(item, parentLabel)
      if (item.cateId !== undefined) {
        props.onBrowseCategory(item.cateId, label)
        return
      }
      if (item.browse === 'home' || item.browse === 'albums') {
        props.onBrowseList(item.browse, label)
      }
    }

    function isItemActive(item: SiteCategoryItem, parentLabel?: string) {
      const label = fullLabel(item, parentLabel)
      if (parentLabel === '排行') {
        return (
          props.activeLabel === item.label ||
          props.activeLabel === `排行 / ${item.label}` ||
          (item.label === '全部分類' && props.activeLabel === '排行')
        )
      }
      return props.activeLabel === label
    }

    function isParentActive(item: SiteCategoryItem) {
      if (item.browse === 'ranking') {
        return (
          props.activeLabel === '排行' ||
          props.activeLabel.startsWith('排行 / ') ||
          listRankingScopes().some((scope) => props.activeLabel === scope.label)
        )
      }
      return props.activeLabel === item.label || props.activeLabel.startsWith(`${item.label} / `)
    }

    function renderNavLink(item: SiteCategoryItem, parentLabel?: string, active?: boolean) {
      return (
        <button
          type="button"
          class={[styles.navLink, active && styles.navLinkActive]}
          onClick={() => selectItem(item, parentLabel)}>
          {item.label}
        </button>
      )
    }

    return () => (
      <div class={styles.categoryBar}>
        <ul class={styles.navList}>
          {SITE_CATEGORIES.map((item) => {
            const hasChildren = item.children !== undefined && item.children.length > 0

            if (!hasChildren) {
              return (
                <li key={item.label} class={[styles.navItem, isItemActive(item) && styles.active]}>
                  {renderNavLink(item, undefined, isItemActive(item))}
                </li>
              )
            }

            return (
              <li key={item.label} class={[styles.navItem, isParentActive(item) && styles.active]}>
                <NPopover
                  trigger="hover"
                  placement="bottom-start"
                  showArrow={false}
                  keepAliveOnHover
                  contentStyle={{ padding: 0 }}
                  style={{ display: 'block' }}>
                  {{
                    trigger: () => renderNavLink(item, undefined, isParentActive(item)),
                    default: () => (
                      <div class={styles.dropdownMenu}>
                        {item.children!.map((child) => (
                          <button
                            key={child.label}
                            type="button"
                            class={[styles.dropdownItem, isItemActive(child, item.label) && styles.dropdownItemActive]}
                            onClick={() => selectItem(child, item.label)}>
                            {child.label}
                          </button>
                        ))}
                      </div>
                    ),
                  }}
                </NPopover>
              </li>
            )
          })}
        </ul>
      </div>
    )
  },
})
