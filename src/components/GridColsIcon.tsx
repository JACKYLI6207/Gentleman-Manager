import { defineComponent } from 'vue'

/** 一排 N 格的小圖示，用於網格欄數切換按鈕 */
export default defineComponent({
  name: 'GridColsIcon',
  props: {
    cols: {
      type: Number,
      required: true,
    },
  },
  setup(props) {
    return () => {
      const n = props.cols
      const size = 18
      const gap = 1.5
      const cell = (size - gap * (n - 1)) / n
      return (
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} class="block">
          {Array.from({ length: n }, (_, i) => (
            <rect
              key={i}
              x={i * (cell + gap)}
              y={(size - cell) / 2}
              width={cell}
              height={cell}
              rx={0.75}
              fill="currentColor"
            />
          ))}
        </svg>
      )
    }
  },
})
