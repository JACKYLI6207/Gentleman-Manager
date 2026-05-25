import { computed, defineComponent, PropType } from 'vue'
import { NModal, NDialog, useMessage } from 'naive-ui'
import { useStore } from '../store.ts'
import { ComicInSearch } from '../bindings.ts'

export default defineComponent({
  name: 'DownloadAllConfirmDialog',
  props: {
    showing: {
      type: Boolean,
      required: true,
    },
    comics: {
      type: Array as PropType<ComicInSearch[]>,
      required: true,
    },
  },
  emits: {
    'update:showing': (_value: boolean) => true,
    confirm: (_comics: ComicInSearch[]) => true,
  },
  setup(props, { emit }) {
    const store = useStore()
    const message = useMessage()

    const uncompletedIds = computed(() => {
      return new Set(
        Array.from(store.progresses.entries())
          .filter(
            ([, { state }]) =>
              state === 'Pending' || state === 'Downloading' || state === 'Paused',
          )
          .map(([id]) => id),
      )
    })

    const toQueue = computed(() =>
      props.comics.filter(
        (comic) => !uncompletedIds.value.has(comic.id) && comic.isDownloaded !== true,
      ),
    )

    const skipped = computed(() =>
      props.comics.filter(
        (comic) => uncompletedIds.value.has(comic.id) || comic.isDownloaded === true,
      ),
    )

    function skipReason(comic: ComicInSearch): string {
      if (uncompletedIds.value.has(comic.id)) {
        return '已在下載佇列'
      }
      if (comic.isDownloaded === true) {
        return '已下載'
      }
      return ''
    }

    function onConfirm() {
      if (toQueue.value.length === 0) {
        message.warning('沒有可加入下載佇列的漫畫')
        return false
      }
      emit('confirm', toQueue.value)
      emit('update:showing', false)
      return true
    }

    return () => (
      <NModal show={props.showing} onUpdate:show={(v) => emit('update:showing', v)}>
        <NDialog
          showIcon={false}
          title="全部下載(本頁)確認"
          style={{ width: '32rem', maxWidth: '92vw' }}
          contentStyle={{ overflow: 'auto', maxHeight: '70vh' }}
          positiveText="確定"
          negativeText="取消"
          onPositiveClick={onConfirm}
          onClose={() => emit('update:showing', false)}>
          <div class="flex flex-col gap-3">
            <div class="text-sm opacity-80 leading-relaxed">
              本頁共 {props.comics.length} 本，將加入下載佇列 {toQueue.value.length} 本
              {skipped.value.length > 0 ? `（略過 ${skipped.value.length} 本）` : ''}
            </div>
            {toQueue.value.length === 0 ? (
              <span class="text-sm opacity-60">沒有可加入下載佇列的漫畫</span>
            ) : (
              <div class="py-2 px-3 max-h-64 overflow-y-auto border border-[var(--n-border-color)] rounded">
                {toQueue.value.map((comic, index) => (
                  <div
                    key={comic.id}
                    class="flex items-start gap-2 py-0.5"
                    title={comic.title}>
                    <span class="shrink-0 min-w-[2.75rem] text-right tabular-nums opacity-70 text-sm">
                      {index + 1}.
                    </span>
                    <span class="flex-1 min-w-0 text-sm leading-relaxed break-words">
                      {comic.title}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {skipped.value.length > 0 && (
              <div class="flex flex-col gap-1.5">
                <span class="text-xs opacity-60">以下項目將略過：</span>
                <div class="pl-1 max-h-32 overflow-y-auto space-y-1 opacity-60">
                  {skipped.value.map((comic) => (
                    <div
                      key={comic.id}
                      class="flex items-start gap-2 text-xs leading-relaxed break-words"
                      title={comic.title}>
                      <span class="shrink-0 opacity-70">·</span>
                      <span class="flex-1 min-w-0">
                        {comic.title}（{skipReason(comic)}）
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </NDialog>
      </NModal>
    )
  },
})
