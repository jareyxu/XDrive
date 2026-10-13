import { useSyncExternalStore } from 'react'

export interface Preferences {
  readonly view: 'grid' | 'list'
  readonly theme: 'system' | 'light' | 'dark'
  readonly clarity: number
  readonly reduceTransparency: boolean
  readonly backupReminderDays: number
  readonly uploadConcurrency: number
  readonly downloadConcurrency?: number
  readonly downloadMemoryMiB?: number
  readonly autoTransfer?: boolean
}
interface Snapshot extends Preferences { readonly persistenceAvailable: boolean }
interface PreferenceStore {
  getSnapshot(): Snapshot
  subscribe(listener: () => void): () => void
  set(change: Partial<Preferences>): void
}
declare global { interface Window { xdrivePreferences: PreferenceStore } }
export function usePreferences(): Snapshot {
  return useSyncExternalStore(window.xdrivePreferences.subscribe, window.xdrivePreferences.getSnapshot)
}
export function setPreferences(change: Partial<Preferences>): void { window.xdrivePreferences.set(change) }

export function backupIsOverdue(lastBackupAt: number | null, now: number, days: number): boolean {
  return lastBackupAt === null || now - lastBackupAt > days * 86400000
}

export function currentTransferPreferences() {
  const saved = typeof window !== 'undefined' ? window.xdrivePreferences?.getSnapshot() : undefined
  return {
    uploadConcurrency: saved?.uploadConcurrency ?? 4,
    downloadConcurrency: saved?.downloadConcurrency ?? 4,
    downloadMemoryMiB: saved?.downloadMemoryMiB ?? 64,
    autoTransfer: saved?.autoTransfer ?? true,
  }
}
export function currentUploadConcurrency(): number { return currentTransferPreferences().uploadConcurrency }

/** A browser may remind sooner, but cannot defer the server's warning policy. */
export function effectiveBackupReminderDays(serverDays: number, browserDays: number): number {
  if (!Number.isSafeInteger(serverDays) || serverDays < 1 || serverDays > 3650 || !Number.isSafeInteger(browserDays) || browserDays < 1 || browserDays > 365) throw new RangeError('Invalid backup reminder policy')
  return Math.min(serverDays, browserDays)
}
