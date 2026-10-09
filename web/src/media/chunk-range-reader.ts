export interface ChunkRangeReader {
  readonly length: number
  readRange(begin: number, end: number, signal?: AbortSignal): Promise<Uint8Array>
  destroy(): void
}

const abortError = () => new DOMException('Range reader closed or cancelled', 'AbortError')

/** Owned loader buffers are zeroed on eviction, failure and destruction. */
export function createChunkRangeReader(
  length: number,
  chunkSize: number,
  load: ((index: number, signal: AbortSignal) => Promise<Uint8Array>) | null,
  ownerSignal?: AbortSignal,
): ChunkRangeReader {
  if (!Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new RangeError('Invalid chunk layout')
  const lifetime = new AbortController()
  const ranges = new Gate(2, 32)
  const loads = new Gate(2, 32)
  type Entry = { bytes?: Uint8Array; promise: Promise<Uint8Array>; controller: AbortController; users: number }
  const cache = new Map<number, Entry>()
  const pending = new Map<number, Entry>()
  const destroy = () => {
    if (lifetime.signal.aborted) return
    lifetime.abort(abortError())
    load = null
    ownerSignal?.removeEventListener('abort', destroy)
    pending.forEach((entry) => entry.controller.abort(abortError()))
    pending.clear()
    cache.forEach((entry) => entry.bytes?.fill(0))
    cache.clear()
  }
  ownerSignal?.addEventListener('abort', destroy, { once: true })
  if (ownerSignal?.aborted) destroy()

  const consume = async (index: number, signal: AbortSignal, copy: (bytes: Uint8Array) => void) => {
    signal.throwIfAborted()
    let entry = cache.get(index) ?? pending.get(index)
    if (!entry) {
      const controller = new AbortController()
      const created: Entry = { controller, users: 0, promise: undefined as unknown as Promise<Uint8Array> }
      created.promise = loads.run(async () => {
        let bytes: Uint8Array | undefined
        try {
          if (!load) throw abortError()
          bytes = await load(index, controller.signal)
          controller.signal.throwIfAborted()
          lifetime.signal.throwIfAborted()
          if (bytes.byteLength !== Math.min(chunkSize, length - index * chunkSize)) throw new TypeError('Invalid plaintext chunk length')
          // Consumers pin buffers until their synchronous copy finishes.
          while (cache.size >= 4) {
            const victim = [...cache].find(([, item]) => item.users === 0)
            if (!victim) throw new Error('All chunk cache slots are pinned')
            victim[1].bytes?.fill(0)
            cache.delete(victim[0])
          }
          created.bytes = bytes
          cache.set(index, created)
          bytes = undefined
          return created.bytes
        } finally {
          bytes?.fill(0)
          if (pending.get(index) === created) pending.delete(index)
        }
      }, controller.signal)
      // All consumers may cancel before the shared loader settles.
      void created.promise.catch(() => undefined)
      pending.set(index, created)
      entry = created
    }
    entry.users += 1
    try {
      const bytes = entry.bytes ?? await cancellable(entry.promise, signal)
      signal.throwIfAborted()
      lifetime.signal.throwIfAborted()
      if (cache.get(index) === entry) { cache.delete(index); cache.set(index, entry) }
      copy(bytes)
    } finally {
      entry.users -= 1
      if (entry.users === 0 && !entry.bytes) {
        entry.controller.abort(abortError())
        if (pending.get(index) === entry) pending.delete(index)
      }
    }
  }

  return {
    length,
    async readRange(begin, end, requestSignal) {
      if (Number.isSafeInteger(begin) && Number.isSafeInteger(end) && end - begin > 16 * 1024 * 1024) throw new RangeError('Range request exceeds the 16 MiB limit')
      if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end <= begin || end > length) throw new RangeError('Invalid byte range')
      const linked = linkSignals(lifetime.signal, requestSignal)
      try {
        return await ranges.run(async () => {
          // Queued calls retain offsets only, never preallocate plaintext output.
          const output = new Uint8Array(end - begin)
          try {
            for (let position = begin; position < end;) {
              linked.signal.throwIfAborted()
              const index = Math.floor(position / chunkSize)
              const offset = position - index * chunkSize
              const count = Math.min(end - position, chunkSize - offset)
              await consume(index, linked.signal, (bytes) => output.set(bytes.subarray(offset, offset + count), position - begin))
              position += count
            }
            linked.signal.throwIfAborted()
            return output
          } catch (error) { output.fill(0); throw error }
        }, linked.signal)
      } finally { linked.close() }
    },
    destroy,
  }
}

function linkSignals(...signals: (AbortSignal | undefined)[]): { signal: AbortSignal; close: () => void } {
  const controller = new AbortController()
  const listeners: (() => void)[] = []
  for (const signal of signals) {
    if (!signal) continue
    const abort = () => controller.abort(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    listeners.push(() => signal.removeEventListener('abort', abort))
    if (signal.aborted) abort()
  }
  return { signal: controller.signal, close: () => listeners.forEach((remove) => remove()) }
}

function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

class Gate {
  private active = 0
  private readonly waiting: (() => void)[] = []
  private readonly limit: number
  private readonly queueLimit: number
  constructor(limit: number, queueLimit: number) { this.limit = limit; this.queueLimit = queueLimit }
  async run<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const start = () => { signal.removeEventListener('abort', abort); this.active += 1; resolve() }
      const abort = () => {
        const index = this.waiting.indexOf(start)
        if (index >= 0) this.waiting.splice(index, 1)
        reject(signal.reason)
      }
      if (this.active < this.limit) start()
      else if (this.waiting.length >= this.queueLimit) reject(new RangeError('Too many pending range requests'))
      else { this.waiting.push(start); signal.addEventListener('abort', abort, { once: true }) }
    })
    try { signal.throwIfAborted(); return await operation() }
    finally { this.active -= 1; this.waiting.shift()?.() }
  }
}
