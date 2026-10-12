import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  controlledRelayWorker: vi.fn(),
  createEncryptedRangeReader: vi.fn(),
}))

vi.mock('../sw/controller', () => ({ controlledRelayWorker: mocks.controlledRelayWorker }))
vi.mock('../api/client', () => ({ createEncryptedRangeReader: mocks.createEncryptedRangeReader }))

import { createVideoRangeSession } from './video-range'
import { supportsVideoRange, verifyVideoRange, VideoStreamError, videoResponseMime } from './video-range'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

beforeEach(() => {
  vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) }))
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const match = /bytes=(\d+)-(\d+)/u.exec(init.headers.Range)!
    const begin = Number(match[1]), end = Number(match[2])
    return new Response(new Uint8Array(end - begin + 1), { status: 206, headers: { 'Content-Range': `bytes ${begin}-${end}/4096`, 'Content-Length': String(end - begin + 1) } })
  }))
})

test('video Range capability checks runtime APIs rather than excluding phones', () => {
  expect(supportsVideoRange(true, true, true, true)).toBe(true)
  for (let unavailable = 0; unavailable < 4; unavailable++) {
    const capabilities = [true, true, true, true]
    capabilities[unavailable] = false
    expect(supportsVideoRange(...capabilities as [boolean, boolean, boolean, boolean])).toBe(false)
  }
})

test('phone and desktop-mode iPad use a two-chunk cache and one read at a time', async () => {
  const { videoReaderBudget } = await import('./video-range')
  expect(videoReaderBudget('iPhone Mobile', 5)).toEqual({ cacheChunks: 2, concurrency: 1 })
  expect(videoReaderBudget('Android Chrome Mobile', 5)).toEqual({ cacheChunks: 2, concurrency: 1 })
  expect(videoReaderBudget('Macintosh Safari', 5)).toEqual({ cacheChunks: 2, concurrency: 1 })
  expect(videoReaderBudget('Macintosh Safari', 0)).toEqual({ cacheChunks: 4, concurrency: 2 })
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
  expect(messages).toEqual([{ type: 'cancel-reads', readIds: [17] }, { type: 'close' }])
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


test('range verification rejects a full response before reading its body', async () => {
  const cancel = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 200 })))
  await expect(verifyVideoRange('/__xdrive_media/session', 4096)).rejects.toBeInstanceOf(VideoStreamError)
  expect(cancel).toHaveBeenCalledOnce()
})

test('range verification reads the beginning and tail and rejects mismatched headers', async () => {
  await verifyVideoRange('/__xdrive_media/session', 4096)
  expect(vi.mocked(fetch).mock.calls.map(([, init]) => (init!.headers as Record<string, string>).Range)).toEqual(['bytes=0-1', 'bytes=4094-4095'])
  expect(vi.mocked(fetch).mock.calls.map(([, init]) => init!.method)).toEqual(['GET', 'HEAD'])
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(2), { status: 206, headers: { 'Content-Length': '2', 'Content-Range': 'bytes 0-1/9999' } })))
  await expect(verifyVideoRange('/__xdrive_media/session', 4096)).rejects.toMatchObject({ kind: 'session' })
})

test('slow first-block buffering is not rejected by the former 15-second probe deadline', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('window', globalThis)
  const normalFetch = vi.mocked(fetch)
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (init.method === 'GET') await new Promise(resolve => setTimeout(resolve, 20000))
    return normalFetch(url, init)
  }))
  let finished = false
  const probe = verifyVideoRange('/__xdrive_media/session', 4096).then(() => { finished = true })
  await vi.advanceTimersByTimeAsync(15000)
  expect(finished).toBe(false)
  await vi.advanceTimersByTimeAsync(5000)
  await probe
  expect(finished).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

test('AEAD authentication failures are integrity errors rather than network errors', async () => {
  mocks.createEncryptedRangeReader.mockRejectedValueOnce(new DOMException('authentication failed', 'OperationError'))
  await expect(createVideoRangeSession({} as never, { kind: 'file', mime: 'video/mp4' } as never)).rejects.toMatchObject({ kind: 'integrity' })
})

test('codec parameters produce a valid relay MIME without changing authenticated metadata', async () => {
  const entry = { kind: 'file', mime: 'video/mp4; codecs="avc1.42E01E"' } as never
  mocks.createEncryptedRangeReader.mockResolvedValue({ length: 4096, destroy: vi.fn() })
  let port!: MessagePort
  const postMessage = vi.fn((message, ports: Transferable[]) => {
    expect(message.mime).toBe('video/mp4')
    port = ports[0] as MessagePort
    port.postMessage({ type: 'registered', sessionId: message.sessionId })
  })
  mocks.controlledRelayWorker.mockResolvedValue({ postMessage })
  const owned = await createVideoRangeSession({} as never, entry)
  expect(mocks.createEncryptedRangeReader.mock.calls[0]![1]).toBe(entry)
  expect(entry).toMatchObject({ mime: 'video/mp4; codecs="avc1.42E01E"' })
  owned.close()
  port.close()
})

test('relay MIME normalization rejects header control characters', () => {
  expect(videoResponseMime('video/MP4; codecs="avc1.42E01E"')).toBe('video/mp4')
  for (const mime of ['video/mp4\n', 'video/mp4;\r codecs=bad', 'text/plain', undefined]) {
    expect(() => videoResponseMime(mime)).toThrow(VideoStreamError)
  }
})
