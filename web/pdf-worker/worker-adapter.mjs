import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../package.json', import.meta.url))
const ts = require('typescript')
export const PINNED_WORKER_SHA256 = 'df3bf6bf6b8b8dac8a4042d8c4ecf1cf21e1d197e0fe231c192122409eba656b'

export function buildSparsePDFWorker({ instrument = false } = {}) {
  const source = readFileSync(new URL('../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url), 'utf8')
  if (createHash('sha256').update(source).digest('hex') !== PINNED_WORKER_SHA256) throw new Error('PDF.js worker source drift: review sparse adaptation before rebuilding')
  const begin = source.indexOf('class ChunkedStream extends Stream {')
  const end = source.indexOf('class ChunkedStreamManager {', begin)
  if (begin < 0 || end < begin) throw new Error('PDF.js adaptation markers missing')
  const storageTS = readFileSync(new URL('./chunk-store.ts', import.meta.url), 'utf8')
  let storage = ts.transpileModule(storageTS, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText.replaceAll('export class ', 'class ')
  if (instrument) {
    storage += `\nconst originalSparsePut = SparsePDFChunkStore.prototype.put;
SparsePDFChunkStore.prototype.put = function(...args) {
  const result = originalSparsePut.apply(this,args);
  console.debug('xdrive-pdf-sparse-usage:' + JSON.stringify({...this.usage,evictedChunks:this.evictions}));
  return result;
};\n`
  }
  const adapter = readFileSync(new URL('./adapter-core.js', import.meta.url), 'utf8')
  const dense = source.slice(begin, end).replace('class ChunkedStream extends Stream', 'class DenseChunkedStream extends Stream')
  const sparse = adapter.replace('class ChunkedStream extends BaseStream', 'class SparseChunkedStream extends BaseStream')
  let output = source.slice(0, begin) + storage + dense + sparse + source.slice(end)
  const replaceOnce = (before, after) => {
    if (output.split(before).length !== 2) throw new Error('PDF.js adaptation occurrence changed')
    output = output.replace(before, after)
  }
  // This internal font hash must read its logical substream, not a full-file buffer.
  replaceOnce('new Uint8Array(stream.bytes.buffer, stream.start, stream.end - stream.start)', 'stream.getByteRange(stream.start, stream.end)')
  // DataLoaded reports length only; it must not materialize the whole sparse file.
  replaceOnce('length: stream.bytes.byteLength', 'length: stream.length')
  // <=64MiB full-data paths are permitted by IMPLEMENTATION21.1. Keep the
  // exact upstream implementation there; only large files use sparse storage.
  replaceOnce('this.stream = new ChunkedStream(this.length, this.chunkSize, this);', 'this.stream = new (this.length <= 64 * 1024 * 1024 ? DenseChunkedStream : SparseChunkedStream)(this.length, this.chunkSize, this);')
  // Keep manager-generated repair ranges within the page RangeReader limit.
  replaceOnce('if (prevChunk >= 0 && prevChunk + 1 !== chunk) {', 'if (prevChunk >= 0 && (prevChunk + 1 !== chunk || chunk - beginChunk >= Math.max(1, Math.floor(16 * 1024 * 1024 / this.chunkSize)))) {')
  replaceOnce('requestAllChunks(noFetch = false) {\n    if (!noFetch)', 'requestAllChunks(noFetch = false) {\n    if (!noFetch && this.stream.store && this.length > this.stream.store.maxReadBytes) return Promise.reject(new RangeError("Large PDF complete-data repair is unsupported; download the original file"));\n    if (!noFetch)')
  replaceOnce('this.#aborted = true;\n    this.pdfStream?.cancelAllRequests(reason);', 'this.#aborted = true;\n    this.stream.store?.close();\n    this.pdfStream?.cancelAllRequests(reason);')
  return { source: output, upstreamSha256: PINNED_WORKER_SHA256, sha256: createHash('sha256').update(output).digest('hex') }
}
