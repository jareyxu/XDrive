import { controlledRelayWorker } from '../sw/controller'
import { createEncryptedRangeReader } from '../api/client'
import type { DriveEntry, UnlockedVault } from '../api/client'

const WINDOW_BYTES = 1024 * 1024

export interface VideoRangeSession {
  readonly url: string
  cancelPendingReads(): void
  close(): void
}

export function supportsVideoRange(userAgent = navigator.userAgent, secureContext = isSecureContext, hasServiceWorker = 'serviceWorker' in navigator, touchPoints = navigator.maxTouchPoints): boolean {
  const desktopIPadOS = /Macintosh/u.test(userAgent) && touchPoints > 1
  return secureContext && hasServiceWorker && !/(?:Firefox|FxiOS)\//u.test(userAgent) && !/(?:Mobile|Android|iPhone|iPad)/u.test(userAgent) && !desktopIPadOS
}

function randomSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}


export async function createVideoRangeSession(vault: UnlockedVault, entry: DriveEntry, signal?: AbortSignal): Promise<VideoRangeSession> {
  if (entry.kind !== 'file' || !(entry.mime ?? '').startsWith('video/')) throw new TypeError('只能为视频文件建立播放会话。')
  if (signal?.aborted) throw new DOMException('Video setup cancelled', 'AbortError')
  const worker = await controlledRelayWorker(signal)
  const reader = await createEncryptedRangeReader(vault, entry, signal)
  if (signal?.aborted) { reader.destroy(); throw new DOMException('Video setup cancelled', 'AbortError') }
  const sessionId = randomSessionId()
  const channel = new MessageChannel()
  const reads = new Map<number, AbortController>()
  let closed = false
  let registered = false
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
    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end <= begin || end > reader.length || end - begin > WINDOW_BYTES || reads.has(readId)) {
      channel.port1.postMessage({ type: 'read-result', readId, error: 'invalid_range' })
      return
    }
    const controller = new AbortController()
    reads.set(readId, controller)
    void reader.readRange(begin, end, controller.signal).then((bytes) => {
      if (closed || controller.signal.aborted) { bytes.fill(0); return }
      channel.port1.postMessage({ type: 'read-result', readId, bytes }, [bytes.buffer as ArrayBuffer])
    }).catch(() => {
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
    return { url: `/__xdrive_media/${sessionId}`, cancelPendingReads, close }
  } catch (error) {
    close()
    throw error
  } finally {
    window.clearTimeout(timeout)
  }
}
