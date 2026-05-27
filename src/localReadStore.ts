import { reactive } from 'vue'

const PROGRESS_BY_FOLDER_KEY = 'gm-pc-local-read-folder-progress-v1'

export type SourceReadRecord = {
  opened: boolean
  readPage: number
  totalPages: number
  /** 捲動容器 scrollTop（上方頁面皆載入後才準確） */
  scrollY: number
  /** 當前頁內向下偏移，用於長圖頁面高度載入後還原 */
  offsetInPage: number
}

export const folderSourceProgress = reactive<Record<string, SourceReadRecord>>({})

let currentFolderPath = ''

function readAllFolderProgress(): Record<string, Record<string, SourceReadRecord>> {
  try {
    const raw = localStorage.getItem(PROGRESS_BY_FOLDER_KEY)
    return raw ? (JSON.parse(raw) as Record<string, Record<string, SourceReadRecord>>) : {}
  } catch {
    return {}
  }
}

function writeAllFolderProgress(data: Record<string, Record<string, SourceReadRecord>>) {
  try {
    localStorage.setItem(PROGRESS_BY_FOLDER_KEY, JSON.stringify(data))
  } catch {
    /* 容量不足時略過 */
  }
}

function normalizeRecord(rec: Record<string, unknown> | undefined): SourceReadRecord {
  if (!rec) {
    return { opened: false, readPage: 0, totalPages: 0, scrollY: 0, offsetInPage: 0 }
  }

  const hasSingleCheckpoint =
    rec.readPage !== undefined ||
    rec.scrollY !== undefined ||
    rec.scrollTop !== undefined

  if (hasSingleCheckpoint) {
    return {
      opened: Boolean(rec.opened),
      readPage: Math.max(0, Number(rec.readPage ?? rec.pageIndex ?? 0)),
      totalPages: Math.max(0, Number(rec.totalPages ?? 0)),
      scrollY: Math.max(0, Number(rec.scrollY ?? rec.scrollTop ?? 0)),
      offsetInPage: Math.max(0, Number(rec.offsetInPage ?? 0)),
    }
  }

  const scrollPos = rec.scrollPos as Record<string, unknown> | undefined
  const dragPos = rec.dragPos as Record<string, unknown> | undefined
  const lastInput = rec.lastInput === 'drag' ? 'drag' : 'scroll'
  const branch = lastInput === 'drag' ? dragPos : scrollPos

  return {
    opened: Boolean(rec.opened),
    readPage: Math.max(0, Number(branch?.pageIndex ?? rec.pageIndex ?? 0)),
    totalPages: Math.max(0, Number(rec.totalPages ?? 0)),
    scrollY: Math.max(0, Number(branch?.scrollTop ?? rec.scrollTop ?? 0)),
    offsetInPage: 0,
  }
}

export function getSourceRecord(path: string): SourceReadRecord {
  return normalizeRecord(folderSourceProgress[path] as Record<string, unknown> | undefined)
}

export function markSourceOpened(path: string, totalPages: number) {
  const prev = getSourceRecord(path)
  folderSourceProgress[path] = {
    ...prev,
    opened: true,
    totalPages: totalPages > 0 ? totalPages : prev.totalPages,
  }
  persistFolderSourceProgress()
}

export function saveSourceReadPosition(
  path: string,
  readPage: number,
  totalPages: number,
  scrollY: number,
  offsetInPage: number,
) {
  if (!path) return
  const prev = getSourceRecord(path)
  folderSourceProgress[path] = {
    opened: true,
    readPage: Math.max(0, readPage),
    totalPages: totalPages > 0 ? totalPages : prev.totalPages,
    scrollY: Math.max(0, scrollY),
    offsetInPage: Math.max(0, offsetInPage),
  }
  persistFolderSourceProgress()
}

export function formatSourceProgressLabel(path: string): string | null {
  const rec = getSourceRecord(path)
  if (!rec.opened || rec.totalPages <= 0) return null
  const page = Math.min(rec.readPage + 1, rec.totalPages)
  return `${page}/${rec.totalPages}頁`
}

export function setCurrentFolderPath(folderPath: string) {
  currentFolderPath = folderPath
}

export function loadFolderSourceProgress(folderPath: string) {
  currentFolderPath = folderPath
  for (const key of Object.keys(folderSourceProgress)) {
    delete folderSourceProgress[key]
  }
  const all = readAllFolderProgress()
  const data = all[folderPath]
  if (!data) return
  for (const [path, rec] of Object.entries(data)) {
    folderSourceProgress[path] = normalizeRecord(rec as unknown as Record<string, unknown>)
  }
}

export function persistFolderSourceProgress() {
  if (!currentFolderPath) return
  const all = readAllFolderProgress()
  all[currentFolderPath] = { ...folderSourceProgress }
  writeAllFolderProgress(all)
}

export function clearFolderSourceProgressMemory() {
  for (const key of Object.keys(folderSourceProgress)) {
    delete folderSourceProgress[key]
  }
  currentFolderPath = ''
}

/** 取消 ZIP 列表時保留已存進度，僅清記憶體 */
export function cancelFolderListMode() {
  persistFolderSourceProgress()
  clearFolderSourceProgressMemory()
}
