import { expect, test, vi } from 'vitest'
import { prefetchChunks } from './prefetch'
import { TransferGate } from './scheduler'
import { createChunkRangeReader } from '../media/chunk-range-reader'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test('out-of-order loads emit in order; a slow sink bounds lookahead and zeroes discarded buffers', async () => {
  const gates = Array.from({ length: 5 }, () => deferred())
  const loaded: number[] = []
  const original: Uint8Array[] = []
  const reader = createChunkRangeReader(20, 4, async index => {
    loaded.push(index); await gates[index]!.promise
    const bytes = new Uint8Array(4).fill(index + 1); original.push(bytes); return bytes
  }, undefined, { cacheChunks: 0, concurrency: 4 })
  const chunks = prefetchChunks(reader, 4, 2, new TransferGate(() => 2))
  const first = chunks.next()
  await vi.waitFor(() => expect(loaded).toEqual([0, 1]))
  gates[1]!.resolve(); gates[0]!.resolve()
  expect((await first).value).toEqual(new Uint8Array(4).fill(1))
  expect(loaded).toEqual([0, 1])
  expect(original.every(bytes => bytes.every(value => value === 0))).toBe(true)
  await chunks.return(undefined)
  reader.destroy()
})

test('failed verification rejects and aborts other in-flight loaders', async () => {
  const fail = deferred()
  let cancelled = false
  const reader = createChunkRangeReader(12, 4, async (index, signal) => {
    if (index === 0) { await fail.promise; throw new Error('integrity failure') }
    return new Promise((_, reject) => signal.addEventListener('abort', () => { cancelled = true; reject(signal.reason) }, { once: true }))
  }, undefined, { cacheChunks: 0, concurrency: 2 })
  const chunks = prefetchChunks(reader, 4, 2, new TransferGate(() => 2))
  const first = chunks.next()
  await new Promise(resolve => setTimeout(resolve, 5))
  fail.resolve()
  await expect(first).rejects.toThrow('integrity failure')
  expect(cancelled).toBe(true)
  reader.destroy()
})

test('shared admission is FIFO and cancelled waiters do not block later tasks', async () => {
  const gate = new TransferGate(() => 1)
  const release = await gate.acquire()
  const controller = new AbortController()
  const cancelled = gate.acquire(controller.signal)
  const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
  let admitted = false
  const next = gate.run(async () => { admitted = true })
  controller.abort(); await rejected
  expect(admitted).toBe(false)
  release(); await next
  expect(admitted).toBe(true)
})

test('early iterator return clears unused plaintext and returns all global slots', async () => {
  const buffers: Uint8Array[] = []
  const reader = { length: 12, destroy() {}, async readRange(begin: number) { const bytes = new Uint8Array(4).fill(begin + 1); buffers.push(bytes); return bytes } }
  const gate = new TransferGate(() => 2)
  const chunks = prefetchChunks(reader, 4, 2, gate)
  const first = await chunks.next()
  await chunks.return(undefined)
  expect(buffers[1]).toEqual(new Uint8Array(4))
  expect(first.value).toEqual(new Uint8Array(4).fill(1)) // consumer owns yielded bytes
  const release = await gate.acquire(); release()
})

test('lock immediately clears prefetched buffers even while the sink is stalled', async () => {
  const buffers: Uint8Array[] = []
  const owner = new AbortController()
  const reader = { length: 12, destroy() {}, async readRange() { const bytes = new Uint8Array(4).fill(9); buffers.push(bytes); return bytes } }
  const gate = new TransferGate(() => 2)
  const chunks = prefetchChunks(reader, 4, 2, gate, owner.signal)
  const first = await chunks.next()
  expect(buffers[1]![0]).toBe(9)
  owner.abort()
  expect(buffers[1]).toEqual(new Uint8Array(4))
  first.value?.fill(0)
  await chunks.return(undefined)
})

test('a later corrupt chunk immediately aborts a stalled earlier read', async () => {
  const failure = new Error('bad authenticated chunk')
  let aborted = false
  const reader = {
    length: 8, destroy() {},
    async readRange(begin: number, _end: number, signal?: AbortSignal): Promise<Uint8Array> {
      if (begin === 4) throw failure
      return new Promise((_, reject) => signal!.addEventListener('abort', () => { aborted = true; reject(signal!.reason) }, { once: true }))
    },
  }
  const chunks = prefetchChunks(reader, 4, 2, new TransferGate(() => 2))
  await expect(chunks.next()).rejects.toBe(failure)
  expect(aborted).toBe(true)
})
