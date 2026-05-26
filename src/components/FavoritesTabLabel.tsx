import { defineComponent, PropType } from 'vue'
import type { FavoritesSection } from '../types.ts'
import SubmenuTabLabel from './SubmenuTabLabel.tsx'

const FAVORITES_ITEMS = [
  { key: 'comics' as const, label: '收藏漫畫' },
  { key: 'tabs' as const, label: '收藏分頁' },
  { key: 'scanCaches' as const, label: '收藏快照' },
]

export default defineComponent({
  name: 'FavoritesTabLabel',
  props: {
    favoritesActive: {
      type: Boolean,
      required: true,
    },
    section: {
      type: String as PropType<FavoritesSection>,
      required: true,
    },
    onSelectSection: {
      type: Function as PropType<(section: FavoritesSection) => void>,
      required: true,
    },
  },
  setup(props) {
    return () => (
      <SubmenuTabLabel
        label="我的收藏"
        menuActive={props.favoritesActive}
        activeItemKey={props.section}
        items={FAVORITES_ITEMS}
        onSelect={(key) => props.onSelectSection(key as FavoritesSection)}
      />
    )
  },
})
