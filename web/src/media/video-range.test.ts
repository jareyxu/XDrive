import { afterEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  controlledRelayWorker: vi.fn(),
  createEncryptedRangeReader: vi.fn(),
}))

vi.mock('../sw/controller', () => ({ controlledRelayWorker: mocks.controlledRelayWorker }))
vi.mock('../api/client', () => ({ createEncryptedRangeReader: mocks.createEncryptedRangeReader }))

import { createVideoRangeSession } from './video-range'
import { supportsVideoRange } from './video-range'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

test('video Range capability keeps unverified Gecko and mobile paths on the bounded fallback', () => {
  expect(supportsVideoRange('Mozilla/5.0 Safari/605.1', true, true)).toBe(true)
  expect(supportsVideoRange('Mozilla/5.0 Firefox/155.0', true, true)).toBe(false)
  expect(supportsVideoRange('Mozilla/5.0 FxiOS/155.0', true, true)).toBe(false)
  expect(supportsVideoRange('Mozilla/5.0 Chrome/153.0 Mobile', true, true)).toBe(false)
  expect(supportsVideoRange('Mozilla/5.0 Macintosh; Intel Mac OS X', true, true, 5)).toBe(false)
  expect(supportsVideoRange('Mozilla/5.0 Macintosh; Intel Mac OS X', true, true, 0)).toBe(true)
  expect(supportsVideoRange('Mozilla/5.0 Safari/605.1', false, true)).toBe(false)
  expect(supportsVideoRange('Mozilla/5.0 Safari/605.1', true, false)).toBe(false)
})

test('pagehide closes a video Range session, aborts active decryption, and erases a late plaintext window', async () => {
  const ownerWindow = Object.assign(new EventTarget(), {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  })
  vi.stubGlobal('window', ownerWindow)
  const started = deferred<void>()
  const late = deferred<Uint8Array>()
  let readSignal!: AbortSignal
  const reader = {
    length: 4096,
    readRange: vi.fn((_begin: number, _end: number, signal: AbortSignal) => {
      readSignal = signal
      started.resolve()
      return late.promise
    }),
    destroy: vi.fn(),
  }
  mocks.createEncryptedRangeReader.mockResolvedValue(reader)

  let workerPort!: MessagePort
  const messages: unknown[] = []
  const worker = {
    postMessage: vi.fn((message: { sessionId: string }, ports: Transferable[]) => {
      workerPort = ports[0] as MessagePort
      workerPort.onmessage = (event) => messages.push(event.data)
      workerPort.start()
      queueMicrotask(() => workerPort.postMessage({ type: 'registered', sessionId: message.sessionId }))
    }),
  } as unknown as ServiceWorker
  mocks.controlledRelayWorker.mockResolvedValue(worker)

  const session = await createVideoRangeSession({} as never, {
    kind: 'file',
    mime: 'video/mp4',
  } as never)
  workerPort.postMessage({ type: 'read', readId: 17, begin: 0, end: 1024 })
  await started.promise

  ownerWindow.dispatchEvent(new Event('pagehide'))
  expect(readSignal.aborted).toBe(true)
  expect(reader.destroy).toHaveBeenCalledOnce()

  const lateBytes = new Uint8Array(1024).fill(0xa5)
  late.resolve(lateBytes)
  await vi.waitFor(() => expect(lateBytes.every((byte) => byte === 0)).toBe(true))
  await vi.waitFor(() => expect(messages).toContainEqual({ type: 'close' }))

  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(messages).toEqual([{ type: 'close' }])
  session.close()
  workerPort.close()
})

test('a seek cancels page-owned Range reads and returns the pending read error to the Service Worker', async () => {
  const ownerWindow = Object.assign(new EventTarget(), {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  })
  vi.stubGlobal('window', ownerWindow)
  let readSignal!: AbortSignal
  const reader = {
    length: 4096,
    readRange: vi.fn((_begin: number, _end: number, signal: AbortSignal) => new Promise<Uint8Array>((_resolve, reject) => {
      readSignal = signal
      signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })
    })),
    destroy: vi.fn(),
  }
  mocks.createEncryptedRangeReader.mockResolvedValue(reader)
  let workerPort!: MessagePort
  const messages: unknown[] = []
  const worker = {
    postMessage: vi.fn((message: { sessionId: string }, ports: Transferable[]) => {
      workerPort = ports[0] as MessagePort
      workerPort.onmessage = (event) => messages.push(event.data)
      workerPort.start()
      queueMicrotask(() => workerPort.postMessage({ type: 'registered', sessionId: message.sessionId }))
    }),
  } as unknown as ServiceWorker
  mocks.controlledRelayWorker.mockResolvedValue(worker)

  const session = await createVideoRangeSession({} as never, { kind: 'file', mime: 'video/mp4' } as never)
  workerPort.postMessage({ type: 'read', readId: 23, begin: 1024, end: 2048 })
  await vi.waitFor(() => expect(readSignal).toBeDefined())
  session.cancelPendingReads()
  expect(readSignal.aborted).toBe(true)
  await vi.waitFor(() => expect(messages).toContainEqual({ type: 'read-result', readId: 23, error: 'read_failed' }))
  session.close()
  workerPort.close()
})
