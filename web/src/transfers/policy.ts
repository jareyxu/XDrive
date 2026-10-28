import { TransferGate } from './scheduler'
import { currentTransferPreferences } from '../preferences/preferences'

import { FALLBACK_CAPABILITIES, transferCeilings, type TransferCapabilities } from './limits'

let capabilities: TransferCapabilities = FALLBACK_CAPABILITIES
let confirmed = false
export function confirmedTransferCapabilities(): TransferCapabilities | null { return confirmed ? capabilities : null }
let subscribed = false
let automatic = true
function watchPreferences() {
  if (subscribed || typeof window === 'undefined' || !window.xdrivePreferences) return
  subscribed = true
  automatic = currentTransferPreferences().autoTransfer
  window.xdrivePreferences.subscribe(() => {
    const next = currentTransferPreferences().autoTransfer
    if (next !== automatic) { uploadAdaptive.reset(); downloadAdaptive.reset(); automatic = next }
    refreshGates()
  })
}
let checkedAt = 0
let check: Promise<void> | undefined
export async function refreshTransferCapabilities(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  watchPreferences()
  if (Date.now() - checkedAt < 60_000) return
  if (!check) check = (async () => {
    try {
      const response = await fetch('/api/v1/transfers/capabilities', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(5000) })
      if (!response.ok) return
      const value = await response.json() as TransferCapabilities
      if ([value.uploadConcurrency, value.downloadConcurrency].every(n => Number.isInteger(n) && n >= 1 && n <= 64)) { capabilities = value; confirmed = true; refreshGates() }
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

// Only compare windows that actually ran at the requested concurrency. A memory,
// server or workload limit must not masquerade as a failed throughput probe.
export class AdaptiveConcurrency {
  private limit = 4
  private max = 8
  private active = 0
  private idleSince: number | undefined
  private started: number | undefined
  private bytes = 0
  private previous = 0
  private probing = false
  private cooldown = 0
  private changed: () => void
  constructor(changed: () => void = () => undefined) { this.changed = changed }
  private clearWindow() { this.started = undefined; this.bytes = 0 }
  reset() {
    this.limit = Math.min(4, this.max)
    this.previous = 0; this.probing = false; this.cooldown = 0
    this.clearWindow()
  }
  value(max: number) {
    if (max !== this.max) {
      this.max = max; this.limit = Math.min(this.limit, max)
      this.previous = 0; this.probing = false; this.clearWindow()
    }
    return Math.max(1, Math.min(max, this.limit))
  }
  activity(active: number, now = performance.now()) {
    if (this.active === 0 && active > 0 && this.idleSince !== undefined && now - this.idleSince >= 30_000) this.reset()
    this.active = active
    if (active === 0) { this.idleSince = now; this.previous = 0; this.probing = false }
    if (active !== this.limit) this.clearWindow()
  }
  observe(bytes: number, now = performance.now()) {
    if (bytes <= 0 || !Number.isFinite(bytes)) return
    if (this.active !== this.limit) { this.clearWindow(); return }
    if (this.started === undefined) this.started = now
    this.bytes += bytes
    const elapsed = now - this.started
    if (elapsed < 5000) return
    const rate = this.bytes / elapsed
    const before = this.limit
    if (this.probing && rate < this.previous * 1.05) {
      this.limit = Math.max(1, this.limit - 1); this.cooldown = now + 30_000; this.probing = false
    } else if (now >= this.cooldown && this.limit < this.max) {
      this.limit++; this.probing = true
    } else { this.probing = false }
    this.previous = rate; this.clearWindow()
    if (this.limit !== before) this.changed()
  }
  congested(now = performance.now()) {
    this.limit = Math.max(1, Math.floor(this.limit / 2))
    this.cooldown = now + 30_000; this.probing = false; this.clearWindow()
    this.changed()
  }
}
export const uploadAdaptive = new AdaptiveConcurrency(() => uploadNetwork.refresh())
export const downloadAdaptive = new AdaptiveConcurrency(() => downloadNetwork.refresh())
export function transferLimit(direction: 'upload' | 'download'): number {
  const prefs = currentTransferPreferences()
  const max = transferCeilings(prefs, capabilities)[direction]
  return prefs.autoTransfer ? (direction === 'upload' ? uploadAdaptive : downloadAdaptive).value(max) : max
}
export function observeTransfer(direction: 'upload' | 'download', bytes: number) {
  if (currentTransferPreferences().autoTransfer) (direction === 'upload' ? uploadAdaptive : downloadAdaptive).observe(bytes)
}
// At most one extra chunk can be prepared ahead of the configured network slots.
// Keep the existing eight-chunk hard bound; 1–2 slot low-memory settings stay lean.
export function uploadDepth(): number {
  const max = transferCeilings(currentTransferPreferences(), capabilities).upload
  return max <= 2 ? max : Math.min(8, max + 1)
}
export const uploadBuffers = new TransferGate(uploadDepth)
export const uploadPreparation = new TransferGate(() => 1)
export const uploadNetwork = new TransferGate(() => transferLimit('upload'), 256, active => uploadAdaptive.activity(active))
export const downloadNetwork = new TransferGate(() => transferLimit('download'), 256, active => downloadAdaptive.activity(active))
export const downloadBuffers = new TransferGate(() => transferCeilings(currentTransferPreferences(), capabilities).bufferSlots)
export function downloadDepth(): number { return transferCeilings(currentTransferPreferences(), capabilities).download }
function refreshGates() {
  uploadBuffers.refresh(); downloadBuffers.refresh()
  uploadNetwork.refresh(); downloadNetwork.refresh()
}
