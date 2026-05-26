import { DownloadTaskEvent } from './bindings.ts'

export type CurrentTabName = 'search' | 'comic' | 'read' | 'favorites'

export type FavoritesSection = 'comics' | 'tabs' | 'scanCaches'

export type ReadSection = 'online' | 'local'

export type ProgressData = DownloadTaskEvent & { percentage: number; indicator: string }
