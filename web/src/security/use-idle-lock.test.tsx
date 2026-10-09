// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useIdleLock } from './use-idle-lock'
import { IDLE_LOCK_MILLISECONDS } from './idle-lock'

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] }) })
afterEach(() => { cleanup(); vi.useRealTimers() })
const advance = (milliseconds: number) => act(() => { vi.advanceTimersByTime(milliseconds) })

test('vault revision renders preserve the deadline and invoke the latest lock callback', () => {
  const oldLock = vi.fn(), newLock = vi.fn()
  const { rerender } = renderHook(({ callback }) => useIdleLock(true, callback), { initialProps: { callback: oldLock } })
  advance(IDLE_LOCK_MILLISECONDS - 1000)
  rerender({ callback: newLock })
  advance(1000)
  expect(oldLock).not.toHaveBeenCalled()
  expect(newLock).toHaveBeenCalledTimes(1)
})
test('script-generated activity cannot keep the unlocked page alive', () => {
  const lock = vi.fn()
  renderHook(() => useIdleLock(true, lock))
  advance(IDLE_LOCK_MILLISECONDS - 1000)
  for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'input']) document.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }))
  advance(1000)
  expect(lock).toHaveBeenCalledTimes(1)
})
test('manual locking cancels idle work and makes old task releases harmless', () => {
  const lock = vi.fn()
  const { result, rerender, unmount } = renderHook(({ enabled }) => useIdleLock(enabled, lock), { initialProps: { enabled: true } })
  const release = result.current('upload')
  rerender({ enabled: false })
  release()
  expect(() => result.current('download')).toThrow('not unlocked')
  advance(IDLE_LOCK_MILLISECONDS * 2)
  expect(lock).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  unmount()
})
test('a late task release from an old unlock cannot affect the next unlock timer', () => {
  const lock = vi.fn()
  const { result, rerender } = renderHook(({ enabled }) => useIdleLock(enabled, lock), { initialProps: { enabled: true } })
  const oldRelease = result.current('video')
  rerender({ enabled: false }); rerender({ enabled: true })
  advance(IDLE_LOCK_MILLISECONDS - 1000)
  oldRelease()
  advance(1000)
  expect(lock).toHaveBeenCalledTimes(1)
})
