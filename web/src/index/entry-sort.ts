import type { DriveEntry } from '../api/client'
export type SortBy = 'name' | 'modified' | 'size' | 'type'
export function sortEntries(entries: readonly DriveEntry[], by: SortBy, descending: boolean): DriveEntry[] {
  const names = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'variant' })
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1
    let order = 0
    if (by === 'name') order = names.compare(left.name, right.name)
    if (by === 'type') order = names.compare(left.mime ?? 'folder', right.mime ?? 'folder')
    if (by === 'size') order = (left.size ?? 0) - (right.size ?? 0)
    if (by === 'modified') {
      // Older indexes have no timestamp: display unknown and keep them last,
      // rather than inventing an original modification date.
      if (left.originalModifiedAt === undefined || right.originalModifiedAt === undefined) {
        if (left.originalModifiedAt !== right.originalModifiedAt) return left.originalModifiedAt === undefined ? 1 : -1
      } else order = left.originalModifiedAt - right.originalModifiedAt
    }
    return (descending ? -order : order) || names.compare(left.name, right.name) || left.entryId.localeCompare(right.entryId)
  })
}
export function splitFileExtension(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? { stem: name.slice(0, dot), extension: name.slice(dot) } : { stem: name, extension: '' }
}

const modifiedAtFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit',
})

export function formatEntryModifiedAt(timestamp?: number): string {
  if (timestamp === undefined || !Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 8_640_000_000_000_000) return '未知'
  return modifiedAtFormatter.format(new Date(timestamp))
}

export function gridKeyboardTarget(key: string, index: number, count: number, columns: number, rowsPerPage: number): number | null {
  const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns, PageUp: -columns * rowsPerPage, PageDown: columns * rowsPerPage }
  if (!count) return null
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  if (!(key in offsets)) return null
  return Math.max(0, Math.min(count - 1, index + offsets[key]!))
}
