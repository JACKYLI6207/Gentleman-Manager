import { computed, defineComponent, onMounted, ref } from 'vue'
import { useStore } from '../store'
import { commands, events } from '../bindings'
import { MessageReactive, NButton, NPopconfirm, useMessage } from 'naive-ui'

export default defineComponent({
  name: 'DownloadShelfButton',
  props: {
    shelfId: {
      type: Number,
      required: true,
    },
  },
  setup(props) {
    const store = useStore()

    const message = useMessage()

    const popConfirmShowing = ref<boolean>(false)

    const rejectCooldown = ref<number>(0)
    const rejectButtonDisabled = computed(() => rejectCooldown.value > 0)

    const countdownInterval = ref<ReturnType<typeof setInterval>>(setInterval(() => {}, 1000))

    let downloadShelfMessage: MessageReactive | undefined

    onMounted(async () => {
      await events.downloadShelfEvent.listen(({ payload }) => {
        if (payload.event === 'GettingShelfComics') {
          downloadShelfMessage = message.loading('正在獲取書架中的漫畫', { duration: 0 })
        } else if (payload.event === 'CreatingDownloadTask' && downloadShelfMessage !== undefined) {
          const { current, total } = payload.data
          downloadShelfMessage.content = `正在創建下載任務(${current}/${total})`
        } else if (payload.event === 'End' && downloadShelfMessage !== undefined) {
          downloadShelfMessage.type = 'success'
          downloadShelfMessage.content = '為書架中的漫畫創建下載任務成功'
          setTimeout(() => {
            downloadShelfMessage?.destroy()
            downloadShelfMessage = undefined
          }, 3000)
        }
      })
    })

    async function agree() {
      if (store.config === undefined) {
        return
      }

      store.config.imgDownloadIntervalSec = Math.max(1, Math.floor(store.config.imgConcurrency / 5))
      store.config.comicDownloadIntervalSec = Math.min(10, Math.floor(store.config.imgConcurrency * 3))

      popConfirmShowing.value = false

      const result = await commands.downloadShelf(props.shelfId)
      if (result.status === 'error') {
        console.error(result.error)
        downloadShelfMessage?.destroy()
        return
      }
    }

    async function reject() {
      popConfirmShowing.value = false
      const result = await commands.downloadShelf(props.shelfId)
      if (result.status === 'error') {
        console.error(result.error)
        downloadShelfMessage?.destroy()
        return
      }
    }

    function handleDownloadClick() {
      // 清理可能存在的舊計時器
      if (countdownInterval.value) {
        clearInterval(countdownInterval.value)
      }
      rejectCooldown.value = 10

      countdownInterval.value = setInterval(() => {
        rejectCooldown.value -= 1
        if (rejectCooldown.value <= 0) {
          clearInterval(countdownInterval.value)
        }
      }, 1000)
    }

    return () => (
      <NPopconfirm
        positiveText={null}
        negativeText={null}
        show={popConfirmShowing.value}
        onUpdate:show={(value) => (popConfirmShowing.value = value)}>
        {{
          default: () => (
            <div class="flex flex-col">
              <div>下載整個書架是個大任務</div>
              <div>為了減輕紳士漫畫服務器壓力</div>
              <div>將自動調整設定中的下載間隔</div>
              <div>
                <span>之後你隨時可以在右上角的</span>
                <span class="bg-[rgba(255,255,255,0.12)] px-1 rounded">設定</span>
                <span>調整</span>
              </div>
            </div>
          ),
          action: () => (
            <>
              <NButton size="small" disabled={rejectButtonDisabled.value} onClick={reject}>
                {rejectButtonDisabled.value && <span>不調整直接下載 ({rejectCooldown.value})</span>}
                {!rejectButtonDisabled.value && <span>不調整直接下載</span>}
              </NButton>
              <NButton size="small" type="primary" onClick={agree}>
                調整並下載
              </NButton>
            </>
          ),
          trigger: () => (
            <NButton type="primary" size="small" onClick={handleDownloadClick}>
              下載整個書架
            </NButton>
          ),
        }}
      </NPopconfirm>
    )
  },
})
