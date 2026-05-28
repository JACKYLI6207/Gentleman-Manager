import { reactive } from 'vue'

const PROGRESS_BY_FOLDER_KEY = 'gm-pc-local-read-folder-progress-v1'

export type SourceReadRecord = {
  opened: boolean
  /** 1-based 頁碼，與列表／閱讀器顯示一致（第 1054 頁就是 1054） */
  readPage: number
  totalPages: number
  /** v2：'1' = readPage 為 1-based；舊資料缺省視為 0-based 索引 */
  pageBasis?: '0' | '1'
  scrollY: number
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
    return { opened: false, readPage: 1, totalPages: 0, pageBasis: '1', scrollY: 0, offsetInPage: 0 }
  }

  const totalPages = Math.max(0, Number(rec.totalPages ?? 0))
  const pageBasis = rec.pageBasis === '1' ? '1' : '0'

  const hasSingleCheckpoint =
    rec.readPage !== undefined ||
    rec.scrollY !== undefined ||
    rec.scrollTop !== undefined

  let rawPage = 0
  if (hasSingleCheckpoint) {
    rawPage = Math.max(0, Number(rec.readPage ?? rec.pageIndex ?? 0))
  } else {
    const scrollPos = rec.scrollPos as Record<string, unknown> | undefined
    const dragPos = rec.dragPos as Record<string, unknown> | undefined
    const lastInput = rec.lastInput === 'drag' ? 'drag' : 'scroll'
    const branch = lastInput === 'drag' ? dragPos : scrollPos
    rawPage = Math.max(0, Number(branch?.pageIndex ?? rec.pageIndex ?? 0))
  }

  const readPageOneBased =
    pageBasis === '1'
      ? Math.max(1, rawPage)
      : Math.max(1, rawPage + 1)

  const readPage =
    totalPages > 0 ? Math.min(readPageOneBased, totalPages) : readPageOneBased

  return {
    opened: Boolean(rec.opened),
    readPage,
    totalPages,
    pageBasis: '1',
    scrollY: 0,
    offsetInPage: 0,
  }
}

export function getSourceRecord(path: string): SourceReadRecord {
  return normalizeRecord(folderSourceProgress[path] as Record<string, unknown> | undefined)
}

/** 已存 1-based 頁碼（第幾頁） */
export function getSavedReadPageOneBased(path: string): number {
  const rec = getSourceRecord(path)
  if (!rec.opened || rec.totalPages <= 0) return 1
  return Math.min(Math.max(1, rec.readPage), rec.totalPages)
}

export function markSourceOpened(path: string, totalPages: number) {
  const prev = getSourceRecord(path)
  folderSourceProgress[path] = {
    ...prev,
    opened: true,
    totalPages: totalPages > 0 ? totalPages : prev.totalPages,
    pageBasis: '1',
  }
  persistFolderSourceProgress()
}

/** 保存目前讀到第幾頁（1-based，與畫面顯示相同） */
export function saveSourceReadPage(path: string, readPageOneBased: number, totalPages: number) {
  if (!path) return
  const prev = getSourceRecord(path)
  const total = totalPages > 0 ? totalPages : prev.totalPages
  const page = total > 0 ? Math.min(Math.max(1, readPageOneBased), total) : Math.max(1, readPageOneBased)
  folderSourceProgress[path] = {
    opened: true,
    readPage: page,
    totalPages: total,
    pageBasis: '1',
    scrollY: 0,
    offsetInPage: 0,
  }
  persistFolderSourceProgress()
}

/** @deprecated 請改用 saveSourceReadPage（1-based 頁碼） */
export function saveSourceReadPosition(
  path: string,
  readPage: number,
  totalPages: number,
  _scrollY: number,
  _offsetInPage: number,
) {
  saveSourceReadPage(path, readPage, totalPages)
}

export function formatSourceProgressLabel(path: string): string | null {
  const rec = getSourceRecord(path)
  if (!rec.opened || rec.totalPages <= 0) return null
  return `${rec.readPage}/${rec.totalPages}頁`
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

export function cancelFolderListMode() {
  persistFolderSourceProgress()
  clearFolderSourceProgressMemory()
}
