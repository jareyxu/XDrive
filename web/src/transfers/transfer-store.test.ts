import { afterEach, expect, test, vi } from 'vitest'
import { TransferStore } from './transfer-store'
import type { ActiveTransfer } from './transfer-types'

const stores: TransferStore[] = []
afterEach(() => { stores.forEach(store => store.close()); stores.length = 0; vi.useRealTimers() })
function create(schedule?: (callback: () => void) => () => void) {
  const store = new TransferStore(schedule); stores.push(store); store.open(); return store
}
const task = (id = 'task', name = 'private-name.txt'): ActiveTransfer => ({ id, name, kind: 'upload', phase: 'preparing', completedBytes: 0, totalBytes: 17 })

test('progress is observable and completion cannot be changed by late producer callbacks', () => {
  const store = create(), controller = new AbortController(), changes: string[] = []
  store.store.subscribe(state => { changes.push(state.tasks[0]?.phase ?? 'empty') })
  expect(store.begin(task(), controller)).toBe(true)
  expect(store.update('task', controller, { phase: 'uploading', completedBytes: 8 })).toBe(true)
  expect(store.finish('task', controller, 'completed')).toBe(true)
  expect(store.update('task', controller, { phase: 'uploading', completedBytes: 9 })).toBe(false)
  expect(store.finish('task', controller, 'failed', 'late error')).toBe(false)
  expect(store.cancel('task')).toBe(false)
  expect(controller.signal.aborted).toBe(false)
  expect(store.store.getState().tasks[0]).toMatchObject({ phase: 'completed', completedBytes: 8 })
  expect(changes).toEqual(['preparing', 'uploading', 'completed'])
})

test('close drops names and rejects reentrant publication before abort listeners run', () => {
  const store = create(), first = new AbortController(), second = new AbortController()
  store.begin(task('first'), first); store.begin(task('second'), second)
  let checked = false
  first.signal.addEventListener('abort', () => {
    expect(store.store.getState().tasks).toEqual([])
    expect(store.begin(task('late'), new AbortController())).toBe(false)
    expect(store.finish('first', first, 'cancelled')).toBe(false)
    checked = true
  })
  store.close()
  expect(checked).toBe(true); expect(second.signal.aborted).toBe(true)
  expect(store.store.getState().tasks).toEqual([])
})

test('cancel aborts the real controller but waits for the producer outcome', () => {
  const store = create(), controller = new AbortController()
  store.begin(task(), controller); expect(store.cancel('task')).toBe(true)
  expect(controller.signal.aborted).toBe(true)
  expect(store.store.getState().tasks[0].phase).toBe('preparing')
  expect(store.update('task', controller, { phase: 'uploading' })).toBe(false)
  expect(store.finish('task', controller, 'cancelled')).toBe(true)
  expect(store.store.getState().tasks[0].phase).toBe('cancelled')
})

test('same ID replacement fences old updates, finishes and even a cancelled timer callback', () => {
  const callbacks: (() => void)[] = [], cancellations: number[] = []
  const store = create(callback => { const index = callbacks.push(callback) - 1; return () => { cancellations.push(index) } })
  const old = new AbortController(), current = new AbortController()
  store.begin(task(), old); store.finish('task', old, 'completed')
  store.begin(task('task', 'new-private-name.txt'), current)
  expect(cancellations).toEqual([0])
  callbacks[0]()
  expect(store.update('task', old, { completedBytes: 17 })).toBe(false)
  expect(store.finish('task', old, 'failed')).toBe(false)
  expect(store.store.getState().tasks[0].name).toBe('new-private-name.txt')
  expect(store.cancel('task')).toBe(true); expect(current.signal.aborted).toBe(true)
})

test('reopening has a new lifetime; old controllers and removal callbacks cannot affect new tasks', () => {
  const callbacks: (() => void)[] = []
  const store = create(callback => { callbacks.push(callback); return () => {} })
  const finished = new AbortController(), pending = new AbortController()
  store.begin(task('finished'), finished); store.finish('finished', finished, 'completed')
  store.begin(task('pending'), pending); store.close(); store.open()
  expect(pending.signal.aborted).toBe(true)
  expect(store.begin(task('pending'), pending)).toBe(false)
  const current = new AbortController(); store.begin(task('finished', 'fresh.txt'), current)
  callbacks[0]()
  expect(store.finish('finished', finished, 'failed')).toBe(false)
  expect(store.store.getState().tasks).toEqual([task('finished', 'fresh.txt')])
})

test('real retention timers expire after eight seconds and close clears pending timers', () => {
  vi.useFakeTimers()
  const store = create(), first = new AbortController(), second = new AbortController()
  store.begin(task('first'), first); store.finish('first', first, 'completed')
  expect(vi.getTimerCount()).toBe(1)
  vi.advanceTimersByTime(7999); expect(store.store.getState().tasks).toHaveLength(1)
  vi.advanceTimersByTime(1); expect(store.store.getState().tasks).toEqual([])
  store.begin(task('second'), second); store.finish('second', second, 'failed')
  store.close(); expect(vi.getTimerCount()).toBe(0)
})

test('stores are per unlock; the read API exposes no controller, key or persistence action', () => {
  const first = create(), second = create(), a = new AbortController(), b = new AbortController()
  first.begin(task('first'), a); second.begin(task('second'), b)
  first.close(); expect(a.signal.aborted).toBe(true); expect(b.signal.aborted).toBe(false)
  expect(second.store.getState().tasks).toEqual([task('second')])
  expect(Object.keys(second.store).sort()).toEqual(['getInitialState', 'getState', 'subscribe'])
  expect(Object.keys(second.store.getState())).toEqual(['tasks'])
})

test('an abort listener replacing the same ID owns the result instead of its interrupted caller', () => {
  const store = create(), first = new AbortController(), outer = new AbortController(), inner = new AbortController()
  store.begin(task(), first)
  first.signal.addEventListener('abort', () => { expect(store.begin(task('task', 'inner.txt'), inner)).toBe(true) })
  expect(store.begin(task('task', 'outer.txt'), outer)).toBe(false)
  expect(outer.signal.aborted).toBe(true)
  expect(store.store.getState().tasks).toEqual([task('task', 'inner.txt')])
  expect(store.update('task', outer, { phase: 'uploading' })).toBe(false)
  expect(store.update('task', inner, { phase: 'uploading' })).toBe(true)
})

test('manual lock followed by unmount is idempotent even with a reentrant close subscriber', () => {
  const store = create(), controller = new AbortController(); let emptyEvents = 0
  store.begin(task(), controller)
  store.store.subscribe(state => { if (state.tasks.length === 0) { emptyEvents += 1; store.close() } })
  store.close(); store.close()
  expect(emptyEvents).toBe(1); expect(controller.signal.aborted).toBe(true)
})
