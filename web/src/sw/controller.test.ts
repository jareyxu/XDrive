import { afterEach, describe, expect, it, test, vi } from 'vitest'
import { controlledRelayWorker } from './controller'
import { supportsRelayDownload } from '../downloads/sw-download'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('SW readiness and conservative download capability', () => {
  it('cancels a registration that does not settle', async () => {
    vi.stubGlobal('window', globalThis)
    vi.stubGlobal('navigator', { serviceWorker: { register: () => new Promise(() => undefined) } })
    const owner = new AbortController()
    const pending = controlledRelayWorker(owner.signal)
    owner.abort()
    await expect(pending).rejects.toThrow(/abort/i)
  })

  it('times out a ready promise instead of retaining a task forever', async () => {
    vi.useFakeTimers(); vi.stubGlobal('window', globalThis)
    vi.stubGlobal('navigator', { serviceWorker: { register: async () => ({}), ready: new Promise(() => undefined) } })
    const pending = controlledRelayWorker()
    const assertion = expect(pending).rejects.toThrow(/超时/)
    await vi.advanceTimersByTimeAsync(10_000)
    await assertion
  })

  it.each([
    ['Mozilla Chrome/153.0 Safari/537.36', true],
    ['Mozilla Edg/153.0', true],
    ['Mozilla Chrome/153.0 Android Mobile', false],
    ['Mozilla iPhone Safari/605.1', false],
    ['Mozilla Firefox/140.0', false],
  ])('uses relay downloads only for validated desktop engine %s', (userAgent, expected) => {
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('navigator', { serviceWorker: {}, userAgent })
    expect(supportsRelayDownload()).toBe(expected)
    vi.stubGlobal('isSecureContext', false)
    expect(supportsRelayDownload()).toBe(false)
  })
})

test('an activated registration explicitly claims an uncontrolled page before relay use', async () => {
  const worker = {} as ServiceWorker
  const container = Object.assign(new EventTarget(), {
    controller: null as ServiceWorker | null,
    ready: Promise.resolve({}),
    register: vi.fn(),
  })
  const claim = vi.fn(message => {
    expect(message).toEqual({ type: 'xdrive-relay-claim' })
    container.controller = worker
    container.dispatchEvent(new Event('controllerchange'))
  })
  container.register.mockResolvedValue({ active: { postMessage: claim } })
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('navigator', { serviceWorker: container })
  await expect(controlledRelayWorker()).resolves.toBe(worker)
  expect(claim).toHaveBeenCalledOnce()
})

test('claim failure rejects promptly and detaches controller listeners', async () => {
  const container = Object.assign(new EventTarget(), {
    controller: null,
    ready: Promise.resolve({}),
    register: vi.fn().mockResolvedValue({ active: { postMessage() { throw new Error('worker stopped') } } }),
  })
  const remove = vi.spyOn(container, 'removeEventListener')
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('navigator', { serviceWorker: container })
  await expect(controlledRelayWorker()).rejects.toThrow('worker stopped')
  expect(remove).toHaveBeenCalledWith('controllerchange', expect.any(Function))
})
