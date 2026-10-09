/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, test, vi } from 'vitest'
import { effectiveBackupReminderDays, backupIsOverdue, type Preferences } from './preferences'
const script = readFileSync(new URL('../../public/theme-init.js', import.meta.url), 'utf8')
function boot(raw: string | null = null, denied = false) {
  const queries = new Map<string, { matches: boolean; change?: () => void }>()
  const dataset: Record<string, string> = {}
  const properties: Record<string, string> = {}
  const events = new Map<string, (event: { key: string | null; newValue: string | null }) => void>()
  let stored = raw
  const window = { addEventListener: (name: string, listener: (event: { key: string | null; newValue: string | null }) => void) => events.set(name, listener) } as unknown as Window
  runInNewContext(script, {
    window, document: { documentElement: { dataset, style: { setProperty: (key: string, value: string) => { properties[key] = value } } } },
    localStorage: { getItem: () => { if (denied) throw new Error('blocked'); return stored }, setItem: (_: string, value: string) => { if (denied) throw new Error('blocked'); stored = value } },
    matchMedia: (name: string) => { const query = { matches: false, addEventListener: (_: string, listener: () => void) => { query.change = listener }, change: undefined as (() => void) | undefined }; queries.set(name, query); return query },
  })
  return { store: window.xdrivePreferences, dataset, properties, events, queries, saved: () => stored }
}
test('actual head script applies safe defaults before React, with a stable snapshot', () => {
  const state = boot()
  expect(state.dataset).toEqual({ theme: 'light', reduceTransparency: 'false' })
  expect(state.properties['--glass-clarity']).toBe('0.5')
  expect(state.store.getSnapshot()).toBe(state.store.getSnapshot())
  expect(state.store.getSnapshot().backupReminderDays).toBe(30)
})
test.each(['invalid json', '[]', 'null', JSON.stringify({ theme: 'bad', clarity: 2, reduceTransparency: 'true', backupReminderDays: 0 }), ' '.repeat(4097)])('corrupt or excessive preference input never applies unsafe values', raw => {
  const state = boot(raw)
  expect(state.store.getSnapshot()).toMatchObject({ theme: 'system', clarity: 0.5, reduceTransparency: false, backupReminderDays: 30 })
})
test('only whitelisted non-sensitive fields persist; subscribers and cross-tab invalidation work', () => {
  const state = boot(); const notify = vi.fn(); const stop = state.store.subscribe(notify)
  state.store.set({ theme: 'dark', clarity: 1, vaultKey: 'must-not-persist', fileName: 'private' } as Partial<Preferences>)
  expect(Object.keys(JSON.parse(state.saved()!))).toEqual(['theme', 'clarity', 'reduceTransparency', 'backupReminderDays', 'view', 'uploadConcurrency'])
  expect(state.saved()).not.toMatch(/must-not-persist|private/u)
  expect(state.dataset.theme).toBe('dark'); expect(notify).toHaveBeenCalledTimes(1)
  state.events.get('storage')!({ key: 'other-sensitive-key', newValue: null }); expect(notify).toHaveBeenCalledTimes(1)
  state.events.get('storage')!({ key: 'xdrive.preferences.v1', newValue: JSON.stringify({ theme: 'light', backupReminderDays: 7 }) })
  expect(state.dataset.theme).toBe('light'); expect(state.store.getSnapshot().backupReminderDays).toBe(7)
  stop(); state.events.get('storage')!({ key: null, newValue: null }); expect(notify).toHaveBeenCalledTimes(2)
})
test('system theme follows media changes; explicit theme wins and system transparency always wins', () => {
  const state = boot(); const dark = state.queries.get('(prefers-color-scheme: dark)')!
  dark.matches = true; dark.change!(); expect(state.dataset.theme).toBe('dark')
  state.store.set({ theme: 'light' }); dark.change!(); expect(state.dataset.theme).toBe('light')
  const reduce = state.queries.get('(prefers-reduced-transparency: reduce)')!
  reduce.matches = true; reduce.change!(); state.store.set({ reduceTransparency: false })
  expect(state.dataset.reduceTransparency).toBe('true')
})
test('blocked storage still applies in-memory preferences and exposes persistence failure', () => {
  const state = boot(null, true); state.store.set({ theme: 'dark', reduceTransparency: true })
  expect(state.dataset).toEqual({ theme: 'dark', reduceTransparency: 'true' })
  expect(state.store.getSnapshot().persistenceAvailable).toBe(false)
})

test('backup threshold changes actual overdue status and uses milliseconds, including exact boundary', () => {
 const day = 86400000, now = 50 * day
 expect(backupIsOverdue(null, now, 30)).toBe(true)
 expect(backupIsOverdue(now - 8 * day, now, 7)).toBe(true)
 expect(backupIsOverdue(now - 8 * day, now, 30)).toBe(false)
 expect(backupIsOverdue(now - 7 * day, now, 7)).toBe(false)
 expect(backupIsOverdue(now - 7 * day - 1, now, 7)).toBe(true)
})

test.each([0, 1, 5, 2.5, '4', null])('invalid upload concurrency %s is rejected before scheduling', value => {
 const state = boot(JSON.stringify({ uploadConcurrency: value }))
 expect(state.store.getSnapshot().uploadConcurrency).toBe(2)
})

test('grid is the default and only grid/list view preferences persist', () => {
 const state = boot(); expect(state.store.getSnapshot().view).toBe('grid')
 state.store.set({ view: 'list' }); expect(JSON.parse(state.saved()!).view).toBe('list')
 expect(boot(JSON.stringify({ view: 'invalid' })).store.getSnapshot().view).toBe('grid')
})

test('server backup warning cannot be deferred by browser preferences; a shorter browser threshold still applies', () => {
 expect(effectiveBackupReminderDays(2,90)).toBe(2)
 expect(effectiveBackupReminderDays(30,7)).toBe(7)
 expect(effectiveBackupReminderDays(3650,365)).toBe(365)
 expect(backupIsOverdue(0, 2*86400000, effectiveBackupReminderDays(2,90))).toBe(false)
 expect(backupIsOverdue(0, 2*86400000+1, effectiveBackupReminderDays(2,90))).toBe(true)
 for (const value of [0,-1,1.5,3651,NaN]) expect(() => effectiveBackupReminderDays(value,30)).toThrow()
})
