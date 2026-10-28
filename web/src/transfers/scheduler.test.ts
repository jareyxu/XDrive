import { expect, test } from 'vitest'
import { TransferGate } from './scheduler'

test('growing a limit starts queued work immediately; shrinking lets active work finish', async () => {
  let limit = 1
  const gate = new TransferGate(() => limit)
  const first = await gate.acquire()
  let started = false
  const queued = gate.acquire().then(release => { started = true; return release })
  await Promise.resolve(); expect(started).toBe(false)
  limit = 2; gate.refresh()
  const second = await queued; expect(started).toBe(true)
  limit = 1; gate.refresh(); started = false
  const last = gate.acquire().then(release => { started = true; return release })
  first(); await Promise.resolve(); expect(started).toBe(false)
  second(); (await last)()
})

test('cancelled queued work never consumes a newly opened slot; releases are idempotent', async () => {
  const active: number[] = []
  let limit = 1
  const gate = new TransferGate(() => limit, 8, n => active.push(n))
  const release = await gate.acquire(), controller = new AbortController()
  const waiting = gate.acquire(controller.signal)
  const rejected = expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort(); await rejected
  limit = 4; gate.refresh(); release(); release()
  expect(active).toEqual([1, 0])
})
