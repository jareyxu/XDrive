/** FIFO admission. Queued operations hold no buffers; cancellation removes them. */
export class TransferGate {
  private active = 0
  private waiting: { start: () => void; signal?: AbortSignal; abort: () => void }[] = []
  private limit: () => number
  private queueLimit: number
  constructor(limit: () => number, queueLimit = 256) { this.limit = limit; this.queueLimit = queueLimit }
  acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      const item = {
        signal,
        start: () => {
          signal?.removeEventListener('abort', item.abort)
          this.active++
          let released = false
          resolve(() => { if (!released) { released = true; this.active--; this.drain() } })
        },
        abort: () => { this.waiting = this.waiting.filter(value => value !== item); reject(signal?.reason); this.drain() },
      }
      if (this.waiting.length >= this.queueLimit) { reject(new RangeError('Too many queued transfers')); return }
      this.waiting.push(item)
      signal?.addEventListener('abort', item.abort, { once: true })
      this.drain()
    })
  }
  private drain() {
    while (this.active < this.limit() && this.waiting.length) this.waiting.shift()!.start()
  }
  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal)
    try { signal?.throwIfAborted(); return await operation() } finally { release() }
  }
}
