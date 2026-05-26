import { defineComponent, onMounted, ref } from 'vue'
import { useStore } from '../../store.ts'
import { commands, events } from '../../bindings.ts'
import { open } from '@tauri-apps/plugin-dialog'
import { NButton, NIcon, NInput, NInputGroup, NInputGroupLabel, NTabPane, NTabs } from 'naive-ui'
import UncompletedProgresses from './components/UncompletedProgresses.tsx'
import CompletedProgress from './components/CompletedProgress.tsx'
import FailedProgress from './components/FailedProgress.tsx'
import styles from './ProgressPane.module.css'
import { PhFolder, PhFolderOpen, PhGearSix, PhSidebarSimple } from '@phosphor-icons/vue'

export default defineComponent({
  name: 'ProgressPane',
  props: {
    onOpenSettings: {
      type: Function as () => () => void,
      required: true,
    },
    onToggleRightPane: {
      type: Function as () => () => void,
      required: true,
    },
  },
  setup(props) {
    const store = useStore()

    const downloadSpeed = ref<string>('')

    type TabName = 'uncompleted' | 'completed' | 'failed'
    const tabName = ref<TabName>('uncompleted')

    onMounted(async () => {
      await events.downloadSpeedEvent.listen(async ({ payload: { speed } }) => {
        downloadSpeed.value = speed
      })
    })

    async function selectDownloadDir() {
      if (store.config === undefined) {
        return
      }

      const selectedDirPath = await open({ directory: true })
      if (selectedDirPath === null) {
        return
      }
      store.config.downloadDir = selectedDirPath
    }

    async function showDownloadDirInFileManager() {
      if (store.config === undefined) {
        return
      }

      const result = await commands.showPathInFileManager(store.config.downloadDir)
      if (result.status === 'error') {
        console.error(result.error)
      }
    }

    return () => (
      <div class="flex flex-col flex-1 min-h-0 overflow-hidden">
        <div class="flex box-border px-2 pt-2">
          <NInputGroup>
            <NInputGroupLabel size="small">下載目錄</NInputGroupLabel>
            <NInput
              size="small"
              clearable
              placeholder="點擊輸入或貼上路徑"
              value={store.config?.downloadDir ?? ''}
              onUpdate:value={(value) => {
                if (store.config) {
                  store.config.downloadDir = value
                }
              }}
            />
            <NButton class="w-10" size="small" title="選擇目錄" onClick={selectDownloadDir}>
              {{
                icon: () => (
                  <NIcon size={20}>
                    <PhFolder />
                  </NIcon>
                ),
              }}
            </NButton>
            <NButton class="w-10" size="small" title="開啟目錄" onClick={showDownloadDirInFileManager}>
              {{
                icon: () => (
                  <NIcon size={20}>
                    <PhFolderOpen />
                  </NIcon>
                ),
              }}
            </NButton>
            <NButton class="w-10" size="small" title="設定" onClick={props.onOpenSettings}>
              {{
                icon: () => (
                  <NIcon size={20}>
                    <PhGearSix />
                  </NIcon>
                ),
              }}
            </NButton>
            <NButton class="w-10" size="small" title="隱藏下載列表" onClick={props.onToggleRightPane}>
              {{
                icon: () => (
                  <NIcon size={20}>
                    <PhSidebarSimple />
                  </NIcon>
                ),
              }}
            </NButton>
          </NInputGroup>
        </div>
        <NTabs
          size="small"
          type="line"
          value={tabName.value}
          onUpdate:value={(value) => (tabName.value = value as TabName)}
          class={[`${styles.progressesTabs}`, 'flex-1 overflow-hidden pt-2']}>
          {{
            default: () => (
              <>
                <NTabPane
                  class="h-full p-0! overflow-hidden"
                  name="uncompleted"
                  tab="下載佇列"
                  display-directive="show">
                  <UncompletedProgresses />
                </NTabPane>
                <NTabPane class="h-full p-0! overflow-hidden" name="failed" tab="下載失敗" display-directive="show">
                  <FailedProgress />
                </NTabPane>
                <NTabPane class="h-full p-0! overflow-hidden" name="completed" tab="下載完成" display-directive="show">
                  <CompletedProgress />
                </NTabPane>
              </>
            ),
            suffix: () => <span class="whitespace-nowrap text-ellipsis overflow-hidden">{downloadSpeed.value}</span>,
          }}
        </NTabs>
      </div>
    )
  },
})
