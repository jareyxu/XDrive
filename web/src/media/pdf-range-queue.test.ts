import { expect, test, vi } from 'vitest'
import { createPDFRangeQueue } from './pdf-range-queue'

test('a scattered PDF metadata burst is queued with two readers and intact ownership transfer', async () => {
  let active = 0
  let peak = 0
  const received: Uint8Array[] = []
  const readRange = vi.fn(async (begin: number) => {
    active += 1; peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 1))
    active -= 1
    return Uint8Array.of(begin)
  })
  const destroyed = vi.fn()
  const fail = vi.fn()
  const queue = createPDFRangeQueue({ length: 100, readRange, destroy: destroyed }, (_begin, bytes) => received.push(bytes), fail)
  for (let index = 0; index < 100; index += 1) queue.request(index, index + 1)
  await vi.waitFor(() => expect(received).toHaveLength(100))
  expect(peak).toBe(2)
  expect(received.map((bytes) => bytes[0])).toEqual(Array.from({ length: 100 }, (_, index) => index))
  expect(fail).not.toHaveBeenCalled()
  queue.close()
  expect(destroyed).toHaveBeenCalledTimes(1)
})

test('closing aborts active reads, drops queued descriptors and erases late results', async () => {
  const complete: ((bytes: Uint8Array) => void)[] = []
  const signals: AbortSignal[] = []
  const readRange = vi.fn((_begin: number, _end: number, signal?: AbortSignal) => new Promise<Uint8Array>((resolve) => { complete.push(resolve); signals.push(signal!) }))
  const receive = vi.fn()
  const fail = vi.fn()
  const queue = createPDFRangeQueue({ length: 100, readRange, destroy: vi.fn() }, receive, fail)
  for (let index = 0; index < 100; index += 1) queue.request(index, index + 1)
  queue.close()
  expect(signals.every((signal) => signal.aborted)).toBe(true)
  const bytes = [Uint8Array.of(8), Uint8Array.of(9)]
  complete.forEach((resolve, index) => resolve(bytes[index]!))
  await vi.waitFor(() => expect(bytes.map((buffer) => buffer[0])).toEqual([0, 0]))
  expect(readRange).toHaveBeenCalledTimes(2)
  expect(receive).not.toHaveBeenCalled()
  expect(fail).not.toHaveBeenCalled()
})

test('excessive queued PDF ranges fail once and cancel the reader', async () => {
  const destroy = vi.fn()
  const fail = vi.fn()
  const readRange = vi.fn((_begin: number, _end: number, signal?: AbortSignal) => new Promise<Uint8Array>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true })))
  const queue = createPDFRangeQueue({ length: 1000, readRange, destroy }, vi.fn(), fail)
  for (let index = 0; index < 600; index += 1) queue.request(index, index + 1)
  expect(fail).toHaveBeenCalledTimes(1)
  expect(fail.mock.calls[0]![0]).toMatchObject({ message: 'Too many queued PDF ranges' })
  expect(destroy).toHaveBeenCalledTimes(1)
  expect(readRange).toHaveBeenCalledTimes(2)
})
