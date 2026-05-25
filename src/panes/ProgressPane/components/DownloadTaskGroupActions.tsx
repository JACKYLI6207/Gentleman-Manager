import { defineComponent, type PropType } from 'vue'
import { commands } from '../../../bindings.ts'
import { PhCaretRight, PhPause, PhTrash } from '@phosphor-icons/vue'
import IconButton from '../../../components/IconButton.tsx'

export default defineComponent({
  name: 'DownloadTaskGroupActions',
  props: {
    comicIds: {
      type: Array as PropType<number[]>,
      required: true,
    },
  },
  setup(props) {
    async function resume() {
      for (const comicId of props.comicIds) {
        const result = await commands.resumeDownloadTask(comicId)
        if (result.status === 'error') {
          console.error(result.error)
        }
      }
    }

    async function pause() {
      for (const comicId of props.comicIds) {
        const result = await commands.pauseDownloadTask(comicId)
        if (result.status === 'error') {
          console.error(result.error)
        }
      }
    }

    async function cancel() {
      for (const comicId of props.comicIds) {
        const result = await commands.cancelDownloadTask(comicId)
        if (result.status === 'error') {
          console.error(result.error)
        }
      }
    }

    return () => (
      <div
        class="flex flex-row items-center gap-0.5 shrink-0 mr-1"
        onClick={(e: MouseEvent) => e.stopPropagation()}
        onDblclick={(e: MouseEvent) => e.stopPropagation()}>
        <IconButton title="全部繼續" onClick={resume}>
          <PhCaretRight size={18} />
        </IconButton>
        <IconButton title="全部暫停" onClick={pause}>
          <PhPause size={18} />
        </IconButton>
        <IconButton title="全部取消" onClick={cancel}>
          <PhTrash size={18} />
        </IconButton>
      </div>
    )
  },
})
