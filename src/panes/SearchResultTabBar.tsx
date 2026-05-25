import { defineComponent, PropType } from 'vue'
import { PhStar, PhX } from '@phosphor-icons/vue'
import type { SearchResultTabState } from './searchResultTabTypes.ts'
import styles from './SearchResultTabBar.module.css'

export default defineComponent({
  name: 'SearchResultTabBar',
  props: {
    tabs: {
      type: Array as PropType<SearchResultTabState[]>,
      required: true,
    },
    activeId: {
      type: String as PropType<string | null>,
      default: null,
    },
    isTabBookmarked: {
      type: Function as PropType<(tabId: string) => boolean>,
      required: true,
    },
  },
  emits: {
    select: (id: string) => true,
    close: (id: string) => true,
    toggleBookmark: (id: string) => true,
  },
  setup(props, { emit }) {
    return () => {
      if (props.tabs.length === 0) {
        return null
      }

      return (
        <div class={styles.tabBar} role="tablist">
          {props.tabs.map((tab) => {
            const active = tab.id === props.activeId
            const bookmarked = props.isTabBookmarked(tab.id)
            return (
              <div
                key={tab.id}
                class={[styles.tab, active && styles.tabActive]}
                role="tab"
                aria-selected={active}
                title={tab.title}
                onClick={() => emit('select', tab.id)}>
                <button
                  type="button"
                  class={[styles.tabStar, bookmarked && styles.tabStarActive]}
                  title={bookmarked ? '從收藏分頁移除' : '加入收藏分頁'}
                  onClick={(e: MouseEvent) => {
                    e.stopPropagation()
                    emit('toggleBookmark', tab.id)
                  }}>
                  <PhStar size={14} weight={bookmarked ? 'fill' : 'regular'} />
                </button>
                <span class={styles.tabTitle}>{tab.title}</span>
                <button
                  type="button"
                  class={styles.tabClose}
                  title="關閉分頁"
                  onClick={(e: MouseEvent) => {
                    e.stopPropagation()
                    emit('close', tab.id)
                  }}>
                  <PhX size={12} weight="bold" />
                </button>
              </div>
            )
          })}
        </div>
      )
    }
  },
})
