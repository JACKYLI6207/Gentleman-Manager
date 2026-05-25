import { NInput, NEl } from 'naive-ui'
import type { InputInst, InputProps } from 'naive-ui'
import { computed, ref, defineComponent, PropType } from 'vue'
import styles from './FloatLabelInput.module.css'

export default defineComponent({
  name: 'FloatLabelInput',
  props: {
    label: {
      type: String,
      required: true,
    },
    size: {
      type: String as () => InputProps['size'],
      default: 'medium',
    },
    type: {
      type: String as () => InputProps['type'],
      default: 'text',
    },
    clearable: {
      type: Boolean,
      default: false,
    },
    value: {
      type: String as PropType<InputProps['value']>,
      required: true,
    },
  },
  emits: { 'update:value': (_value: string) => true },
  setup(props, { emit }) {
    const NInputRef = ref<InputInst>()

    const showLabel = computed(() => props.value === '')

    const render = () => (
      <NInput
        class={styles.floatLabelInput}
        ref={NInputRef}
        size={props.size}
        type={props.type}
        clearable={props.clearable}
        placeholder=""
        value={props.value}
        onUpdateValue={(value) => emit('update:value', value)}>
        {{
          prefix: () =>
            showLabel.value ? (
              <NEl tag="span" class={styles.inlineLabel}>
                {props.label}
              </NEl>
            ) : null,
        }}
      </NInput>
    )

    return { NInputRef, render }
  },
  render() {
    return this.render()
  },
})
