import { TransferGate } from './scheduler'
import { currentTransferPreferences } from '../preferences/preferences'

export interface TransferCapabilities { uploadConcurrency: number; downloadConcurrency: number }
let capabilities: TransferCapabilities = { uploadConcurrency: 4, downloadConcurrency: 4 }
let checkedAt = 0
let check: Promise<void> | undefined
export async function refreshTransferCapabilities(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (Date.now() - checkedAt < 60_000) return
  if (!check) check = (async () => {
    try {
      const response = await fetch('/api/v1/transfers/capabilities', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(5000) })
      if (!response.ok) return
      const value = await response.json() as TransferCapabilities
      if ([value.uploadConcurrency, value.downloadConcurrency].every(n => Number.isInteger(n) && n >= 1 && n <= 64)) capabilities = value
    } catch { /* Older servers and offline starts keep conservative limits. */ }
    finally { checkedAt = Date.now(); check = undefined }
  })()
  if (!signal) { await check; return }
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    void check!.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    if (signal.aborted) abort()
  })
}

// Observe aggregate wire throughput in multi-second windows, never per-request speed.
export class AdaptiveConcurrency {
  private limit = 2
  private started = 0
  private bytes = 0
  private previous = 0
  private probing = false
  private cooldown = 0
  value(max: number) { return Math.max(1, Math.min(max, this.limit)) }
  observe(bytes: number, now = performance.now()) {
    if (!this.started) this.started = now
    this.bytes += bytes
    const elapsed = now - this.started
    if (elapsed < 5000) return
    const rate = this.bytes / elapsed
    if (this.probing && rate < this.previous * 1.05) { this.limit = Math.max(1, this.limit - 1); this.cooldown = now + 30_000; this.probing = false }
    else if (now >= this.cooldown && this.limit < 8) { this.limit++; this.probing = true }
    this.previous = rate; this.bytes = 0; this.started = now
  }
  congested(now = performance.now()) { this.limit = Math.max(1, Math.floor(this.limit / 2)); this.cooldown = now + 30_000; this.probing = false; this.bytes = 0; this.started = now }
}
export const uploadAdaptive = new AdaptiveConcurrency()
export const downloadAdaptive = new AdaptiveConcurrency()
export function transferLimit(direction: 'upload' | 'download'): number {
  const prefs = currentTransferPreferences()
  const max = Math.min(direction === 'upload' ? prefs.uploadConcurrency : prefs.downloadConcurrency, direction === 'upload' ? capabilities.uploadConcurrency : capabilities.downloadConcurrency)
  return prefs.autoTransfer ? (direction === 'upload' ? uploadAdaptive : downloadAdaptive).value(max) : max
}
export const uploadPipeline = new TransferGate(() => transferLimit('upload'))
export const uploadNetwork = new TransferGate(() => transferLimit('upload'))
export const downloadNetwork = new TransferGate(() => transferLimit('download'))
// Each admitted chunk allows for ciphertext, plaintext, copy and crypto scratch.
export const downloadBuffers = new TransferGate(() => Math.max(1, Math.floor(currentTransferPreferences().downloadMemoryMiB / 32)))
export function downloadDepth(): number { return Math.min(8, currentTransferPreferences().downloadConcurrency, Math.max(1, Math.floor(currentTransferPreferences().downloadMemoryMiB / 32))) }
