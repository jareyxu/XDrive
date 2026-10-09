import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { MissingPDFChunk, SparsePDFChunkStore } from '../../pdf-worker/chunk-store'
import { buildSparsePDFWorker } from '../../pdf-worker/worker-adapter.mjs'

class MissingData extends Error {
  readonly begin: number
  readonly end: number
  constructor(begin: number, end: number) { super('Missing data'); this.begin = begin; this.end = end }
}

function adapterClass() {
  const source = readFileSync(new URL('../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url), 'utf8')
  const baseBegin = source.indexOf('class BaseStream {')
  const baseEnd = source.indexOf(';// ./src/shared/css_utils.js', baseBegin)
  expect(baseBegin).toBeGreaterThan(0)
  expect(baseEnd).toBeGreaterThan(baseBegin)
  const adapter = readFileSync(new URL('../../pdf-worker/adapter-core.js', import.meta.url), 'utf8')
  return new Function('SparsePDFChunkStore', 'MissingPDFChunk', 'MissingDataException', `${source.slice(baseBegin, baseEnd)}\n${adapter}\nreturn ChunkedStream`)(SparsePDFChunkStore, MissingPDFChunk, MissingData)
}

describe('version-pinned experimental PDF.js sparse adapter', () => {
  it('builds deterministically, retains the upstream license and replaces only reviewed hooks', () => {
    const first = buildSparsePDFWorker()
    expect(buildSparsePDFWorker().sha256).toBe(first.sha256)
    expect(first.source).toContain('Apache License')
    expect(first.source).toContain('class SparseChunkedStream extends BaseStream')
    expect(first.source).toContain('class DenseChunkedStream extends Stream')
    expect(first.source).toContain('this.length <= 64 * 1024 * 1024 ? DenseChunkedStream : SparseChunkedStream')
    expect(first.source).toContain('length: stream.length')
    expect(first.source).toContain('this.stream.store?.close();')
    expect(first.source).not.toContain('xdrive-pdf-sparse-usage:')
    expect(buildSparsePDFWorker({ instrument: true }).source).toContain('xdrive-pdf-sparse-usage:')
  })

  it('keeps the parser cursor unchanged on missing data and advances only after a valid copy', () => {
    const Stream = adapterClass()
    const stream = new Stream(13, 4, {})
    stream.pos = 3
    expect(() => stream.getBytes(7)).toThrow(MissingData)
    expect(stream.pos).toBe(3)
    stream.onReceiveData(0, Uint8Array.from({ length: 13 }, (_, i) => i).buffer)
    expect([...stream.getBytes(7)]).toEqual([3, 4, 5, 6, 7, 8, 9])
    expect(stream.pos).toBe(10)
    expect(stream.getByte()).toBe(10)
    expect(stream.peekByte()).toBe(11)
    expect(stream.pos).toBe(11)
    stream.pos = 13
    expect(stream.getByte()).toBe(-1)
  })

  it('shares storage among independent substream and clone cursors', () => {
    const Stream = adapterClass()
    const root = new Stream(13, 4, {})
    root.onReceiveData(0, Uint8Array.from({ length: 13 }, (_, i) => i).buffer)
    const dict = { clone: () => ({ copied: true }) }
    const sub = root.makeSubStream(3, 7, dict)
    expect([...sub.getBytes(2)]).toEqual([3, 4])
    expect(root.pos).toBe(0)
    const clone = sub.clone()
    expect(clone.pos).toBe(3)
    expect(clone.dict).toEqual({ copied: true })
    expect(clone.getByte()).toBe(3)
    expect(sub.pos).toBe(5)
    // ObjectLoader requests each base stream's bounds. Returning root here
    // would turn a small image/resource substream into a whole-file request.
    expect(sub.getBaseStreams()).toEqual([sub])
    expect(sub.isDataLoaded).toBe(true)
    root.store.close()
    expect(() => clone.getByte()).toThrow(/closed/)
  })

  it('does not retain a successful-byte shortcut after eviction; retry gets exact missing offsets', () => {
    const Stream = adapterClass()
    const stream = new Stream(16, 4, {})
    stream.store = new SparsePDFChunkStore(16, 4, 4, 4)
    stream.onReceiveData(0, new Uint8Array([1, 2, 3, 4]).buffer)
    expect(stream.getByte()).toBe(1)
    stream.onReceiveData(4, new Uint8Array([5, 6, 7, 8]).buffer)
    stream.pos = 1
    try { stream.getByte(); throw new Error('Expected missing data') } catch (error) { expect(error).toBeInstanceOf(MissingData); expect(error).toMatchObject({ begin: 0, end: 4 }) }
    expect(stream.pos).toBe(1)
    stream.onReceiveData(0, new Uint8Array([1, 2, 3, 4]).buffer)
    expect(stream.getByte()).toBe(2)
    expect(stream.hasChunk(1)).toBe(false)
  })

  it('clips byte ranges without moving cursors and reports substream missing chunks', () => {
    const Stream = adapterClass()
    const stream = new Stream(13, 4, {})
    stream.onReceiveData(0, new Uint8Array([1, 2, 3, 4]).buffer)
    expect([...stream.getByteRange(-4, 3)]).toEqual([1, 2, 3])
    expect(stream.pos).toBe(0)
    expect(stream.getMissingChunks()).toEqual([1, 2, 3])
    expect(stream.nextEmptyChunk(3)).toBe(3)
    const sub = stream.makeSubStream(1)
    expect(sub.getMissingChunks()).toEqual([1, 2, 3])
    expect(sub.isDataLoaded).toBe(false)
  })
})
