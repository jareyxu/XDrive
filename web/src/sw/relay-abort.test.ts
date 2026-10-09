import { afterEach, expect, test, vi } from 'vitest'
import workerSource from '../../public/media-sw.js?raw'

function harness(download = false) {
  const handlers = new Map<string, ((event: any) => void)[]>()
  const clients = { get: vi.fn(async (): Promise<{ id: string } | undefined> => ({ id: 'owner' })) }
  const scope = { location: { origin: 'https://xdrive.test' }, clients, addEventListener(type: string, listener: (event: any) => void) { handlers.set(type, [...handlers.get(type) ?? [], listener]) } }
  new Function('self', workerSource)(scope)
  const messages: any[] = []
  const port: any = { postMessage: (message: any) => messages.push(message), start() {}, close: vi.fn(), onmessage: undefined }
  const token = 'a'.repeat(32)
  let registration = Promise.resolve()
  for (const listener of handlers.get('message') ?? []) listener({ data: download ? { type: 'xdrive-download-register', sessionId: token, length: 2, filename: 'fixture.bin' } : { type: 'xdrive-media-register', sessionId: token, length: 2, mime: 'video/mp4' }, source: { id: 'owner' }, ports: [port], waitUntil: (pending: Promise<void>) => { registration = pending } })
  const fetch = async (signal: AbortSignal, clientId = 'owner', method = 'GET') => {
    await registration
    const request = new Request(`https://xdrive.test/${download ? '__xdrive_download' : '__xdrive_media'}/${token}`, { signal, method })
    const remove = vi.spyOn(request.signal, 'removeEventListener')
    let result!: Promise<Response>
    for (const listener of handlers.get('fetch') ?? []) listener({ request, clientId, respondWith: (response: Promise<Response>) => { result = response } })
    return { response: await result, remove }
  }
  return { clients, messages, port, fetch }
}
async function microtasks() { for (let i = 0; i < 12; i++) await Promise.resolve() }
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks() })

test('a foreign request prunes a disappeared media owner, rejects its pending stream and wipes late bytes', async () => {
  vi.useFakeTimers()
  const worker = harness(), signal = new AbortController().signal
  const { response } = await worker.fetch(signal)
  const reader = response.body!.getReader(), pending = reader.read()
  const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await microtasks()
  const read = worker.messages.find(message => message.type === 'read')
  expect(read).toBeDefined()
  worker.clients.get.mockResolvedValueOnce(undefined)
  expect((await worker.fetch(signal, 'peer', 'HEAD')).response.status).toBe(410)
  await rejection
  expect(worker.port.close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0)
  const late = new Uint8Array(2).fill(73)
  worker.port.onmessage({ data: { type: 'read-result', readId: read.readId, bytes: late } })
  expect([...late]).toEqual([0, 0])
  expect((await worker.fetch(signal, 'peer', 'HEAD')).response.status).toBe(410)
  expect((await worker.fetch(signal, 'owner', 'HEAD')).response.status).toBe(410)
})

test('a foreign request cannot read or close a live media session', async () => {
  const worker = harness(), signal = new AbortController().signal
  expect((await worker.fetch(signal, 'peer', 'HEAD')).response.status).toBe(403)
  expect((await worker.fetch(signal, 'peer')).response.status).toBe(403)
  expect(worker.port.close).not.toHaveBeenCalled()
  expect(worker.messages.some(message => message.type === 'read')).toBe(false)
  expect((await worker.fetch(signal, 'owner', 'HEAD')).response.status).toBe(200)
})

test('media relay wipes byte buffers from malformed page replies', async () => {
  const worker = harness()
  const { response } = await worker.fetch(new AbortController().signal)
  const pending = response.body!.getReader().read()
  await microtasks()
  const read = worker.messages.find(message => message.type === 'read')
  expect(read).toBeDefined()

  const unexpected = new Uint8Array(2).fill(67)
  worker.port.onmessage({ data: { type: 'unexpected', readId: read.readId, bytes: unexpected } })
  expect([...unexpected]).toEqual([0, 0])

  const unexpectedBuffer = new Uint8Array(3).fill(71)
  worker.port.onmessage({ data: { type: 'unexpected', readId: read.readId, bytes: unexpectedBuffer.buffer } })
  expect([...unexpectedBuffer]).toEqual([0, 0, 0])

  const viewedBuffer = new Uint8Array([1, 75, 76, 4])
  worker.port.onmessage({ data: { type: 'unexpected', readId: read.readId, bytes: new DataView(viewedBuffer.buffer, 1, 2) } })
  expect([...viewedBuffer]).toEqual([1, 0, 0, 4])

  if (typeof SharedArrayBuffer !== 'undefined') {
    const shared = new Uint8Array(new SharedArrayBuffer(2)).fill(82)
    worker.port.onmessage({ data: { type: 'unexpected', readId: read.readId, bytes: shared.buffer } })
    expect([...shared]).toEqual([0, 0])
  }

  const wrongLength = new Uint8Array(1).fill(89)
  worker.port.onmessage({ data: { type: 'read-result', readId: read.readId, bytes: wrongLength } })
  await expect(pending).rejects.toMatchObject({ name: 'TypeError' })
  expect([...wrongLength]).toEqual([0])
})

for (const download of [false, true]) {
  test(`${download ? 'download' : 'media'} pending window discovers a disappeared owner without a follow-up request`, async () => {
    vi.useFakeTimers()
    const worker = harness(download), owner = new AbortController()
    const { response } = await worker.fetch(owner.signal)
    const pending = response.body!.getReader().read()
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await microtasks()
    expect(worker.messages.some(message => message.type === (download ? 'pull' : 'read'))).toBe(true)
    worker.clients.get.mockResolvedValue(undefined)
    await vi.advanceTimersByTimeAsync(1000)
    await rejection
    expect(worker.port.close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  test(`${download ? 'download' : 'media'} abort during pending owner check cannot restart its timer`, async () => {
    vi.useFakeTimers()
    const worker = harness(download), owner = new AbortController()
    const { response } = await worker.fetch(owner.signal)
    const pending = response.body!.getReader().read()
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await microtasks()
    let release!: (value: { id: string }) => void
    worker.clients.get.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(release).toBeDefined()
    owner.abort(); release({ id: 'owner' })
    await rejection; await microtasks()
    expect(vi.getTimerCount()).toBe(0)
  })

  test(`${download ? 'download' : 'media'} request abort stops a pending read and removes its signal listener`, async () => {
    vi.useFakeTimers()
    const owner = new AbortController(), worker = harness(download)
    const { response, remove } = await worker.fetch(owner.signal)
    const reader = response.body!.getReader()
    const pending = reader.read()
    void pending.catch(() => undefined)
    await microtasks()
    const read = worker.messages.find(message => message.type === (download ? 'pull' : 'read'))
    expect(read).toBeDefined()
    owner.abort()
    await microtasks()
    expect(worker.messages).toContainEqual(download ? { type: 'cancelled', reason: 'request_aborted' } : { type: 'cancel-read', readId: read.readId })
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    if (!download) {
      const late = new Uint8Array(2).fill(73)
      worker.port.onmessage({ data: { type: 'read-result', readId: read.readId, bytes: late } })
      expect([...late]).toEqual([0, 0])
    }
  })

  test(`${download ? 'download' : 'media'} abort during owner lookup cannot dispatch a later plaintext read`, async () => {
    vi.useFakeTimers()
    const owner = new AbortController(), worker = harness(download)
    const { response } = await worker.fetch(owner.signal)
    let release!: (value: { id: string }) => void
    const gate = new Promise<{ id: string }>(resolve => { release = resolve })
    worker.clients.get.mockImplementationOnce(() => gate)
    const pending = response.body!.getReader().read()
    void pending.catch(() => undefined)
    await microtasks()
    owner.abort()
    release({ id: 'owner' })
    await microtasks()
    expect(worker.messages.filter(message => message.type === 'read' || message.type === 'pull')).toEqual([])
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
}

for (const download of [false, true]) {
  test(`${download ? 'download' : 'media'} completion detaches request cancellation without changing bytes`, async () => {
    const owner = new AbortController(), worker = harness(download)
    const { response, remove } = await worker.fetch(owner.signal)
    const reader = response.body!.getReader()
    const first = reader.read()
    await microtasks()
    const read = worker.messages.find(message => message.type === (download ? 'pull' : 'read'))
    worker.port.onmessage({ data: { type: download ? 'window' : 'read-result', readId: read.readId, bytes: new Uint8Array([19, 73]) } })
    expect((await first).value).toEqual(new Uint8Array([19, 73]))
    if (download) {
      const completed = reader.read()
      await microtasks()
      const last = worker.messages.filter(message => message.type === 'pull').at(-1)
      worker.port.onmessage({ data: { type: 'window', readId: last.readId, done: true } })
      expect((await completed).done).toBe(true)
    } else expect((await reader.read()).done).toBe(true)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    owner.abort()
    expect(worker.messages.some(message => message.type === 'cancelled' || message.type === 'cancel-read')).toBe(false)
  })
}

for (const download of [false, true]) {
  test(`${download ? 'download' : 'media'} consumer cancellation during owner lookup cannot dispatch a late read`, async () => {
    const worker = harness(download)
    const { response } = await worker.fetch(new AbortController().signal)
    let release!: (value: { id: string }) => void
    worker.clients.get.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const reader = response.body!.getReader()
    const pending = reader.read()
    await microtasks()
    await reader.cancel()
    release({ id: 'owner' })
    await microtasks()
    expect(worker.messages.filter(message => message.type === 'read' || message.type === 'pull')).toEqual([])
    expect((await pending).done).toBe(true)
  })

  test(`${download ? 'download' : 'media'} consumer cancellation settles while an owner window is pending`, async () => {
    const worker = harness(download)
    const { response } = await worker.fetch(new AbortController().signal)
    const reader = response.body!.getReader()
    const pending = reader.read()
    await microtasks()
    const read = worker.messages.find(message => message.type === (download ? 'pull' : 'read'))
    expect(read).toBeDefined()

    await reader.cancel()
    await expect(pending).resolves.toMatchObject({ done: true })
    expect(worker.messages).toContainEqual(download
      ? { type: 'cancelled', reason: 'consumer_cancelled' }
      : { type: 'cancel-read', readId: read.readId })
    expect(worker.messages.some(message => message.type === (download ? 'pull' : 'read'))).toBe(true)
    if (!download) {
      const late = new Uint8Array(2).fill(91)
      worker.port.onmessage({ data: { type: 'read-result', readId: read.readId, bytes: late } })
      expect([...late]).toEqual([0, 0])
    }
  })
}
