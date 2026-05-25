import { computed, defineComponent, onMounted, PropType, watch } from 'vue'
import { useStore } from '../store.ts'
import { commands, Shelf, Tag } from '../bindings.ts'
import { path } from '@tauri-apps/api'
import { NButton, NCard, NPopover } from 'naive-ui'
import DownloadButton from './DownloadButton.tsx'
import styles from './ComicCard.module.css'
import IconButton from './IconButton.tsx'
import { PhFolderOpen, PhStar } from '@phosphor-icons/vue'
import { formatSearchPhotoInfo } from '../utils.ts'

export default defineComponent({
  name: 'ComicCard',
  props: {
    comicId: {
      type: Number,
      required: true,
    },
    comicTitle: {
      type: String,
      required: true,
    },
    comicTitleHtml: {
      type: String,
      required: false,
    },
    comicCover: {
      type: String,
      required: true,
    },
    comicAdditionalInfo: {
      type: String,
      required: false,
    },
    comicDownloaded: {
      type: Boolean,
      required: true,
    },
    shelf: {
      type: Object as PropType<Shelf>,
      required: false,
    },
    comicFavoriteTime: {
      type: String,
      required: false,
    },
    getShelf: {
      type: Function as PropType<(shelfId: number, pageNum: number) => Promise<void>>,
      required: false,
    },
    idleDownloadLabel: {
      type: String,
      required: false,
    },
    enableCoverLoad: {
      type: Boolean,
      default: true,
    },
    showDetailButton: {
      type: Boolean,
      default: false,
    },
    showReadButton: {
      type: Boolean,
      default: false,
    },
    showTags: {
      type: Boolean,
      default: false,
    },
    enableTagLoad: {
      type: Boolean,
      default: true,
    },
    searchByTag: {
      type: Function as PropType<(tagName: string, page: number) => Promise<void>>,
      required: false,
    },
    layout: {
      type: String as PropType<'list' | 'grid'>,
      default: 'list',
    },
    showFavoriteButton: {
      type: Boolean,
      default: false,
    },
    favorited: {
      type: Boolean,
      default: false,
    },
    onToggleFavorite: {
      type: Function as PropType<() => void>,
      required: false,
    },
    catalogAnalysisNote: {
      type: String,
      required: false,
    },
  },
  setup(props) {
    const store = useStore()

    const cover = computed<string | undefined>(() => store.covers.get(props.comicId))

    const tags = computed<Tag[] | undefined>(() => store.comicTags.get(props.comicId))

    async function tryLoadCover() {
      if (!props.enableCoverLoad || cover.value !== undefined) {
        return
      }
      const url = props.comicCover.trim()
      if (url === '') {
        return
      }
      await store.loadCover(props.comicId, url)
    }

    async function tryLoadTags() {
      if (!props.showTags || !props.enableTagLoad || tags.value !== undefined) {
        return
      }
      await store.loadComicTags(props.comicId)
    }

    onMounted(() => {
      void tryLoadCover()
      void tryLoadTags()
    })

    watch(
      () => props.enableCoverLoad,
      (enabled) => {
        if (enabled) {
          void tryLoadCover()
        }
      },
    )

    watch(cover, (val, prev) => {
      if (val === undefined && prev !== undefined && props.enableCoverLoad) {
        void tryLoadCover()
      }
    })

    watch(
      () => props.comicCover,
      () => {
        if (props.enableCoverLoad) {
          void tryLoadCover()
        }
      },
    )

    watch(
      () => props.enableTagLoad,
      (enabled) => {
        if (enabled) {
          void tryLoadTags()
        }
      },
    )

    // 獲取漫畫資訊，將漫畫資訊存入pickedComic，並切換到漫畫詳情
    async function pickComic() {
      const result = await commands.getComic(props.comicId)
      if (result.status === 'error') {
        console.error(result.error)
        return
      }

      store.pickedComic = result.data
      const nextTags = new Map(store.comicTags)
      nextTags.set(props.comicId, result.data.tags)
      store.comicTags = nextTags
      store.currentTabName = 'comic'
    }

    async function showComicDirInFileManager() {
      if (store.config === undefined) {
        return
      }

      const savedPath = store.progresses.get(props.comicId)?.downloadPath
      const targetPath = savedPath ?? (await path.join(store.config.downloadDir, props.comicTitle))

      const result = await commands.showPathInFileManager(targetPath)
      if (result.status === 'error') {
        console.error(result.error)
      }
    }

    async function startReading(e: MouseEvent) {
      e.stopPropagation()
      await store.prepareAndStartReading(props.comicId)
    }

    function renderTitle(className: string, onClick: () => void, slotClass?: string) {
      const title = (
        <NPopover trigger="hover" placement="bottom-start" showArrow={false} style={{ display: 'block' }}>
          {{
            trigger: () => (
              <span
                class={`${className} cursor-pointer`}
                v-html={props.comicTitleHtml ?? props.comicTitle}
                onClick={onClick}
              />
            ),
            default: () => <div class={styles.titlePopover}>{props.comicTitle}</div>,
          }}
        </NPopover>
      )
      if (slotClass !== undefined) {
        return <div class={slotClass}>{title}</div>
      }
      return title
    }

    function formatTagLabel(name: string) {
      if (name.length <= 3) {
        return name
      }
      return `${name.slice(0, 3)}...`
    }

    function renderTagButton(tag: Tag) {
      return (
        <NButton
          key={tag.url}
          round
          size="tiny"
          class={[styles.tagButton, 'hover:scale-110 transition-transform duration-100']}
          title={tag.name}
          onClick={(e: MouseEvent) => {
            e.stopPropagation()
            if (props.searchByTag !== undefined) {
              void props.searchByTag(tag.name, 1)
            }
          }}>
          {formatTagLabel(tag.name)}
        </NButton>
      )
    }

    const catalogAnalysisSection = () => {
      if (props.catalogAnalysisNote === undefined) {
        return null
      }
      const isDuplicate = props.catalogAnalysisNote.startsWith('與列表中')
      return (
        <div
          class={[
            styles.catalogAnalysisNote,
            isDuplicate ? styles.catalogAnalysisDuplicate : styles.catalogAnalysisClear,
          ]}
          title={props.catalogAnalysisNote}>
          {props.catalogAnalysisNote}
        </div>
      )
    }

    const tagsSection = () => {
      if (!props.showTags) {
        return null
      }
      const tagList = tags.value
      const visibleTags = tagList !== undefined ? tagList.slice(0, 3) : []
      const hiddenTags = tagList !== undefined ? tagList.slice(3) : []
      return (
        <div class={styles.tagsBlock}>
          <div class="font-bold text-sm">標籤</div>
          {tagList === undefined ? (
            props.showTags ? (
              <span class="text-xs opacity-50">載入中...</span>
            ) : null
          ) : tagList.length === 0 ? (
            props.enableTagLoad || props.showTags ? (
              <span class="text-xs opacity-50">無標籤</span>
            ) : null
          ) : (
            <div class={styles.tagsRow}>
              {visibleTags.map((tag) => renderTagButton(tag))}
              {hiddenTags.length > 0 && (
                <NPopover
                  trigger="hover"
                  placement="bottom-start"
                  showArrow={false}
                  keepAliveOnHover
                  contentStyle={{ padding: '4px' }}>
                  {{
                    trigger: () => (
                      <NButton
                        round
                        size="tiny"
                        class={styles.moreTagsButton}
                        onClick={(e: MouseEvent) => e.stopPropagation()}>
                        查看更多
                      </NButton>
                    ),
                    default: () => (
                      <div class={styles.moreTagsMenu}>{hiddenTags.map((tag) => renderTagButton(tag))}</div>
                    ),
                  }}
                </NPopover>
              )}
            </div>
          )}
        </div>
      )
    }

    const cardFooter = () => (
      <div class={styles.cardFooter}>
        {tagsSection()}
        <div class={styles.cardActions}>{actionRow()}</div>
      </div>
    )

    function renderFavoriteButton() {
      if (!props.showFavoriteButton) {
        return null
      }
      return (
        <button
          type="button"
          class={[styles.favoriteButton, props.favorited && styles.favoriteButtonActive]}
          title={props.favorited ? '從我的收藏移除' : '加入我的收藏'}
          onClick={(e: MouseEvent) => {
            e.stopPropagation()
            props.onToggleFavorite?.()
          }}>
          <PhStar size={20} weight={props.favorited ? 'fill' : 'regular'} />
        </button>
      )
    }

    const actionRow = () => {
      const gridButtonSize = props.layout === 'grid' ? 'tiny' : 'small'
      return (
        <>
          {props.showDetailButton && (
            <NButton
              size={gridButtonSize}
              type="primary"
              class={[styles.detailButton, props.layout === 'grid' && styles.gridCompactButton]}
              onClick={(e: MouseEvent) => {
                e.stopPropagation()
                void pickComic()
              }}>
              詳情
            </NButton>
          )}
          {props.showReadButton && (
            <NButton
              size={gridButtonSize}
              type="primary"
              class={[styles.detailButton, props.layout === 'grid' && styles.gridCompactButton]}
              onClick={(e: MouseEvent) => void startReading(e)}>
              閱讀
            </NButton>
          )}
          {props.comicDownloaded && props.layout === 'list' && (
            <IconButton title="開啟下載目錄" onClick={showComicDirInFileManager}>
              <PhFolderOpen size={24} />
            </IconButton>
          )}
          <DownloadButton
            class={
              [
                styles.cardActionButton,
                props.showReadButton ? styles.detailButton : '',
                props.layout === 'grid' ? styles.gridCompactButton : '',
                props.layout === 'list' && !props.showReadButton ? 'ml-auto' : '',
              ]
                .filter(Boolean)
                .join(' ') || undefined
            }
            size={props.layout === 'grid' ? 'tiny' : props.showReadButton ? 'small' : 'medium'}
            type="primary"
            comicId={props.comicId}
            comicDownloaded={props.comicDownloaded}
            idleLabel={props.idleDownloadLabel ?? '一鍵下載'}
          />
        </>
      )
    }

    function renderCoverImage(grid: boolean) {
      if (cover.value === undefined) {
        return <div class={grid ? styles.coverPlaceholder : styles.coverPlaceholderList} aria-hidden />
      }
      return (
        <img
          class={
            grid
              ? `${styles.gridCover} cursor-pointer`
              : 'w-full object-contain cursor-pointer transition-transform duration-200 hover:scale-106'
          }
          src={cover.value}
          alt=""
          referrerpolicy="no-referrer"
          onClick={pickComic}
        />
      )
    }

    return () =>
      props.layout === 'grid' ? (
        <NCard hoverable class={`${styles.comicCard} ${styles.comicCardGrid}`} content-style="padding: 0;">
          <div class="flex flex-col h-full">
            <div class={styles.coverWrap}>
              {renderFavoriteButton()}
              {renderCoverImage(true)}
            </div>
            <div class={styles.gridBody}>
              {renderTitle(styles.gridTitle, () => void pickComic(), styles.gridTitleSlot)}
              {props.comicAdditionalInfo && (
                <span class={`${styles.gridInfo} text-gray`}>
                  {formatSearchPhotoInfo(props.comicAdditionalInfo)}
                </span>
              )}
              {catalogAnalysisSection()}
              <div class={styles.gridTagsArea}>{tagsSection()}</div>
              <div class={styles.gridActions}>{actionRow()}</div>
            </div>
          </div>
        </NCard>
      ) : (
        <NCard hoverable class={`${styles.comicCard}`} content-style="padding: 0.25rem;">
          <div class="flex h-full">
            <div class={styles.coverWrapList}>
              {renderFavoriteButton()}
              {renderCoverImage(false)}
            </div>
            <div class="flex flex-col w-full flex-1 min-h-0">
              {renderTitle(`${styles.listTitle} transition-colors duration-200 hover:text-blue-5`, () =>
                void pickComic(),
              )}
              {props.comicAdditionalInfo && (
                <span class="text-gray whitespace-pre-wrap">{props.comicAdditionalInfo}</span>
              )}
              {catalogAnalysisSection()}
              {props.comicFavoriteTime && <span>收藏時間：{props.comicFavoriteTime}</span>}
              {props.shelf && props.getShelf && (
                <div>
                  <span>所屬書架：</span>
                  {props.shelf.name !== '' && (
                    <NButton
                      size="tiny"
                      onClick={async () => {
                        if (props.shelf !== undefined && props.getShelf !== undefined) {
                          await props.getShelf(props.shelf.id, 1)
                        }
                      }}>
                      {props.shelf.name}
                    </NButton>
                  )}
                </div>
              )}
              {cardFooter()}
            </div>
          </div>
        </NCard>
      )
  },
})
