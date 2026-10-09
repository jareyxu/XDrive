import { controlledRelayWorker } from '../sw/controller'

const WINDOW_BYTES = 1024 * 1024
const TIMEOUT_MS = 30_000

// Other browser/device paths retain the explicit bounded Blob fallback until
// native attachment downloads have been verified on those platforms.
export function supportsRelayDownload(): boolean {
  return isSecureContext && 'serviceWorker' in navigator && typeof WritableStream !== 'undefined' && /(?:Chrome|Edg)\//u.test(navigator.userAgent) && !/Mobile|Android/u.test(navigator.userAgent)
}

export interface RelayDownload {
  readonly writable: WritableStream<Uint8Array>
  readonly signal: AbortSignal
  close(): void
}

/** No keys are sent. Encoded filename is temporary response-header metadata. */
export async function createRelayDownload(name: string, length: number | null, ownerSignal?: AbortSignal): Promise<RelayDownload> {
  if (length !== null && (!Number.isSafeInteger(length) || length < 0)) throw new TypeError('下载大小无效。')
  const filename = encodeURIComponent(name).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
  if (!filename || filename.length > 8192) throw new TypeError('下载名称过长，请重命名后重试。')
  const worker = await controlledRelayWorker(ownerSignal)
  ownerSignal?.throwIfAborted()
  const id = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
  const channel = new MessageChannel()
  const lifetime = new AbortController()
  let output: WritableStreamDefaultController
  let closed = false
  let started = false
  let frame: HTMLIFrameElement | undefined
  let completed = false
  let credit: number | undefined
  let creditWaiter: { resolve: (value: number) => void; reject: (error: unknown) => void } | undefined
  let replyWaiter: { id: number; resolve: () => void; reject: (error: unknown) => void } | undefined
  let registerResolve!: () => void
  let registerReject!: (error: unknown) => void
  const registration = new Promise<void>((resolve, reject) => { registerResolve = resolve; registerReject = reject })
  let completeResolve!: () => void
  let completeReject!: (error: unknown) => void
  const completion = new Promise<void>((resolve, reject) => { completeResolve = resolve; completeReject = reject })
  void completion.catch(() => undefined)
  const close = (reason: unknown = new DOMException('Download stopped', 'AbortError')) => {
    if (closed) return
    closed = true
    if (!completed) {
      lifetime.abort(reason)
      output?.error(reason)
      registerReject(reason); completeReject(reason)
      creditWaiter?.reject(reason); replyWaiter?.reject(reason)
    }
    creditWaiter = undefined; replyWaiter = undefined; credit = undefined
    try { channel.port1.postMessage({ type: 'close' }) } catch { /* Worker may have stopped. */ }
    channel.port1.close()
    if (completed) { const finishedFrame = frame; window.setTimeout(() => finishedFrame?.remove(), 1000) }
    else frame?.remove()
    frame = undefined
    ownerSignal?.removeEventListener('abort', onAbort)
    window.removeEventListener('pagehide', onHide)
  }
  const onAbort = () => close(ownerSignal?.reason)
  const onHide = () => close()
  const withTimeout = async <T>(promise: Promise<T>): Promise<T> => {
    let timer = 0
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => { const error = new TypeError('下载转发未响应；请重新下载。'); close(error); reject(error) }, TIMEOUT_MS)
      })])
    } finally { window.clearTimeout(timer) }
  }
  const nextCredit = async () => {
    lifetime.signal.throwIfAborted()
    if (credit !== undefined) { const value = credit; credit = undefined; return value }
    return withTimeout(new Promise<number>((resolve, reject) => { creditWaiter = { resolve, reject } }))
  }
  const send = async (bytes?: Uint8Array) => {
    try {
      const readId = await nextCredit()
      lifetime.signal.throwIfAborted()
      const reply = new Promise<void>((resolve, reject) => { replyWaiter = { id: readId, resolve, reject } })
      if (bytes) channel.port1.postMessage({ type: 'window', readId, bytes }, [bytes.buffer as ArrayBuffer])
      else channel.port1.postMessage({ type: 'window', readId, done: true })
      await withTimeout(reply)
    } finally { if (bytes?.byteLength) bytes.fill(0) }
  }
  const startDownload = () => {
    lifetime.signal.throwIfAborted()
    if (started) return
    started = true
    frame = document.createElement('iframe')
    frame.hidden = true
    frame.title = '下载传输'
    frame.src = `/__xdrive_download/${id}`
    document.body.append(frame)
  }
  const writable = new WritableStream<Uint8Array>({
    start(controller) { output = controller },
    async write(bytes) {
      try {
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > 8 * WINDOW_BYTES) throw new TypeError('下载输出超过分块上限。')
        startDownload()
        for (let offset = 0; offset < bytes.byteLength; offset += WINDOW_BYTES) await send(bytes.slice(offset, Math.min(bytes.byteLength, offset + WINDOW_BYTES)))
      } catch (error) { close(error); throw error }
    },
    async close() {
      try { startDownload(); await send(); await withTimeout(completion); close() }
      catch (error) { close(error); throw error }
    },
    abort(reason) { close(reason) },
  })
  channel.port1.onmessage = (event: MessageEvent) => {
    const message = event.data
    if (!message || closed) return
    if (message.type === 'registered' && message.sessionId === id) { registerResolve(); return }
    if (message.type === 'cancelled') {
      if (['consumer_cancelled', 'owner_closed', 'owner_missing'].includes(message.reason)) close()
      else close(new TypeError('流式下载已中断，请重新下载。'))
      return
    }
    if (message.type === 'complete') { completed = true; completeResolve(); return }
    if (message.type === 'ack' && replyWaiter && message.readId === replyWaiter.id) { replyWaiter.resolve(); replyWaiter = undefined; return }
    if (message.type === 'pull' && Number.isSafeInteger(message.readId) && message.readId > 0) {
      if (credit !== undefined) { close(new TypeError('下载转发出现重复读取请求。')); return }
      if (creditWaiter) { const waiter = creditWaiter; creditWaiter = undefined; waiter.resolve(message.readId) }
      else credit = message.readId
    }
  }
  channel.port1.onmessageerror = () => close()
  channel.port1.start()
  ownerSignal?.addEventListener('abort', onAbort, { once: true })
  window.addEventListener('pagehide', onHide, { once: true })
  try {
    worker.postMessage({ type: 'xdrive-download-register', sessionId: id, length, filename }, [channel.port2])
    await withTimeout(registration)
    lifetime.signal.throwIfAborted()
    return { writable, signal: lifetime.signal, close: () => close() }
  } catch (error) { close(error); throw error }
}
