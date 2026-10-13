import { expect, test } from 'vitest'
import { prefetchChunks } from './prefetch'
import { TransferGate } from './scheduler'

// Controlled scheduling benchmark; not a VPS/network bandwidth measurement.
test('compare serial and prefetched reads with the same simulated network and sink', async () => {
 const rows: { depth: number; ms: number; peak: number }[] = []
 for (const depth of [1, 2, 4]) {
  let active = 0, peak = 0, count = 0
  const reader = {
   length: 16 * 1024 * 1024, destroy() {},
   async readRange(begin: number, end: number) {
    peak = Math.max(peak, ++active)
    await new Promise(resolve => setTimeout(resolve, 20))
    active--
    return new Uint8Array(end - begin).fill(begin / 1048576)
   },
  }
  const start = performance.now()
  for await (const bytes of prefetchChunks(reader, 1048576, depth, new TransferGate(() => depth))) {
   expect(bytes[0]).toBe(count++)
   await new Promise(resolve => setTimeout(resolve, 5))
   bytes.fill(0)
  }
  rows.push({ depth, ms: Math.round(performance.now() - start), peak })
  expect(count).toBe(16)
  expect(peak).toBe(depth)
 }
 console.table(rows)
}, 10000)
