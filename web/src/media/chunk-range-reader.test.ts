import { expect, test, vi } from 'vitest'
import { createChunkRangeReader } from './chunk-range-reader'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}

test('same chunk is loaded once and cancelling one consumer preserves the other', async () => {
  const response = deferred<Uint8Array>()
  let sharedSignal!: AbortSignal
  const load = vi.fn((_index: number, signal: AbortSignal) => { sharedSignal = signal; return response.promise })
  const reader = createChunkRangeReader(8, 8, load)
  const controller = new AbortController()
  const cancelled = reader.readRange(0, 4, controller.signal)
  const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
  const survivor = reader.readRange(2, 6)
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1))
  controller.abort()
  await rejected
  expect(sharedSignal.aborted).toBe(false)
  const bytes = Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7)
  response.resolve(bytes)
  expect([...await survivor]).toEqual([2, 3, 4, 5])
  expect([...await reader.readRange(6, 8)]).toEqual([6, 7])
  expect(load).toHaveBeenCalledTimes(1)
  reader.destroy()
  expect(bytes.every((byte) => byte === 0)).toBe(true)
})

test('last consumer cancellation aborts a shared load and a late buffer is zeroed', async () => {
  const late = deferred<Uint8Array>()
  let sharedSignal!: AbortSignal
  const load = vi.fn((_index: number, signal: AbortSignal) => { sharedSignal = signal; return late.promise })
  const reader = createChunkRangeReader(8, 8, load)
  const first = new AbortController()
  const second = new AbortController()
  const results = [reader.readRange(0, 2, first.signal), reader.readRange(2, 4, second.signal)]
  const settled = Promise.allSettled(results)
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1))
  first.abort(); second.abort()
  expect((await settled).every((result) => result.status === 'rejected')).toBe(true)
  expect(sharedSignal.aborted).toBe(true)
  const bytes = new Uint8Array(8).fill(9)
  late.resolve(bytes)
  await vi.waitFor(() => expect(bytes.every((byte) => byte === 0)).toBe(true))
  reader.destroy()
})

test('four-slot LRU evicts and zeroes owned buffers without corrupting copied output', async () => {
  const buffers: Uint8Array[] = []
  const load = vi.fn(async (index: number) => {
    const bytes = new Uint8Array(4).fill(index + 1)
    buffers.push(bytes)
    return bytes
  })
  const reader = createChunkRangeReader(24, 4, load)
  const firstOutput = await reader.readRange(0, 4)
  for (let index = 1; index < 6; index += 1) expect([...await reader.readRange(index * 4, index * 4 + 4)]).toEqual(Array(4).fill(index + 1))
  expect(buffers.filter((buffer) => buffer[0] !== 0)).toHaveLength(4)
  expect([...buffers[0]!]).toEqual([0, 0, 0, 0])
  expect([...firstOutput]).toEqual([1, 1, 1, 1])
  await reader.readRange(0, 1)
  expect(load).toHaveBeenCalledTimes(7)
  reader.destroy()
  expect(buffers.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true)
  await expect(reader.readRange(0, 1)).rejects.toMatchObject({ name: 'AbortError' })
})

test('distinct reads and loader work are bounded; owner cancellation drains the queue', async () => {
  const owner = new AbortController()
  let active = 0
  let peak = 0
  const load = vi.fn((_index: number, signal: AbortSignal) => new Promise<Uint8Array>((_resolve, reject) => {
    active += 1; peak = Math.max(active, peak)
    signal.addEventListener('abort', () => { active -= 1; reject(signal.reason) }, { once: true })
  }))
  const reader = createChunkRangeReader(40, 1, load, owner.signal)
  const reads = Array.from({ length: 34 }, (_, index) => reader.readRange(index, index + 1))
  const completed = Promise.allSettled(reads)
  await expect(reader.readRange(35, 36)).rejects.toThrow('Too many pending range requests')
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2))
  expect(peak).toBe(2)
  owner.abort()
  expect((await completed).every((result) => result.status === 'rejected')).toBe(true)
  await vi.waitFor(() => expect(active).toBe(0))
  expect(load).toHaveBeenCalledTimes(2)
})

test('destroy rejects in-flight reads immediately and erases a late loader result', async () => {
  const late = deferred<Uint8Array>()
  const load = vi.fn(() => late.promise)
  const reader = createChunkRangeReader(4, 4, load)
  const result = reader.readRange(0, 4)
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1))
  reader.destroy()
  await rejected
  const bytes = new Uint8Array(4).fill(7)
  late.resolve(bytes)
  await vi.waitFor(() => expect([...bytes]).toEqual([0, 0, 0, 0]))
})

test('invalid chunk length is erased and a failed load can be retried', async () => {
  const malformed = new Uint8Array(3).fill(7)
  const load = vi.fn().mockResolvedValueOnce(malformed).mockResolvedValueOnce(new Uint8Array(4).fill(2))
  const reader = createChunkRangeReader(4, 4, load)
  await expect(reader.readRange(0, 4)).rejects.toThrow('Invalid plaintext chunk length')
  expect([...malformed]).toEqual([0, 0, 0])
  expect([...await reader.readRange(0, 4)]).toEqual([2, 2, 2, 2])
  expect(load).toHaveBeenCalledTimes(2)
  reader.destroy()
})
