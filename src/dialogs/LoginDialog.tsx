import { defineComponent, ref } from 'vue'
import { useMessage, NModal, NDialog } from 'naive-ui'
import { useStore } from '../store.ts'
import { commands } from '../bindings.ts'
import FloatLabelInput from '../components/FloatLabelInput.tsx'

export default defineComponent({
  name: 'LoginDialog',
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

    const username = ref<string>('')
    const password = ref<string>('')

    async function login() {
      if (store.config === undefined) {
        return
      }
      if (username.value === '') {
        message.error('請輸入用戶名')
        return
      }
      if (password.value === '') {
        message.error('請輸入密碼')
        return
      }
      const result = await commands.login(username.value, password.value)
      if (result.status === 'error') {
        console.error(result.error)
        return
      }
      message.success('登入成功')
      store.config.cookie = result.data
      emit('update:showing', false)
    }

    function handleKeydown(e: KeyboardEvent) {
      if (e.key === 'Enter') {
        login()
      }
    }

    return () => (
      <NModal show={props.showing} onUpdate:show={(value) => emit('update:showing', value)}>
        <NDialog
          showIcon={false}
          title="帳號登入"
          positiveText="登入"
          onPositiveClick={login}
          onClose={() => emit('update:showing', false)}
          {...{ onKeydown: handleKeydown }}>
          <div class="flex flex-col gap-2">
            <FloatLabelInput
              label="用戶名"
              value={username.value}
              onUpdate:value={(value) => (username.value = value)}
            />
            <FloatLabelInput
              label="密碼"
              value={password.value}
              onUpdate:value={(value) => (password.value = value)}
              type="password"
            />
          </div>
        </NDialog>
      </NModal>
    )
  },
})
