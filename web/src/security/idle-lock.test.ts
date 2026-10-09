import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { IdleLock, IDLE_LOCK_MILLISECONDS } from './idle-lock'
import type { IdleLockTask } from './idle-lock'

let wall = 0, monotonic = 0
const clock = { wall: () => wall, monotonic: () => monotonic, schedule: (callback: () => void, ms: number) => setTimeout(callback, ms), cancel: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer) }
beforeEach(() => { vi.useFakeTimers(); wall = 0; monotonic = 0 })
afterEach(() => { vi.useRealTimers() })
function advance(ms: number) { wall += ms; monotonic += ms; vi.advanceTimersByTime(ms) }

test('locks at ten idle minutes exactly once and clears its timer', () => {
  const lock = vi.fn(), idle = new IdleLock(lock, clock)
  advance(IDLE_LOCK_MILLISECONDS - 1)
  expect(lock).not.toHaveBeenCalled()
  advance(1)
  expect(lock).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
  idle.check(); idle.activity(); advance(IDLE_LOCK_MILLISECONDS)
  expect(lock).toHaveBeenCalledTimes(1)
})
test('ordinary activity resets the deadline without more than one live timer', () => {
  const lock = vi.fn(), idle = new IdleLock(lock, clock)
  advance(9 * 60_000)
  for (let event = 0; event < 100; event += 1) expect(idle.activity()).toBe(true)
  expect(vi.getTimerCount()).toBe(1)
  advance(IDLE_LOCK_MILLISECONDS - 1)
  expect(lock).not.toHaveBeenCalled()
  advance(1)
  expect(lock).toHaveBeenCalledTimes(1)
})
test.each<IdleLockTask>(['upload', 'download', 'zip', 'video'])('%s pauses idle lock until the task finishes, then grants a fresh ten minutes', (kind) => {
  const lock = vi.fn(), idle = new IdleLock(lock, clock)
  advance(9 * 60_000)
  const release = idle.hold(kind)
  advance(60 * 60_000)
  expect(idle.check()).toBe(false)
  expect(lock).not.toHaveBeenCalled()
  release(); release()
  expect(vi.getTimerCount()).toBe(1)
  advance(IDLE_LOCK_MILLISECONDS - 1)
  expect(lock).not.toHaveBeenCalled()
  advance(1)
  expect(lock).toHaveBeenCalledTimes(1)
})
test('overlapping tasks resume the clock only after the last one ends', () => {
  const lock = vi.fn(), idle = new IdleLock(lock, clock)
  const upload = idle.hold('upload'), download = idle.hold('download')
  upload(); advance(IDLE_LOCK_MILLISECONDS * 2)
  expect(lock).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  download(); advance(IDLE_LOCK_MILLISECONDS)
  expect(lock).toHaveBeenCalledTimes(1)
})
test('a resumed page or first input after wall-clock expiry locks before resetting activity', () => {
  const lock = vi.fn(), idle = new IdleLock(lock, clock)
  wall += IDLE_LOCK_MILLISECONDS
  expect(idle.activity()).toBe(false)
  expect(lock).toHaveBeenCalledTimes(1)
  expect(() => idle.hold('upload')).toThrow('expired')
})
test('moving the system clock backward cannot extend the monotonic idle interval', () => {
  const lock = vi.fn(), idle = new IdleLock(lock, clock)
  wall -= 24 * 60 * 60_000; monotonic += IDLE_LOCK_MILLISECONDS
  expect(idle.check()).toBe(true)
  expect(lock).toHaveBeenCalledTimes(1)
})
test('disposal prevents late callbacks or task releases from restarting an old timer', () => {
  const lock = vi.fn(), idle = new IdleLock(lock, clock), release = idle.hold('zip')
  idle.dispose(); release(); advance(IDLE_LOCK_MILLISECONDS)
  expect(lock).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
test('stale timer callbacks cannot lock a new activity interval', () => {
  const callbacks: (() => void)[] = []
  const lock = vi.fn(), idle = new IdleLock(lock, { ...clock, schedule(callback, ms) { callbacks.push(callback); return setTimeout(callback, ms) } })
  const stale = callbacks[0]!
  advance(60_000); idle.activity()
  stale()
  expect(lock).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(1)
  idle.dispose()
})
test('unrecognized task categories cannot pause the automatic lock', () => {
  const lock = vi.fn(), idle = new IdleLock(lock, clock)
  expect(() => idle.hold('preview' as IdleLockTask)).toThrow('invalid')
  advance(IDLE_LOCK_MILLISECONDS)
  expect(lock).toHaveBeenCalledTimes(1)
})
