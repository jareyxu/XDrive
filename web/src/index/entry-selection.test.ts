import { expect, test } from 'vitest'
import { updateEntrySelection } from './entry-selection'
import type { DriveEntry } from '../api/client'
const entries: DriveEntry[] = Array.from({ length: 5 }, (_, i) => ({ entryId: String(i), kind: 'folder', name: String(i), childIndexId: `child-${i}` }))
const elsewhere = new Map([['other', { entry: { entryId: 'other', kind: 'folder' as const, name: 'private' }, parentIndexId: 'remote' }]])
test('toggle is immutable and preserves selections in other directories', () => {
 const next = updateEntrySelection(elsewhere, entries, 'local', [], 'toggle', '1')
 expect([...next.keys()]).toEqual(['other', '1']); expect([...elsewhere.keys()]).toEqual(['other'])
 expect([...updateEntrySelection(next, entries, 'local', [], 'toggle', '1').keys()]).toEqual(['other'])
})
test('ranges use current sort order and an opaque local anchor, including reverse range', () => {
 expect([...updateEntrySelection(elsewhere, entries, 'local', [], 'range', '1', { directoryId: 'local', entryId: '4' }).keys()]).toEqual(['other', '1', '2', '3', '4'])
 expect([...updateEntrySelection(elsewhere, [...entries].reverse(), 'local', [], 'range', '1', { directoryId: 'local', entryId: '4' }).keys()]).toEqual(['other', '4', '3', '2', '1'])
})
test('a removed/foreign anchor selects only target and never expands into another directory', () => {
 for (const anchor of [null, { directoryId: 'remote', entryId: '0' }, { directoryId: 'local', entryId: 'removed' }]) expect([...updateEntrySelection(elsewhere, entries, 'local', [], 'range', '2', anchor).keys()]).toEqual(['other', '2'])
 expect(updateEntrySelection(elsewhere, entries, 'local', [], 'toggle', 'missing')).toBe(elsewhere)
})
test('select all includes unmounted entries and refreshes snapshots without touching other directories', () => {
 const entries5000 = Array.from({ length: 5000 }, (_, i) => ({ ...entries[0]!, entryId: String(i) }))
 const next = updateEntrySelection(elsewhere, entries5000, 'local', [{ indexId: 'parent', name: 'path' }], 'all')
 expect(next.size).toBe(5001); expect(next.get('4999')!.parentIndexId).toBe('local'); expect(next.get('other')).toBe(elsewhere.get('other'))
})
