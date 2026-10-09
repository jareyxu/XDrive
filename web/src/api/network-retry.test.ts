// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'
import { NetworkUnavailableError, retryNetworkRequest } from './network-retry'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

test('retries an interrupted idempotent transfer and reports waiting only at phase changes', async () => {
  vi.useFakeTimers()
  const operation = vi.fn<() => Promise<string>>()
    .mockRejectedValueOnce(new NetworkUnavailableError())
    .mockResolvedValueOnce('complete')
  const onWaiting = vi.fn()
  const pending = retryNetworkRequest(operation, undefined, onWaiting)
  await vi.advanceTimersByTimeAsync(250)
  await expect(pending).resolves.toBe('complete')
  expect(operation).toHaveBeenCalledTimes(2)
  expect(onWaiting.mock.calls).toEqual([[true], [false]])
})

test('keeps an offline transfer cancellable while waiting for the browser online event', async () => {
  vi.stubGlobal('navigator', { onLine: false })
  const controller = new AbortController()
  const operation = vi.fn(async () => 'never')
  const pending = retryNetworkRequest(operation, controller.signal)
  await Promise.resolve()
  controller.abort(new DOMException('cancelled', 'AbortError'))
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  expect(operation).not.toHaveBeenCalled()
})

test('continues automatically when the browser returns online', async () => {
  let online = false
  vi.stubGlobal('navigator', { get onLine() { return online } })
  const operation = vi.fn(async () => 'continued')
  const pending = retryNetworkRequest(operation)
  await Promise.resolve()
  online = true
  window.dispatchEvent(new Event('online'))
  await expect(pending).resolves.toBe('continued')
  expect(operation).toHaveBeenCalledTimes(1)
})
