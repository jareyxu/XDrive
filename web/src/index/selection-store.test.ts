import { expect, test } from 'vitest'
import { SelectionStore } from './selection-store'
import type { DriveEntry } from '../api/client'
const entries: DriveEntry[] = ['a', 'b', 'c'].map(entryId => ({ entryId, kind: 'folder', name: `private-${entryId}`, childIndexId: `child-${entryId}` }))
const path = [{ indexId: 'ancestor', name: 'private-parent' }]
function create() { const store = new SelectionStore(); store.open(); return store }

test('navigation resets focus/anchor but preserves actual cross-directory selection snapshots', () => {
  const store = create(); store.focus('a'); store.select(entries, 'first', path, 'toggle', 'a')
  store.navigate()
  expect(store.store.getState().focusedId).toBe(''); expect(store.store.getState().anchor).toBeNull()
  store.select(entries, 'second', [], 'range', 'b')
  expect([...store.store.getState().selections.keys()]).toEqual(['a', 'b'])
  expect(store.store.getState().selections.get('a')).toEqual({ entry: entries[0], parentIndexId: 'first', parentPath: path })
  expect(store.store.getState().anchor).toEqual({ directoryId: 'second', entryId: 'b' })
  store.close()
})

test('ranges use the current order and select-all refreshes snapshots without changing the anchor', () => {
  const store = create(); store.select(entries, 'local', path, 'toggle', 'c')
  store.select([...entries].reverse(), 'local', path, 'range', 'a')
  expect([...store.store.getState().selections.keys()]).toEqual(['c', 'b', 'a'])
  const renamed = entries.map(entry => ({ ...entry, name: 'updated' }))
  store.select(renamed, 'local', [], 'all')
  expect(store.store.getState().selections.get('a')?.entry.name).toBe('updated')
  expect(store.store.getState().anchor?.entryId).toBe('c'); store.close()
})

test('checkbox writes never mutate old snapshots and clearing batch leaves focus intact', () => {
  const store = create(); store.focus('a')
  const first = store.store.getState().selections
  store.check({ entry: entries[0]!, parentIndexId: 'local', parentPath: path }, true)
  expect(first.size).toBe(0)
  const selected = store.store.getState().selections
  store.check({ entry: entries[0]!, parentIndexId: 'local' }, false)
  expect(selected.size).toBe(1); expect(store.store.getState().selections.size).toBe(0)
  store.clear(); expect(store.store.getState().focusedId).toBe('a'); expect(store.store.getState().anchor).toBeNull(); store.close()
})

test('close drops decrypted snapshots before subscribers run and rejects reentrant writes', () => {
  const store = create(); store.focus('a'); store.select(entries, 'local', path, 'toggle', 'a'); store.select(entries, 'local', path, 'all'); let notifications = 0
  store.store.subscribe(state => {
    notifications += 1; expect(state.selections.size).toBe(0); expect(state.anchor).toBeNull(); expect(state.focusedId).toBe('')
    store.check({ entry: entries[0]!, parentIndexId: 'local' }, true)
    store.select(entries, 'local', path, 'all'); store.focus('late'); store.close()
  })
  store.close(); store.close(); expect(notifications).toBe(1)
  expect(store.store.getState().selections.size).toBe(0)
})

test('completion consumes only still-owned snapshots and preserves fresh selections, focus and anchor', () => {
  const store = create(); store.select(entries, 'local', path, 'toggle', 'a')
  const confirmed = [...store.store.getState().selections.values()]
  const oldMap = store.store.getState().selections
  store.select(entries, 'other', [], 'toggle', 'b'); store.focus('b')
  store.complete(confirmed)
  expect([...store.store.getState().selections.keys()]).toEqual(['b'])
  expect(store.store.getState().anchor).toEqual({ directoryId: 'other', entryId: 'b' })
  expect(store.store.getState().focusedId).toBe('b'); expect(oldMap.has('a')).toBe(true)
  const completed = store.store.getState(); store.complete(confirmed)
  expect(store.store.getState()).toBe(completed); store.close()
})

test('reselection and refreshed select-all snapshots cannot be consumed by an older completion', () => {
  const store = create(); store.select(entries, 'local', path, 'all')
  const confirmed = [...store.store.getState().selections.values()]
  store.clear(); store.check({ entry: entries[0]!, parentIndexId: 'local', parentPath: path }, true)
  const reselected = store.store.getState(); store.complete(confirmed)
  expect(store.store.getState()).toBe(reselected)
  store.select(entries, 'local', path, 'all')
  const refreshed = store.store.getState(); store.complete(confirmed)
  expect(store.store.getState()).toBe(refreshed); store.close()
})

test('completion resets only a consumed anchor and is inert after close or a new unlock', () => {
  const store = create(); store.focus('a'); store.select(entries, 'local', path, 'toggle', 'a')
  const confirmed = [...store.store.getState().selections.values()]
  store.complete(confirmed)
  expect(store.store.getState().anchor).toBeNull(); expect(store.store.getState().focusedId).toBe('a')
  store.close(); const closed = store.store.getState(); store.complete(confirmed)
  expect(store.store.getState()).toBe(closed)
  store.open(); store.select(entries, 'local', path, 'toggle', 'a')
  const fresh = store.store.getState(); store.complete(confirmed)
  expect(store.store.getState()).toBe(fresh); store.close()
})

test('reopening after StrictMode-style cleanup starts empty and accepts new interaction', () => {
  const store = create(); store.select(entries, 'old', path, 'all'); store.close(); store.open()
  expect(store.store.getState().selections.size).toBe(0)
  store.select(entries, 'new', [], 'toggle', 'b')
  expect([...store.store.getState().selections.keys()]).toEqual(['b']); store.close()
})

test('each unlock is independent and exposes only subscription/read methods', () => {
  const first = create(), second = create(); first.select(entries, 'first', path, 'all'); second.select(entries, 'second', [], 'toggle', 'a')
  first.close(); expect(second.store.getState().selections.size).toBe(1)
  expect(Object.keys(second.store).sort()).toEqual(['getInitialState', 'getState', 'subscribe']); second.close()
})
