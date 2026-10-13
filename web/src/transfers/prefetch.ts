import type { ChunkRangeReader } from '../media/chunk-range-reader'
import type { TransferGate } from './scheduler'

/** Ordered, bounded lookahead. Ownership of yielded buffers passes to the consumer. */
export async function* prefetchChunks(reader: ChunkRangeReader, chunkSize: number, depth: number, gate: TransferGate, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new RangeError('Invalid chunk size')
  if (!Number.isInteger(depth) || depth < 1 || depth > 8) throw new RangeError('Invalid prefetch depth')
  const lifetime = new AbortController()
  const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
  type Slot = { bytes: Uint8Array; release: () => void }
  type Outcome = { slot: Slot } | { error: unknown }
  const pending: Promise<Outcome>[] = []
  const owned = new Set<Slot>()
  const discard = () => { for (const slot of owned) { slot.bytes.fill(0); slot.release() }; owned.clear() }
  combined.addEventListener('abort', discard, { once: true })
  let offset = 0
  const fill = () => {
    while (pending.length < depth && offset < reader.length) {
      const begin = offset
      offset = Math.min(reader.length, offset + chunkSize)
      const end = offset
      pending.push((async (): Promise<Outcome> => {
        let release: (() => void) | undefined
        let bytes: Uint8Array | undefined
        try {
          release = await gate.acquire(combined)
          combined.throwIfAborted()
          bytes = await reader.readRange(begin, end, combined)
          combined.throwIfAborted()
          const slot = { bytes, release }
          owned.add(slot)
          return { slot }
        } catch (error) { bytes?.fill(0); release?.(); lifetime.abort(error); return { error } }
      })())
    }
  }
  try {
    fill()
    while (pending.length) {
      const result = await pending.shift()!
      if ('error' in result) throw result.error
      try {
        if (combined.aborted) { result.slot.bytes.fill(0); combined.throwIfAborted() }
        // Do not refill until the consumer has finished with this buffer.
        owned.delete(result.slot)
        yield result.slot.bytes
      } finally { result.slot.release() }
      fill()
    }
  } finally {
    lifetime.abort()
    discard()
    combined.removeEventListener('abort', discard)
    for (const result of await Promise.all(pending)) if ('slot' in result) { result.slot.bytes.fill(0); result.slot.release() }
  }
}
