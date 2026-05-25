import { computed, defineComponent, onMounted, PropType } from 'vue'
import { useStore } from '../../../store.ts'
import { Comic, commands } from '../../../bindings.ts'
import { NCard, NCheckbox } from 'naive-ui'
import { path } from '@tauri-apps/api'
import { PhFolderOpen } from '@phosphor-icons/vue'
import IconButton from '../../../components/IconButton.tsx'

export default defineComponent({
  name: 'DownloadedComicCard',
  props: {
    comic: {
      type: Object as PropType<Comic>,
      required: true,
    },
    downloadPath: {
      type: String,
      required: false,
    },
    checked: {
      type: Boolean,
      default: false,
    },
    onCheckedChange: {
      type: Function as PropType<(checked: boolean) => void>,
      required: false,
    },
  },
  setup(props) {
    const store = useStore()

    const cover = computed<string | undefined>(() => store.covers.get(props.comic.id))

    onMounted(async () => {
      if (cover.value !== undefined) {
        return
      }

      await store.loadCover(props.comic.id, props.comic.cover)
    })

    async function pickComic() {
      store.pickedComic = props.comic
      store.currentTabName = 'comic'
    }

    async function showComicDirInFileManager() {
      if (store.config === undefined) {
        return
      }

      const targetPath =
        props.downloadPath ?? (await path.join(store.config.downloadDir, props.comic.title))

      const result = await commands.showPathInFileManager(targetPath)
      if (result.status === 'error') {
        console.error(result.error)
      }
    }

    return () => (
      <NCard hoverable content-style="padding: 0.25rem;">
        <div class="flex h-full items-start gap-2">
          {props.onCheckedChange !== undefined && (
            <NCheckbox
              class="mt-2 shrink-0"
              checked={props.checked}
              onUpdate:checked={(v) => props.onCheckedChange?.(v === true)}
            />
          )}
          <img
            class="w-24 object-contain mr-2 cursor-pointer transition-transform duration-200 hover:scale-106"
            src={cover.value}
            alt=""
            onClick={pickComic}
          />
          <div class="flex flex-col w-full min-w-0">
            <span
              class="font-bold text-lg line-clamp-3 cursor-pointer transition-colors duration-200 hover:text-blue-5"
              v-html={props.comic.title}
              onClick={pickComic}
            />
            <span>分類：{props.comic.category}</span>
            <span>頁數：{props.comic.imageCount}P</span>
            <div class="flex mt-auto gap-col-2">
              <IconButton title="開啟下載目錄" onClick={showComicDirInFileManager}>
                <PhFolderOpen size={24} />
              </IconButton>
            </div>
          </div>
        </div>
      </NCard>
    )
  },
})
