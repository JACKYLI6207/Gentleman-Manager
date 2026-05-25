import { ref } from 'vue'

/** 韓漫批次區塊手風琴：同一列表內一次只展開一個。 */
export function useSeriesGroupAccordion() {
  const expandedDir = ref<string | null>(null)

  function isSeriesGroupExpanded(seriesParentDir: string): boolean {
    return expandedDir.value === seriesParentDir
  }

  function toggleSeriesGroup(seriesParentDir: string) {
    expandedDir.value = expandedDir.value === seriesParentDir ? null : seriesParentDir
  }

  return { expandedDir, isSeriesGroupExpanded, toggleSeriesGroup }
}
