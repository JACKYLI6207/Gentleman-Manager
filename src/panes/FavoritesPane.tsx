import { defineComponent, type PropType } from 'vue'
import FavoriteComicsPane from './FavoriteComicsPane.tsx'
import FavoriteTabsPane from './FavoriteTabsPane.tsx'
import type { SearchTabBookmark } from './searchTabBookmarkTypes.ts'
import type { FavoritesSection } from '../types.ts'

export default defineComponent({
  name: 'FavoritesPane',
  props: {
    section: {
      type: String as PropType<FavoritesSection>,
      required: true,
    },
    searchByTag: {
      type: Function as PropType<(tagName: string, page: number) => Promise<void>>,
      required: true,
    },
    onOpenBookmarkedTab: {
      type: Function as PropType<(bookmark: SearchTabBookmark) => void>,
      required: true,
    },
  },
  setup(props) {
    return () => (
      <div class="h-full flex flex-col min-h-0">
        {props.section === 'comics' ? (
          <FavoriteComicsPane searchByTag={props.searchByTag} />
        ) : (
          <FavoriteTabsPane onOpenBookmark={props.onOpenBookmarkedTab} />
        )}
      </div>
    )
  },
})
