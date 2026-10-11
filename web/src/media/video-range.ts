import { controlledRelayWorker } from '../sw/controller'
import { createEncryptedRangeReader } from '../api/client'
import type { DriveEntry, UnlockedVault } from '../api/client'

const WINDOW_BYTES = 1024 * 1024

export class VideoStreamError extends Error {
  readonly kind: 'session' | 'network' | 'integrity'
  constructor(kind: 'session' | 'network' | 'integrity', message: string, options?: ErrorOptions) {
    super(message, options)
    this.kind = kind
  }
}

const integrityFailure = (cause: unknown) => cause instanceof TypeError || cause instanceof DOMException && cause.name === 'OperationError'

export interface VideoRangeSession {
  readonly url: string
  failure(): VideoStreamError | undefined
  cancelPendingReads(): void
  close(): void
}

export function supportsVideoRange(secureContext = isSecureContext, hasServiceWorker = 'serviceWorker' in navigator, hasStreams = typeof ReadableStream !== 'undefined', hasPorts = typeof MessageChannel !== 'undefined'): boolean {
  return secureContext && hasServiceWorker && hasStreams && hasPorts
}

export function videoReaderBudget(userAgent = navigator.userAgent, touchPoints = navigator.maxTouchPoints) {
  const mobile = /Mobile|Android|iPhone|iPad/u.test(userAgent) || /Macintosh/u.test(userAgent) && touchPoints > 1
  return mobile ? { cacheChunks: 2 as const, concurrency: 1 as const } : { cacheChunks: 4 as const, concurrency: 2 as const }
}

function randomSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}


export async function createVideoRangeSession(vault: UnlockedVault, entry: DriveEntry, signal?: AbortSignal): Promise<VideoRangeSession> {
  if (entry.kind !== 'file' || !(entry.mime ?? '').startsWith('video/')) throw new TypeError('只能为视频文件建立播放会话。')
  if (signal?.aborted) throw new DOMException('Video setup cancelled', 'AbortError')
  let worker: ServiceWorker
  try { worker = await controlledRelayWorker(signal) }
  catch (cause) { if (signal?.aborted) throw cause; throw new VideoStreamError('session', '流式播放服务无法接管页面。', { cause }) }
  let reader: Awaited<ReturnType<typeof createEncryptedRangeReader>>
  try { reader = await createEncryptedRangeReader(vault, entry, signal, undefined, videoReaderBudget()) }
  catch (cause) { if (signal?.aborted) throw cause; throw new VideoStreamError(integrityFailure(cause) ? 'integrity' : 'network', integrityFailure(cause) ? '视频文件信息或完整性校验失败。' : '无法读取视频信息，请检查网络后重试。', { cause }) }
  if (signal?.aborted) { reader.destroy(); throw new DOMException('Video setup cancelled', 'AbortError') }
  const sessionId = randomSessionId()
  const channel = new MessageChannel()
  const reads = new Map<number, AbortController>()
  let closed = false
  let registered = false
  let readFailure: VideoStreamError | undefined
  let resolveRegistration: (() => void) | undefined
  let rejectRegistration: ((error: Error) => void) | undefined
  const registration = new Promise<void>((resolve, reject) => { resolveRegistration = resolve; rejectRegistration = reject })
  const close = () => {
    if (closed) return
    closed = true
    if (!registered) rejectRegistration?.(new DOMException('Video setup cancelled', 'AbortError'))
    cancelPendingReads()
    try { channel.port1.postMessage({ type: 'close' }) } catch { /* Worker may have been replaced. */ }
    channel.port1.close()
    reader.destroy()
    window.removeEventListener('pagehide', close)
    signal?.removeEventListener('abort', close)
  }
  const cancelPendingReads = () => {
    if (reads.size) {
      try { channel.port1.postMessage({ type: 'cancel-reads', readIds: [...reads.keys()] }) } catch { /* Relay may be gone. */ }
    }
    for (const controller of reads.values()) controller.abort()
    reads.clear()
  }
  window.addEventListener('pagehide', close, { once: true })
  signal?.addEventListener('abort', close, { once: true })
  channel.port1.onmessage = (event: MessageEvent) => {
    const message = event.data
    if (!message || closed) return
    if (message.type === 'registered' && message.sessionId === sessionId) {
      registered = true
      resolveRegistration?.()
      return
    }
    if (message.type === 'cancel-read' && Number.isSafeInteger(message.readId)) {
      reads.get(message.readId)?.abort()
      return
    }
    if (message.type !== 'read' || !Number.isSafeInteger(message.readId)) return
    const { readId, begin, end } = message
    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end <= begin || end > reader.length || end - begin > WINDOW_BYTES || reads.has(readId) || reads.size >= 32) {
      channel.port1.postMessage({ type: 'read-result', readId, error: 'invalid_range' })
      return
    }
    const controller = new AbortController()
    reads.set(readId, controller)
    void reader.readRange(begin, end, controller.signal).then((bytes) => {
      if (closed || controller.signal.aborted) { bytes.fill(0); return }
      channel.port1.postMessage({ type: 'read-result', readId, bytes }, [bytes.buffer as ArrayBuffer])
    }).catch((cause) => {
      if (!controller.signal.aborted) readFailure = new VideoStreamError(integrityFailure(cause) ? 'integrity' : 'network', integrityFailure(cause) ? '视频数据完整性校验失败。' : '视频数据读取失败，请检查网络后重试。', { cause })
      if (!closed) channel.port1.postMessage({ type: 'read-result', readId, error: 'read_failed' })
    }).finally(() => { reads.delete(readId) })
  }
  channel.port1.onmessageerror = close
  channel.port1.start()
  let timeout = 0
  try {
    worker.postMessage({ type: 'xdrive-media-register', sessionId, length: reader.length, mime: entry.mime }, [channel.port2])
    await Promise.race([
      registration,
      new Promise<never>((_, reject) => { timeout = window.setTimeout(() => reject(new TypeError('视频播放会话注册超时。')), 5000) }),
    ])
    if (closed) throw new DOMException('Video setup cancelled', 'AbortError')
    const url = `/__xdrive_media/${sessionId}`
    try { await verifyVideoRange(url, reader.length, signal) }
    catch (cause) { throw readFailure ?? cause }
    return { url, failure: () => readFailure, cancelPendingReads, close }
  } catch (error) {
    close()
    throw error
  } finally {
    window.clearTimeout(timeout)
  }
}

/** Verify the actual relay, not just API presence. Read two bytes at either end;
 * never aggregate an unexpected full response or keep probe plaintext. */
export async function verifyVideoRange(url: string, length: number, ownerSignal?: AbortSignal): Promise<void> {
  if (!Number.isSafeInteger(length) || length < 1) throw new VideoStreamError('integrity', '视频文件为空或长度无效。')
  const timeout = new AbortController()
  const signal = ownerSignal ? AbortSignal.any([ownerSignal, timeout.signal]) : timeout.signal
  const timer = window.setTimeout(() => timeout.abort(), 15000)
  try {
    for (const begin of [...new Set([0, Math.max(0, length - 2)])]) {
      const end = Math.min(length - 1, begin + 1)
      const response = await fetch(url, { headers: { Range: `bytes=${begin}-${end}` }, cache: 'no-store', credentials: 'same-origin', signal })
      const valid = response.status === 206 && response.headers.get('Content-Range') === `bytes ${begin}-${end}/${length}` && response.headers.get('Content-Length') === String(end - begin + 1)
      if (!valid || !response.body) {
        await response.body?.cancel()
        throw new VideoStreamError('session', '浏览器未返回有效的分块播放响应。')
      }
      const stream = response.body.getReader()
      let received = 0
      try {
        while (true) {
          const { done, value } = await stream.read()
          if (done) break
          received += value.byteLength
          value.fill(0)
          if (received > end - begin + 1) throw new VideoStreamError('session', '浏览器返回了超出范围的视频数据。')
        }
        if (received !== end - begin + 1) throw new VideoStreamError('session', '分块播放响应不完整。')
      } finally { await stream.cancel().catch(() => undefined); stream.releaseLock() }
    }
  } catch (cause) {
    if (ownerSignal?.aborted || cause instanceof VideoStreamError) throw cause
    throw new VideoStreamError('session', timeout.signal.aborted ? '流式播放验证超时，请重试。' : '流式播放会话验证失败，请重试。', { cause })
  } finally { window.clearTimeout(timer) }
}
