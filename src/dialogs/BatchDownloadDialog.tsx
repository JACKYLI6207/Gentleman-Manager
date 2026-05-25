import { defineComponent, ref } from 'vue'
import { useMessage, NModal, NDialog, NInput } from 'naive-ui'
import { useStore } from '../store.ts'
import { commands } from '../bindings.ts'
import { extractComicId } from '../utils.ts'

export default defineComponent({
  name: 'BatchDownloadDialog',
  props: {
    showing: {
      type: Boolean,
      required: true,
    },
  },
  emits: {
    'update:showing': (_value: boolean) => true,
  },
  setup(props, { emit }) {
    const store = useStore()

    const message = useMessage()

    const inputString = ref<string>()

    async function confirm() {
      if (store.config === undefined) {
        return
      }

      const intervalMs = store.config.batchDownloadIntervalMs

      const lines = inputString.value?.split('\n')
      const comicIds = new Set(lines?.map(extractComicId).filter((comicId) => comicId !== undefined))
      if (comicIds.size === 0) {
        message.error('沒有解析出任何漫畫ID，請檢查格式是否正確')
        return
      }

      const progresses = Array.from(store.progresses.entries())
      const uncompletedProgresses = new Map(
        progresses.filter(
          ([, { state }]) => state === 'Pending' || state === 'Downloading' || state === 'Paused',
        ),
      )

      emit('update:showing', false)

      const current = ref<number>(0)
      const total = comicIds.size
      const batchMessage = message.loading(() => `正在批量創建下載任務(${current.value}/${total})`, { duration: 0 })

      for (const comicId of comicIds) {
        current.value++

        if (uncompletedProgresses.has(comicId)) {
          continue
        }

        const getComicResult = await commands.getComic(comicId)
        if (getComicResult.status === 'error') {
          console.error(getComicResult.error)
          continue
        }

        const comic = getComicResult.data
        if (comic.isDownloaded === true) {
          await new Promise((resolve) => setTimeout(resolve, intervalMs))
          continue
        }

        await commands.createDownloadTask(comic)

        await new Promise((resolve) => setTimeout(resolve, intervalMs))
      }

      batchMessage.type = 'success'
      batchMessage.content = `批量下載任務創建結束(${current.value}/${total})`
      setTimeout(() => batchMessage.destroy(), 3000)
    }

    return () => (
      <NModal show={props.showing} onUpdate:show={(value) => emit('update:showing', value)}>
        <NDialog
          showIcon={false}
          title="批量下載"
          positiveText="確定"
          onPositiveClick={confirm}
          onClose={() => emit('update:showing', false)}>
          <NInput
            value={inputString.value}
            onUpdate:value={(value) => (inputString.value = value)}
            type="textarea"
            placeholder="漫畫ID或鏈接，每行一個"
            autosize={{ minRows: 10, maxRows: 10 }}
          />
        </NDialog>
      </NModal>
    )
  },
})
