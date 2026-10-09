import { expect, test, vi } from 'vitest'
import { createWriteAheadQueue, runBoundedTasks } from './bounded-tasks'
function gate() { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve }); return { promise, open } }

test.each([2, 3, 4])('whole chunk admission stays bounded at %i and drains every chunk', async concurrency => {
 const holds = Array.from({ length: 7 }, gate); const started: number[] = [], ended: number[] = []
 let active = 0, peak = 0
 const pending = runBoundedTasks(7, concurrency, async index => { started.push(index); peak = Math.max(peak, ++active); await holds[index]!.promise; active--; ended.push(index) })
 expect(started).toHaveLength(concurrency)
 holds[concurrency - 1]!.open(); await vi.waitFor(() => expect(started).toHaveLength(concurrency + 1))
 expect(ended[0]).toBe(concurrency - 1)
 holds.forEach(hold => hold.open()); await pending
 expect(peak).toBe(concurrency); expect(active).toBe(0); expect(ended.slice().sort()).toEqual([0, 1, 2, 3, 4, 5, 6])
})
test('first failure aborts siblings, admits no queued chunks and waits for cleanup before rejection', async () => {
 const failure = new Error('digest failed'), cleanup = gate(), fail = gate(); const started: number[] = []
 let siblingAborted = false, settled = false
 const pending = runBoundedTasks(10, 2, async (index, signal) => {
  started.push(index)
  if (index === 0) { await fail.promise; throw failure }
  await new Promise<void>(resolve => signal.addEventListener('abort', () => { siblingAborted = true; resolve() }, { once: true }))
  await cleanup.promise
 }).finally(() => { settled = true })
 const rejected = expect(pending).rejects.toBe(failure)
 fail.open(); await vi.waitFor(() => expect(siblingAborted).toBe(true)); expect(started).toEqual([0, 1]); expect(settled).toBe(false)
 cleanup.open(); await rejected; expect(settled).toBe(true)
})
test('owner cancellation aborts live tasks and prevents fresh admission', async () => {
 const owner = new AbortController(), started: number[] = []
 const pending = runBoundedTasks(10, 4, async (index, signal) => { started.push(index); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) }, owner.signal)
 const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' }); owner.abort(); await rejected; expect(started).toEqual([0, 1, 2, 3])
})
test('already aborted or invalid scheduling never reads a file', async () => {
 const task = vi.fn(async () => undefined), owner = new AbortController(); owner.abort()
 await expect(runBoundedTasks(0, 2, task, owner.signal)).rejects.toMatchObject({ name: 'AbortError' })
 for (const [count, parallel] of [[-1, 2], [4097, 2], [1, 1], [1, 5], [1, 2.5]]) await expect(runBoundedTasks(count!, parallel!, task)).rejects.toBeInstanceOf(RangeError)
 expect(task).not.toHaveBeenCalled()
})
test('write-ahead snapshots cannot finish out of order or discard another chunk update', async () => {
 const queue = createWriteAheadQueue(), first = gate(); let record: number[] = []; const stored: number[][] = []
 const save = (index: number) => queue(async () => { const next = [...record, index]; if (index === 0) await first.promise; stored.push(next); record = next })
 const a = save(0), b = save(1), c = save(2); await Promise.resolve(); expect(stored).toEqual([])
 first.open(); await Promise.all([a, b, c]); expect(stored).toEqual([[0], [0, 1], [0, 1, 2]])
})
test('failed recovery persistence prevents all later writes without unhandled rejected tails', async () => {
 const queue = createWriteAheadQueue(), failure = new Error('IndexedDB full'), later = vi.fn(async () => undefined)
 const a = queue(async () => { throw failure }), b = queue(later)
 await expect(a).rejects.toBe(failure); await expect(b).rejects.toBe(failure)
 await expect(queue(later)).rejects.toBe(failure); expect(later).not.toHaveBeenCalled()
})
