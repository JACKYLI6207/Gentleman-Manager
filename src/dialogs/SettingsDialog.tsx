import { defineComponent, onMounted, ref } from 'vue'
import { useStore } from '../store.ts'
import {
  NButton,
  NInputNumber,
  NModal,
  NDialog,
  NTooltip,
  NInputGroup,
  NInputGroupLabel,
  NRadio,
  NRadioButton,
  NRadioGroup,
  NInput,
  NCheckbox,
} from 'naive-ui'
import { openUrl } from '@tauri-apps/plugin-opener'
import { open } from '@tauri-apps/plugin-dialog'

export default defineComponent({
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

    const proxyHost = ref<string>('')
    const customApiDomain = ref<string>('')

    onMounted(() => {
      if (store.config !== undefined) {
        proxyHost.value = store.config.proxyHost
        customApiDomain.value = store.config.customApiDomain
      }
    })

    async function pickKoreanTxtCatalogFiles() {
      if (store.config === undefined) {
        return
      }
      const selected = await open({
        multiple: true,
        filters: [{ name: 'TXT 收藏列表', extensions: ['txt'] }],
      })
      if (selected === null) {
        return
      }
      const paths = Array.isArray(selected) ? selected : [selected]
      if (paths.length === 0) {
        return
      }
      store.config.koreanTxtCatalogDir = paths.join('|')
    }

    return () => (
      <NModal show={props.showing} onUpdate:show={(value) => emit('update:showing', value)}>
        <NDialog class="w-140!" showIcon={false} title="設定" onClose={() => emit('update:showing', false)}>
          <div class="flex flex-col">
            <span class="font-bold">下載格式</span>
            <NRadioGroup
              class="mt-1"
              value={store.config?.downloadFormat ?? 'Server2Zip'}
              onUpdate:value={(value) => {
                if (store.config !== undefined && (value === 'JpegZipPack' || value === 'Server2Zip')) {
                  store.config.downloadFormat = value
                }
              }}>
              <div class="flex flex-col gap-2">
                <NTooltip placement="top" trigger="hover">
                  {{
                    trigger: () => (
                      <NRadio value="Server2Zip">透過 SERVER2 線路下載 ZIP</NRadio>
                    ),
                    default: () => (
                      <>
                        <div>從官網下載整包 ZIP（Server 2 直鏈）</div>
                        <div>檔名與官網一致，直接存於下載目錄</div>
                      </>
                    ),
                  }}
                </NTooltip>
                <NTooltip placement="top" trigger="hover">
                  {{
                    trigger: () => (
                      <NRadio value="JpegZipPack">JPEG 逐張下載並打包成 ZIP</NRadio>
                    ),
                    default: () => (
                      <>
                        <div>逐張下載為 JPEG，完成後打包成 ZIP</div>
                        <div>ZIP 檔名為該漫畫在網頁上的標題</div>
                      </>
                    ),
                  }}
                </NTooltip>
              </div>
            </NRadioGroup>

            <span class="font-bold mt-2">API域名</span>
            <NRadioGroup
              size="small"
              value={store.config?.apiDomainMode}
              onUpdate:value={(value) => {
                if (store.config !== undefined) {
                  store.config.apiDomainMode = value
                }
              }}>
              <NRadioButton value="Default">默認</NRadioButton>
              <NRadioButton value="Custom">自定義</NRadioButton>
            </NRadioGroup>
            {store.config?.apiDomainMode === 'Custom' && (
              <NInputGroup class="mt-1">
                <NInputGroupLabel size="small">自定義API域名</NInputGroupLabel>
                <NInput
                  size="small"
                  placeholder=""
                  value={customApiDomain.value}
                  onUpdate:value={(value) => {
                    if (store.config !== undefined) {
                      customApiDomain.value = value
                    }
                  }}
                  onBlur={() => {
                    if (store.config !== undefined) {
                      store.config.customApiDomain = customApiDomain.value
                    }
                  }}
                  onKeydown={(e: KeyboardEvent) => {
                    if (e.key === 'Enter' && store.config !== undefined) {
                      store.config.customApiDomain = customApiDomain.value
                    }
                  }}
                />
                <NButton size="small" onClick={() => openUrl('https://wn01.link/')}>
                  開啟發布頁
                </NButton>
              </NInputGroup>
            )}

            <span class="font-bold mt-2">韓漫 TXT 重複檢查</span>
            <NCheckbox
              checked={store.config?.koreanTxtDuplicateCheckEnabled ?? true}
              onUpdate:checked={(checked) => {
                if (store.config !== undefined) {
                  store.config.koreanTxtDuplicateCheckEnabled = checked === true
                }
              }}>
              開啟韓漫下載模式時自動比對 TXT 列表
            </NCheckbox>
            <NInput
              class="mt-1"
              size="small"
              readonly
              placeholder="尚未選擇 TXT 檔案"
              value={store.config?.koreanTxtCatalogDir ?? ''}
            />
            <div class="flex flex-wrap gap-1 mt-1">
              <NButton size="small" type="primary" onClick={() => void pickKoreanTxtCatalogFiles()}>
                選擇 TXT 檔案
              </NButton>
              <NButton
                size="small"
                disabled={(store.config?.koreanTxtCatalogDir?.length ?? 0) === 0}
                onClick={() => {
                  if (store.config !== undefined) {
                    store.config.koreanTxtCatalogDir = ''
                  }
                }}>
                清除
              </NButton>
            </div>

            <span class="font-bold mt-2">下載失敗重試</span>
            <NInputGroup>
              <NInputGroupLabel size="small">失敗後最多再試</NInputGroupLabel>
              <NInputNumber
                class="w-full"
                size="small"
                value={store.config?.downloadRetryCount}
                onUpdate:value={(value) => {
                  if (store.config && value !== null) {
                    store.config.downloadRetryCount = value
                  }
                }}
                min={0}
                max={20}
                parse={(x: string) => Number(x)}
              />
              <NInputGroupLabel size="small">次（共嘗試 N+1 次）</NInputGroupLabel>
            </NInputGroup>

            <span class="font-bold mt-2">下載速度</span>
            <div class="text-xs opacity-70 mb-1">
              同一時間僅一本漫畫實際下載；休息時間在該本完成後、下一本開始前生效
            </div>
            <NInputGroup>
              <NInputGroupLabel size="small">每本漫畫下載完成後休息</NInputGroupLabel>
              <NInputNumber
                class="w-full"
                size="small"
                value={store.config?.comicDownloadIntervalSec}
                onUpdate:value={(value) => {
                  if (store.config && value !== null) {
                    store.config.comicDownloadIntervalSec = value
                  }
                }}
                min={0}
                parse={(x: string) => Number(x)}
              />
              <NInputGroupLabel size="small">秒</NInputGroupLabel>
            </NInputGroup>

            <span class="font-bold mt-2">代理類型</span>
            <NRadioGroup
              size="small"
              value={store.config?.proxyMode}
              onUpdate:value={(value) => {
                if (store.config !== undefined) {
                  store.config.proxyMode = value
                }
              }}>
              <NRadioButton value="System">系統代理</NRadioButton>
              <NRadioButton value="NoProxy">直連</NRadioButton>
              <NRadioButton value="Custom">自定義</NRadioButton>
            </NRadioGroup>
            {store.config?.proxyMode === 'Custom' && (
              <NInputGroup class="mt-1">
                <NInputGroupLabel size="small">http://</NInputGroupLabel>
                <NInput
                  size="small"
                  placeholder=""
                  value={proxyHost.value}
                  onUpdate:value={(value) => (proxyHost.value = value)}
                  onBlur={() => {
                    if (store.config !== undefined) {
                      store.config.proxyHost = proxyHost.value
                    }
                  }}
                  onKeydown={(e: KeyboardEvent) => {
                    if (e.key === 'Enter' && store.config !== undefined) {
                      store.config.proxyHost = proxyHost.value
                    }
                  }}
                />
                <NInputGroupLabel size="small">:</NInputGroupLabel>
                <NInputNumber
                  size="small"
                  placeholder=""
                  value={store.config?.proxyPort}
                  onUpdate:value={(value) => {
                    if (store.config !== undefined && value !== null) {
                      store.config.proxyPort = value
                    }
                  }}
                  parse={(x: string) => parseInt(x)}
                />
              </NInputGroup>
            )}
          </div>

        </NDialog>
      </NModal>
    )
  },
})
