import { computed, defineComponent, PropType } from 'vue'
import { NButton, ButtonProps } from 'naive-ui'
import { useStore } from '../store.ts'
import { ProgressData } from '../types.ts'
import { commands } from '../bindings.ts'
import { comicQueueStub } from '../utils/comicQueueStub.ts'

export default defineComponent({
  name: 'DownloadButton',
  props: {
    class: {
      type: String,
      default: '',
    },
    type: {
      type: String as PropType<ButtonProps['type']>,
      default: 'default',
    },
    size: {
      type: String as PropType<ButtonProps['size']>,
      default: 'medium',
    },
    comicId: {
      type: Number,
      required: true,
    },
    comicDownloaded: {
      type: Boolean,
      required: true,
    },
    idleLabel: {
      type: String,
      default: '一鍵下載',
    },
  },
  setup(props) {
    const store = useStore()

    const comicProgress = computed<ProgressData | undefined>(() => {
      return store.progresses.get(props.comicId)
    })

    const buttonDisabled = computed<boolean>(() => {
      const state = comicProgress.value?.state
      return state === 'Downloading' || state === 'Pending'
    })

    const buttonIndicator = computed<string>(() => {
      if (comicProgress.value === undefined) {
        return props.comicDownloaded ? '重新下載' : props.idleLabel
      }

      const state = comicProgress.value.state

      if (state === 'Downloading' || state === 'Pending') {
        return comicProgress.value.indicator
      } else if (state === 'Paused') {
        return '繼續下載'
      } else {
        return '重新下載'
      }
    })

    function parseImageCount(additionalInfo: string): number {
      const match = additionalInfo.match(/(\d+)\s*張/)
      if (match === null) {
        return 0
      }
      const value = parseInt(match[1], 10)
      return Number.isNaN(value) ? 0 : value
    }

    function resolveQueueStub() {
      if (store.pickedComic?.id === props.comicId) {
        return comicQueueStub(props.comicId, store.pickedComic.title, store.pickedComic.imageCount)
      }
      const inSearch = store.searchResult?.comics.find((item) => item.id === props.comicId)
      if (inSearch !== undefined) {
        return comicQueueStub(props.comicId, inSearch.title, parseImageCount(inSearch.additionalInfo))
      }
      return comicQueueStub(props.comicId, `漫畫 #${props.comicId}`, 0)
    }

    async function handleButtonClick() {
      const state = comicProgress.value?.state
      if (state === 'Downloading' || state === 'Pending') {
        return
      } else if (state === 'Paused') {
        const result = await commands.resumeDownloadTask(props.comicId)
        if (result.status === 'error') {
          console.error(result.error)
        }
      } else {
        await commands.createDownloadTask(resolveQueueStub())
      }
    }

    return () => (
      <NButton
        class={props.class}
        type={props.type}
        size={props.size}
        onClick={handleButtonClick}
        disabled={buttonDisabled.value}>
        {buttonIndicator.value}
      </NButton>
    )
  },
})
