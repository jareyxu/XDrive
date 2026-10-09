import type { ChunkRangeReader } from './chunk-range-reader'

/** PDF.js may request many scattered page dictionaries before opening. */
export function createPDFRangeQueue(reader: ChunkRangeReader, receive: (begin: number, bytes: Uint8Array) => void, fail: (error: unknown) => void) {
  const controller = new AbortController()
  const waiting: { begin: number; end: number }[] = []
  let active = 0
  let closed = false
  const close = () => { if (!closed) { closed = true; controller.abort(); waiting.length = 0; reader.destroy() } }
  const failure = (error: unknown) => { if (!closed) { close(); fail(error) } }
  const drain = () => {
    while (!closed && active < 2 && waiting.length > 0) {
      const range = waiting.shift()!
      active += 1
      void reader.readRange(range.begin, range.end, controller.signal).then((bytes) => {
        if (closed) { bytes.fill(0); return }
        // Ownership passes to PDF.js; it may queue then transfer this buffer.
        try { receive(range.begin, bytes) } catch (error) { bytes.fill(0); throw error }
      }).catch(failure).finally(() => { active -= 1; drain() })
    }
  }
  return {
    request(begin: number, end: number) {
      if (closed) return
      if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end <= begin || end > reader.length || end - begin > 16 * 1024 * 1024) { failure(new RangeError('Invalid PDF range')); return }
      if (waiting.length >= 512) { failure(new RangeError('Too many queued PDF ranges')); return }
      waiting.push({ begin, end })
      drain()
    },
    close,
  }
}
