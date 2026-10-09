import type { ThumbnailReference } from './thumbnail-schema'
export interface ThumbnailIdentity { readonly fileId: string; readonly thumbnail: ThumbnailReference }
interface Waiting { grant(): void; signal: AbortSignal; abort(): void }
interface Cached { url: string; bytes: number }
export class ThumbnailCache {
 #read: (entry: ThumbnailIdentity, signal: AbortSignal) => Promise<Blob>
 #owner = new AbortController()
 #closed = true
 #active = 0
 #waiting: Waiting[] = []
 #cache = new Map<string, Cached>()
 #bytes = 0
 readonly maxEntries: number
 readonly maxBytes: number
 constructor(read: (entry: ThumbnailIdentity, signal: AbortSignal) => Promise<Blob>, maxEntries = 64, maxBytes = 8 * 1024 * 1024) { this.#read = read; this.maxEntries = maxEntries; this.maxBytes = maxBytes; if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('Invalid thumbnail cache bounds') }
 open() { if (!this.#closed) return; this.#owner = new AbortController(); this.#closed = false }
 dispose() { this.#closed = true; this.#owner.abort(); for (const item of this.#cache.values()) URL.revokeObjectURL(item.url); this.#cache.clear(); this.#bytes = 0 }
 get stats() { return { active: this.#active, queued: this.#waiting.length, entries: this.#cache.size, bytes: this.#bytes, closed: this.#closed } }
 #drain() { while (this.#active < 6 && this.#waiting.length) { const next = this.#waiting.shift()!; if (!next.signal.aborted) next.grant() } }
 #acquire(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
   const waiting: Waiting = { signal, grant: () => { signal.removeEventListener('abort', waiting.abort); this.#active++; let released = false; resolve(() => { if (released) return; released = true; this.#active--; this.#drain() }) }, abort: () => { const index = this.#waiting.indexOf(waiting); if (index >= 0) this.#waiting.splice(index, 1); reject(signal.reason) } }
   if (this.#active < 6) waiting.grant()
   else { this.#waiting.push(waiting); signal.addEventListener('abort', waiting.abort, { once: true }) }
  })
 }
 async load(entry: ThumbnailIdentity, caller: AbortSignal): Promise<string> {
  if (this.#closed) throw new DOMException('Thumbnail owner closed', 'AbortError')
  caller.throwIfAborted()
  const key = `${entry.fileId}:${entry.thumbnail.keyVersion ?? 1}:${entry.thumbnail.objectId}:${entry.thumbnail.sha256}:${entry.thumbnail.sizeBytes}:${entry.thumbnail.width}:${entry.thumbnail.height}`
  const peek = () => { const item = this.#cache.get(key); if (item) { this.#cache.delete(key); this.#cache.set(key, item); return item.url } }
  const existing = peek(); if (existing) return existing
  const owner = this.#owner, combined = new AbortController()
  const abort = () => combined.abort(new DOMException('Thumbnail cancelled', 'AbortError'))
  owner.signal.addEventListener('abort', abort, { once: true }); caller.addEventListener('abort', abort, { once: true })
  if (owner.signal.aborted || caller.aborted) abort()
  let release: (() => void) | undefined
  try {
   release = await this.#acquire(combined.signal)
   combined.signal.throwIfAborted()
   const cached = peek(); if (cached) return cached
   const blob = await this.#read(entry, combined.signal)
   combined.signal.throwIfAborted()
   if (blob.size > this.maxBytes) throw new RangeError('Thumbnail exceeds cache budget')
   while (this.#cache.size >= this.maxEntries || this.#bytes + blob.size > this.maxBytes) {
    const oldest = this.#cache.keys().next().value!
    const item = this.#cache.get(oldest)!; URL.revokeObjectURL(item.url); this.#bytes -= item.bytes; this.#cache.delete(oldest)
   }
   const url = URL.createObjectURL(blob)
   this.#cache.set(key, { url, bytes: blob.size }); this.#bytes += blob.size
   return url
  } finally { release?.(); owner.signal.removeEventListener('abort', abort); caller.removeEventListener('abort', abort) }
 }
}
