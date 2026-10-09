import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { MissingPDFChunk, SparsePDFChunkStore } from '../../pdf-worker/chunk-store'

describe('experimental sparse PDF parser storage', () => {
  it('records the installed PDF.js full-length allocation without allocating a 200 MiB buffer', () => {
    const source = readFileSync(new URL('../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url), 'utf8')
    const begin = source.indexOf('class Stream extends BaseStream {')
    const end = source.indexOf('class ChunkedStreamManager {', begin)
    expect(begin).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(begin)
    const requested: number[] = []
    class ObservedBytes extends Uint8Array {
      constructor(length: number) {
        if (length > 32 * 1024 * 1024) { requested.push(length); throw new RangeError('Observed full-document allocation') }
        super(length)
      }
    }
    const installedChunkedStream = new Function('Uint8Array', 'BaseStream', `${source.slice(begin, end)}\nreturn ChunkedStream`)(ObservedBytes, class {})
    const length = 200 * 1024 * 1024 + 37
    expect(() => new installedChunkedStream(length, 65536, {})).toThrow('Observed full-document allocation')
    expect(requested).toEqual([length])
    const candidate = new SparsePDFChunkStore(length)
    expect(candidate.usage.residentBytes).toBe(0)
    candidate.close()
  })

  it('initializes an 8 GiB logical document with zero resident bytes and reads its last chunk', () => {
    const length = 8 * 1024 ** 3 + 37
    const store = new SparsePDFChunkStore(length)
    expect(store.usage).toEqual({ residentBytes: 0, residentChunks: 0 })
    const begin = Math.floor(length / 65536) * 65536
    store.put(begin, Uint8Array.from({ length: 37 }, (_, i) => i))
    expect([...store.read(begin + 31, length)]).toEqual([31, 32, 33, 34, 35, 36])
    expect(store.usage.residentBytes).toBe(37)
    store.close()
  })

  it('refetches evicted ranges and stays within budget after thousands of scattered reads', () => {
    const store = new SparsePDFChunkStore(8 * 1024 ** 3, 64, 256, 128)
    for (let i = 0; i < 3000; i += 1) {
      const begin = i * 65536
      store.put(begin, new Uint8Array(64).fill(i % 251))
      expect(store.byte(begin + 17)).toBe(i % 251)
      expect(store.usage.residentBytes).toBeLessThanOrEqual(256)
      expect(store.usage.residentChunks).toBeLessThanOrEqual(4)
    }
    expect(() => store.read(0, 64)).toThrow(MissingPDFChunk)
    expect(store.evictions).toBe(2996)
    store.put(0, new Uint8Array(64).fill(73))
    expect([...store.read(0, 3)]).toEqual([73, 73, 73])
    store.close()
  })

  it('handles cross-chunk reads, partial tails and empty ranges exactly', () => {
    const store = new SparsePDFChunkStore(13, 4, 16, 16)
    store.put(0, Uint8Array.from({ length: 13 }, (_, i) => i))
    expect([...store.read(3, 10)]).toEqual([3, 4, 5, 6, 7, 8, 9])
    expect(store.read(13, 13).byteLength).toBe(0)
    expect(store.byte(12)).toBe(12)
    expect(store.usage.residentBytes).toBe(13)
  })

  it('preserves byte ownership and existing readers across replacement and eviction', () => {
    const store = new SparsePDFChunkStore(16, 4, 4, 4)
    const input = new Uint8Array([1, 2, 3, 4])
    store.put(0, input)
    input[0] = 99
    const output = store.read(0, 4)
    store.put(4, new Uint8Array([5, 6, 7, 8]))
    expect([...output]).toEqual([1, 2, 3, 4])
    expect([...input]).toEqual([99, 2, 3, 4])
    expect(() => store.byte(0)).toThrow(MissingPDFChunk)
  })

  it('keeps recently accessed chunks and reserves a received batch as one unit', () => {
    const store = new SparsePDFChunkStore(32, 4, 12, 12)
    store.put(0, new Uint8Array(12).fill(17))
    store.byte(0)
    store.put(12, new Uint8Array(4).fill(23))
    expect(store.has(0)).toBe(true)
    expect(store.has(1)).toBe(false)
    store.put(16, new Uint8Array(12).fill(29))
    expect([...store.read(16, 28)]).toEqual(new Array(12).fill(29))
    expect(store.usage).toEqual({ residentBytes: 12, residentChunks: 3 })
  })

  it('reports the precise first missing chunk without manufacturing zero bytes', () => {
    const store = new SparsePDFChunkStore(13, 4, 16, 16)
    store.put(0, new Uint8Array(4).fill(9))
    try { store.read(2, 13); throw new Error('Expected missing data') } catch (error) {
      expect(error).toBeInstanceOf(MissingPDFChunk)
      expect(error).toMatchObject({ begin: 4, end: 8 })
    }
    expect([...store.read(0, 2)]).toEqual([9, 9])
  })

  it('rejects malformed, unaligned and oversized data before changing resident bytes', () => {
    const store = new SparsePDFChunkStore(16, 4, 8, 8)
    store.put(0, new Uint8Array(4).fill(7))
    for (const [begin, end] of [[-1, 1], [0, 17], [NaN, 4], [0, 9], [5, 4], [0, Infinity]]) expect(() => store.read(begin, end)).toThrow(RangeError)
    expect(() => store.put(1, new Uint8Array(4))).toThrow(RangeError)
    expect(() => store.put(4, new Uint8Array(3))).toThrow(RangeError)
    expect(() => store.put(0, new Uint8Array(12))).toThrow(RangeError)
    expect([...store.read(0, 4)]).toEqual([7, 7, 7, 7])
    expect(store.usage).toEqual({ residentBytes: 4, residentChunks: 1 })
  })

  it('clears owned storage and rejects late producers after close', () => {
    const store = new SparsePDFChunkStore(16, 4, 8, 8)
    store.put(0, new Uint8Array(8).fill(41))
    store.close(); store.close()
    expect(store.usage).toEqual({ residentBytes: 0, residentChunks: 0 })
    for (const operation of [() => store.put(0, new Uint8Array(4)), () => store.read(0, 1), () => store.byte(0), () => store.has(0)]) expect(operation).toThrow(/closed/)
  })

  it('rejects invalid layouts without allocating a logical-document buffer', () => {
    for (const length of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => new SparsePDFChunkStore(length)).toThrow(RangeError)
    expect(() => new SparsePDFChunkStore(16, 0)).toThrow(RangeError)
    expect(() => new SparsePDFChunkStore(16, 8, 4, 4)).toThrow(RangeError)
    expect(() => new SparsePDFChunkStore(16, 4, 8, 12)).toThrow(RangeError)
  })
})
