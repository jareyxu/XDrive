import type { DriveEntry } from '../api/client'
import type { ZipSelection } from './zip-selection'
export interface SelectionAnchor { readonly directoryId: string; readonly entryId: string }
export function updateEntrySelection(current: ReadonlyMap<string, ZipSelection>, entries: readonly DriveEntry[], directoryId: string, parentPath: ZipSelection['parentPath'], mode: 'toggle' | 'range' | 'all', targetId?: string, anchor?: SelectionAnchor | null): ReadonlyMap<string, ZipSelection> {
 const next = new Map(current)
 const target = entries.findIndex(entry => entry.entryId === targetId)
 if (mode !== 'all' && target < 0) return current
 const add = (entry: DriveEntry) => next.set(entry.entryId, { entry, parentIndexId: directoryId, parentPath })
 if (mode === 'all') { for (const entry of entries) add(entry); return next }
 if (mode === 'toggle') { const entry = entries[target]!; if (next.has(entry.entryId)) next.delete(entry.entryId); else add(entry); return next }
 const start = anchor?.directoryId === directoryId ? entries.findIndex(entry => entry.entryId === anchor.entryId) : -1
 for (let index = Math.min(start < 0 ? target : start, target); index <= Math.max(start < 0 ? target : start, target); index++) add(entries[index]!)
 return next
}
