// XDrive bounded source storage; upstream dependency identity is checked at build time.
class ChunkedStream extends BaseStream {
  progressiveDataLength = 0;
  constructor(length, chunkSize, manager) {
    super();
    this.store = new SparsePDFChunkStore(length, chunkSize);
    this.start = this.pos = 0;
    this.end = length;
    this.dict = null;
    this.chunkSize = chunkSize;
    this.numChunks = Math.ceil(length / chunkSize);
    this.manager = manager;
  }
  get length() { return this.end - this.start; }
  get isEmpty() { return this.length === 0; }
  get bytes() { return this.store.read(0, this.store.length); }
  get _loadedChunks() { return new Set(this.store.residentIndices); }
  get numChunksLoaded() { return this.store.usage.residentChunks; }
  get isDataLoaded() { return this.getMissingChunks().length === 0; }
  getMissingChunks() {
    const missing = [];
    for (let index = Math.floor(this.start / this.chunkSize); index < Math.ceil(this.end / this.chunkSize); index++) {
      if (!this.store.has(index)) missing.push(index);
    }
    return missing;
  }
  onReceiveData(begin, chunk) { this.store.put(begin, new Uint8Array(chunk)); }
  onReceiveProgressiveData() { throw new Error('Sparse spike requires explicit Range transport'); }
  ensureByte(pos) { this.ensureRange(pos, pos + 1); }
  ensureRange(begin, end) {
    try { this.store.ensure(begin, end); }
    catch (error) {
      if (error instanceof MissingPDFChunk) throw new MissingDataException(error.begin, error.end);
      throw error;
    }
  }
  nextEmptyChunk(beginChunk) {
    for (let i = 0; i < this.numChunks; i++) {
      const chunk = (beginChunk + i) % this.numChunks;
      if (!this.store.has(chunk)) return chunk;
    }
    return null;
  }
  hasChunk(index) { return this.store.has(index); }
  getByte() {
    if (this.pos >= this.end) return -1;
    this.ensureByte(this.pos);
    return this.store.byte(this.pos++);
  }
  getBytes(length) {
    const begin = this.pos;
    const end = !length ? this.end : Math.min(begin + length, this.end);
    this.ensureRange(begin, end);
    const output = this.store.read(begin, end);
    this.pos = end;
    return output;
  }
  getByteRange(begin, end) {
    begin = Math.max(0, begin);
    end = Math.min(this.end, end);
    this.ensureRange(begin, end);
    return this.store.read(begin, end);
  }
  reset() { this.pos = this.start; }
  moveStart() { this.start = this.pos; }
  makeSubStream(start, length, dict = null) {
    if (length) this.ensureRange(start, start + length);
    else this.ensureByte(start);
    const stream = Object.create(this);
    stream.start = stream.pos = start;
    stream.end = start + length || this.end;
    stream.dict = dict;
    return stream;
  }
  clone() {
    const stream = Object.create(this);
    stream.pos = stream.start;
    stream.dict = this.dict?.clone();
    return stream;
  }
  getBaseStreams() { return [this]; }
}
