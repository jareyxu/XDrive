/** Bounded source storage for the version-reviewed PDF.js Worker. */
export class MissingPDFChunk extends Error {
  readonly begin: number
  readonly end: number
  constructor(begin: number, end: number) {
    super('PDF range is not resident')
    this.name = 'MissingPDFChunk'
    this.begin = begin
    this.end = end
  }
}

export class SparsePDFChunkStore {
  readonly length: number
  readonly chunkSize: number
  readonly budgetBytes: number
  readonly maxReadBytes: number
  private readonly chunks = new Map<number, Uint8Array>()
  private residentBytes = 0
  private evictedChunks = 0
  private closed = false

  constructor(length: number, chunkSize = 65536, budgetBytes = 32 * 1024 * 1024, maxReadBytes = 16 * 1024 * 1024) {
    for (const value of [length, chunkSize, budgetBytes, maxReadBytes]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Invalid PDF storage layout')
    }
    if (chunkSize < 1 || budgetBytes < chunkSize || maxReadBytes < 1 || maxReadBytes > budgetBytes) throw new RangeError('Invalid PDF storage budget')
    this.length = length
    this.chunkSize = chunkSize
    this.budgetBytes = budgetBytes
    this.maxReadBytes = maxReadBytes
  }

  get usage() { return { residentBytes: this.residentBytes, residentChunks: this.chunks.size } }

  get residentIndices() { this.alive(); return [...this.chunks.keys()] }

  get evictions() { return this.evictedChunks }

  private alive() {
    if (this.closed) throw new DOMException('PDF storage closed', 'AbortError')
  }

  private range(begin: number, end: number) {
    this.alive()
    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end < begin || end > this.length) throw new RangeError('Invalid PDF range')
    if (end - begin > this.maxReadBytes) throw new RangeError('PDF contiguous read exceeds budget')
  }

  has(index: number) {
    this.alive()
    return this.chunks.has(index)
  }

  /** Copy received data; callers retain ownership. Reject before any mutation. */
  put(begin: number, bytes: Uint8Array) {
    const end = begin + bytes.byteLength
    this.range(begin, end)
    if (begin % this.chunkSize !== 0 || (end % this.chunkSize !== 0 && end !== this.length)) throw new RangeError('Unaligned PDF chunk')
    if (bytes.byteLength === 0) return
    const first = begin / this.chunkSize
    const last = Math.ceil(end / this.chunkSize)
    let required = 0
    for (let index = first; index < last; index += 1) required += Math.min(this.chunkSize, this.length - index * this.chunkSize)
    if (required > this.budgetBytes) throw new RangeError('PDF receive exceeds resident budget')
    // Reserve the whole batch so its early chunks cannot evict each other.
    for (let index = first; index < last; index += 1) this.remove(index)
    for (const index of this.chunks.keys()) {
      if (this.residentBytes + required <= this.budgetBytes) break
      this.evictedChunks += 1
      this.remove(index)
    }
    for (let index = first; index < last; index += 1) {
      const offset = index * this.chunkSize - begin
      const owned = bytes.slice(offset, Math.min(offset + this.chunkSize, bytes.byteLength))
      this.chunks.set(index, owned)
      this.residentBytes += owned.byteLength
    }
  }

  /** Check the whole range before advancing a parser cursor or allocating output. */
  ensure(begin: number, end: number) {
    this.range(begin, end)
    if (begin === end) return
    const last = Math.ceil(end / this.chunkSize)
    for (let index = Math.floor(begin / this.chunkSize); index < last; index += 1) {
      if (!this.chunks.has(index)) throw new MissingPDFChunk(index * this.chunkSize, Math.min((index + 1) * this.chunkSize, this.length))
    }
    for (let index = Math.floor(begin / this.chunkSize); index < last; index += 1) {
      const bytes = this.chunks.get(index)!
      this.chunks.delete(index)
      this.chunks.set(index, bytes)
    }
  }

  byte(position: number) {
    this.ensure(position, position + 1)
    return this.chunks.get(Math.floor(position / this.chunkSize))![position % this.chunkSize]
  }

  read(begin: number, end: number) {
    this.ensure(begin, end)
    const output = new Uint8Array(end - begin)
    for (let position = begin; position < end;) {
      const index = Math.floor(position / this.chunkSize)
      const offset = position % this.chunkSize
      const count = Math.min(end - position, this.chunkSize - offset)
      output.set(this.chunks.get(index)!.subarray(offset, offset + count), position - begin)
      position += count
    }
    return output
  }

  private remove(index: number) {
    const bytes = this.chunks.get(index)
    if (!bytes) return
    bytes.fill(0)
    this.residentBytes -= bytes.byteLength
    this.chunks.delete(index)
  }

  close() {
    if (this.closed) return
    for (const index of this.chunks.keys()) this.remove(index)
    this.closed = true
  }
}
