import { describe, expect, it } from 'vitest'
import { MissingPDFChunk, SparsePDFChunkStore } from '../../pdf-worker/chunk-store'
import { buildSparsePDFWorker } from '../../pdf-worker/worker-adapter.mjs'

class MissingData extends Error {
  readonly begin: number
  readonly end: number
  constructor(begin: number, end: number) { super('Missing data'); this.begin = begin; this.end = end }
}

function hybridClasses(bytes: new (length: number) => Uint8Array = Uint8Array) {
  const source = buildSparsePDFWorker().source
  const extract = (begin: string, end: string) => {
    const start = source.indexOf(begin)
    const stop = source.indexOf(end, start)
    expect(start).toBeGreaterThan(0); expect(stop).toBeGreaterThan(start)
    return source.slice(start, stop)
  }
  const base = extract('class BaseStream {', ';// ./src/shared/css_utils.js')
  const plain = extract('class Stream extends BaseStream {', ';// ./src/core/chunked_stream.js')
  const dense = extract('class DenseChunkedStream extends Stream {', '// XDrive bounded source storage')
  const sparse = extract('class SparseChunkedStream extends BaseStream {', 'class ChunkedStreamManager {')
  const manager = extract('class ChunkedStreamManager {', ';// ./src/shared/image_utils.js')
  return new Function('Uint8Array', 'SparsePDFChunkStore', 'MissingPDFChunk', 'MissingDataException', 'MathClamp', `${base}\n${plain}\n${dense}\n${sparse}\n${manager}\nreturn {ChunkedStreamManager,DenseChunkedStream,SparseChunkedStream}`)(bytes, SparsePDFChunkStore, MissingPDFChunk, MissingData, (value: number, low: number, high: number) => Math.min(high, Math.max(low, value)))
}
const args = (length: number) => ({ length, rangeChunkSize: 4, disableAutoFetch: true, msgHandler: { send() {} } })

describe('experimental PDF manager dense/sparse compatibility', () => {
  it('splits complete-data repair into bounded ranges without holes or duplicate chunks', () => {
    const { ChunkedStreamManager } = hybridClasses()
    const manager = new ChunkedStreamManager({}, { ...args(64 * 1024 * 1024 + 1), rangeChunkSize: 65536 })
    const groups = manager.groupChunks(Array.from({ length: 1025 }, (_, index) => index))
    expect(groups).toEqual([{ beginChunk: 0, endChunk: 256 }, { beginChunk: 256, endChunk: 512 }, { beginChunk: 512, endChunk: 768 }, { beginChunk: 768, endChunk: 1024 }, { beginChunk: 1024, endChunk: 1025 }])
    expect(manager.groupChunks([0, 1, 5, 6])).toEqual([{ beginChunk: 0, endChunk: 2 }, { beginChunk: 5, endChunk: 7 }])
    manager.stream.store.close()
  })

  it('preserves upstream progressive and complete-data behavior for an ordinary PDF', async () => {
    const { ChunkedStreamManager, DenseChunkedStream } = hybridClasses()
    const manager = new ChunkedStreamManager({ cancelAllRequests() {} }, args(13))
    expect(manager.stream).toBeInstanceOf(DenseChunkedStream)
    expect(manager.stream.store).toBeUndefined()
    manager.onReceiveData({ chunk: new Uint8Array([1, 2, 3]).buffer })
    expect(manager.stream.progressiveDataLength).toBe(3)
    expect(manager.stream.getByte()).toBe(1)
    manager.onReceiveData({ chunk: new Uint8Array([4, 5, 6, 7, 8, 9, 10, 11, 12, 13]).buffer })
    const full = await manager.requestAllChunks()
    expect([...full.bytes]).toEqual(Array.from({ length: 13 }, (_, i) => i + 1))
    manager.abort(new Error('Closed'))
  })

  it('selects dense through the exact64MiB boundary and avoids a full allocation above it', () => {
    const allocations: number[] = []
    class ObservedBytes extends Uint8Array {
      constructor(length: number) {
        if (typeof length === 'number' && length > 1024 * 1024) { allocations.push(length); throw new RangeError('Observed dense allocation') }
        super(length)
      }
    }
    const { ChunkedStreamManager, SparseChunkedStream } = hybridClasses(ObservedBytes)
    const threshold = 64 * 1024 * 1024
    for (const length of [threshold - 1, threshold]) expect(() => new ChunkedStreamManager({}, args(length))).toThrow('Observed dense allocation')
    const manager = new ChunkedStreamManager({}, { ...args(threshold + 1), rangeChunkSize: 65536 })
    expect(manager.stream).toBeInstanceOf(SparseChunkedStream)
    expect(manager.stream.store.usage.residentBytes).toBe(0)
    expect(allocations).toEqual([threshold - 1, threshold])
    manager.stream.store.close()
  })

  it('rejects large complete-data repair without dispatching a full-file download and clears sparse storage on abort', async () => {
    const { ChunkedStreamManager } = hybridClasses()
    let cancelled = 0
    const manager = new ChunkedStreamManager({ getRangeReader() { throw new Error('Unexpected full-file fetch') }, cancelAllRequests() { cancelled += 1 } }, { ...args(200 * 1024 * 1024), rangeChunkSize: 65536 })
    const waiting = manager.requestAllChunks(true).catch(() => undefined)
    await expect(manager.requestAllChunks()).rejects.toThrow('complete-data repair is unsupported')
    manager.stream.onReceiveData(0, new Uint8Array(65536).fill(41).buffer)
    expect(manager.stream.store.usage.residentBytes).toBe(65536)
    manager.abort(new Error('Closed'))
    await waiting
    expect(cancelled).toBe(1)
    expect(manager.stream.store.usage.residentBytes).toBe(0)
    expect(() => manager.stream.getByte()).toThrow(/closed/)
  })
})
