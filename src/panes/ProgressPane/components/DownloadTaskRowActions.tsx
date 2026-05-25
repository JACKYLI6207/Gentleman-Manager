import { defineComponent } from 'vue'
import { commands } from '../../../bindings.ts'
import { PhCaretRight, PhPause, PhTrash } from '@phosphor-icons/vue'
import IconButton from '../../../components/IconButton.tsx'

export default defineComponent({
  name: 'DownloadTaskRowActions',
  props: {
    comicId: {
      type: Number,
      required: true,
    },
  },
  setup(props) {
    async function resume() {
      const result = await commands.resumeDownloadTask(props.comicId)
      if (result.status === 'error') {
        console.error(result.error)
      }
    }

    async function pause() {
      const result = await commands.pauseDownloadTask(props.comicId)
      if (result.status === 'error') {
        console.error(result.error)
      }
    }

    async function cancel() {
      const result = await commands.cancelDownloadTask(props.comicId)
      if (result.status === 'error') {
        console.error(result.error)
      }
    }

    return () => (
      <div
        class="flex flex-row items-center gap-0.5 shrink-0 mr-1"
        onClick={(e: MouseEvent) => e.stopPropagation()}
        onDblclick={(e: MouseEvent) => e.stopPropagation()}>
        <IconButton title="繼續" onClick={resume}>
          <PhCaretRight size={18} />
        </IconButton>
        <IconButton title="暫停" onClick={pause}>
          <PhPause size={18} />
        </IconButton>
        <IconButton title="取消" onClick={cancel}>
          <PhTrash size={18} />
        </IconButton>
      </div>
    )
  },
})
