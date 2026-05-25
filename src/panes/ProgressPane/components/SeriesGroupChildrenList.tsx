import { defineComponent } from 'vue'
import styles from './UncompletedProgresses.module.css'
import { useNestedScrollContainerWheelFix } from './useNestedScrollContainerWheelFix.ts'

export default defineComponent({
  name: 'SeriesGroupChildrenList',
  props: {
    indented: {
      type: Boolean,
      default: true,
    },
  },
  setup(props, { slots }) {
    const { scrollEl } = useNestedScrollContainerWheelFix()

    return () => (
      <div
        ref={scrollEl}
        class={[
          styles.seriesGroupChildren,
          props.indented ? styles.seriesGroupChildrenIndented : undefined,
        ]}>
        {slots.default?.()}
      </div>
    )
  },
})
