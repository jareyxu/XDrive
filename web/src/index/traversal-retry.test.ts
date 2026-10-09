import { afterEach, expect, test, vi } from 'vitest'
import { ConcurrentMutationRetryExhaustedError, retryTraversalMutation } from './traversal-retry'

afterEach(() => vi.useRealTimers())
const conflict = new Error('snapshot changed')
const isConflict = (error: unknown) => error === conflict

test('rebuilds four times with bounded full-jitter windows and stops', async () => {
  vi.useFakeTimers()
  const rebuild = vi.fn(async () => { throw conflict })
  const result = retryTraversalMutation(rebuild, isConflict, undefined, () => 0.5)
  const rejection = expect(result).rejects.toBeInstanceOf(ConcurrentMutationRetryExhaustedError)
  await vi.advanceTimersByTimeAsync(249)
  expect(rebuild).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(rebuild).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(500)
  expect(rebuild).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(1000)
  await rejection
  expect(rebuild).toHaveBeenCalledTimes(4)
  await vi.runAllTimersAsync()
  expect(rebuild).toHaveBeenCalledTimes(4)
})

test('cancellation interrupts backoff without starting another traversal', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const rebuild = vi.fn(async () => { throw conflict })
  const result = retryTraversalMutation(rebuild, isConflict, controller.signal, () => 0.5)
  const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' })
  await vi.advanceTimersByTimeAsync(0)
  controller.abort()
  await rejection
  await vi.runAllTimersAsync()
  expect(rebuild).toHaveBeenCalledTimes(1)
})

test('a rebuilt snapshot can succeed; unrelated failures are not retried', async () => {
  vi.useFakeTimers()
  const rebuild = vi.fn().mockRejectedValueOnce(conflict).mockResolvedValueOnce('committed')
  const result = retryTraversalMutation(rebuild, isConflict, undefined, () => 0)
  await vi.runAllTimersAsync()
  await expect(result).resolves.toBe('committed')
  const invalid = new Error('integrity failed')
  const failing = vi.fn(async () => { throw invalid })
  await expect(retryTraversalMutation(failing, isConflict)).rejects.toBe(invalid)
  expect(failing).toHaveBeenCalledTimes(1)
})
