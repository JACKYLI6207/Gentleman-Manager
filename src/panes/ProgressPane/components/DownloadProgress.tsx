import type { DownloadTaskState } from '../../../bindings.ts'
import { NProgress, type ProgressProps } from 'naive-ui'

export function DownloadProgress({
  percentage,
  state,
  title,
  indicator,
  hasProgress,
  class: className,
  subtitle,
}: {
  percentage: number
  state: DownloadTaskState
  title: string
  indicator: string
  hasProgress: boolean
  class?: string
  subtitle?: string
}) {
  const started = hasProgress && !isNaN(percentage)
  const colorClass = stateToColorClass(state)

  return (
    <div class={className}>
      <div class="text-ellipsis whitespace-nowrap overflow-hidden font-bold" title={title}>
        {title}
      </div>
      {subtitle !== undefined && (
        <div class="text-xs text-gray-400 truncate" title={subtitle}>
          {subtitle}
        </div>
      )}
      <div class="flex">
        {!started && <div class="text-sm">{indicator}</div>}
        {started && (
          <NProgress
            class={[colorClass, 'w-full']}
            status={stateToStatus(state)}
            percentage={isNaN(percentage) ? undefined : percentage}
            processing={state === 'Downloading'}>
            {indicator}
          </NProgress>
        )}
      </div>
    </div>
  )
}

function stateToStatus(state: DownloadTaskState): ProgressProps['status'] {
  if (state === 'Completed') {
    return 'success'
  } else if (state === 'Paused') {
    return 'warning'
  } else if (state === 'Failed') {
    return 'error'
  } else {
    return 'default'
  }
}

export function stateToColorClass(state: DownloadTaskState) {
  if (state === 'Downloading') {
    return 'text-blue-500'
  } else if (state === 'Pending') {
    return 'text-gray-500'
  } else if (state === 'Paused') {
    return 'text-yellow-500'
  } else if (state === 'Failed') {
    return 'text-red-500'
  } else if (state === 'Completed') {
    return 'text-green-500'
  } else if (state === 'Cancelled') {
    return 'text-stone-500'
  }

  return ''
}
