import { expect, test, vi } from 'vitest'
import { MutationCoordinator, parseCoordinationMessage } from './mutation-coordinator'
import type { OwnershipStore } from './mutation-coordinator'
const scope = 'root-index-0123456789012345'
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function owners(): OwnershipStore {
  const rows = new Map<string, string>()
  return {
    async claim(scope, owner, takeover) { const current = rows.get(scope); if (current && current !== owner && !takeover) return false; rows.set(scope, owner); return true },
    async owns(scope, owner) { return rows.get(scope) === owner },
    async release(scope, owner) { if (rows.get(scope) === owner) rows.delete(scope) },
  }
}
function locks() {
  let tail: Promise<unknown> = Promise.resolve()
  return vi.fn(async (_name: string, signal: AbortSignal, operation: () => Promise<unknown>) => {
    const next = tail.catch(() => undefined).then(() => { signal.throwIfAborted(); return operation() })
    tail = next.catch(() => undefined)
    return next
  })
}
test('serializes complete operations across tabs sharing the Web Lock', async () => {
  const lock = locks(), ownership = owners(), started = deferred(), finish = deferred()
  const a = new MutationCoordinator({ ownerId: () => 'a', ownership, lock })
  const b = new MutationCoordinator({ ownerId: () => 'b', ownership, lock })
  const events: string[] = []
  const first = a.run(scope, async () => { await a.guard(scope); events.push('a:start'); started.resolve(); await finish.promise; events.push('a:end'); return 1 })
  await started.promise
  const second = b.run(scope, async () => { await b.guard(scope); events.push('b'); return 2 })
  expect(events).toEqual(['a:start'])
  finish.resolve()
  expect(await Promise.all([first, second])).toEqual([1, 2])
  expect(events).toEqual(['a:start', 'a:end', 'b'])
  expect(lock.mock.calls.map((call) => call[0])).toEqual([`xdrive:mutation:v1:${scope}`, `xdrive:mutation:v1:${scope}`])
})
test('same tab queues operations and a rejected operation does not poison the queue', async () => {
  const coordinator = new MutationCoordinator({ ownerId: () => 'a', ownership: owners(), lock: locks() })
  const failed = coordinator.run(scope, async () => { throw new Error('fail') })
  const succeeded = coordinator.run(scope, async () => 42)
  await expect(failed).rejects.toThrow('fail')
  expect(await succeeded).toBe(42)
})
test('cancels a queued operation immediately without executing it', async () => {
  const started = deferred(), finish = deferred(), controller = new AbortController()
  const coordinator = new MutationCoordinator({ ownerId: () => 'a', ownership: owners(), lock: locks() })
  const first = coordinator.run(scope, async () => { started.resolve(); await finish.promise })
  await started.promise
  const operation = vi.fn(async () => undefined)
  const second = coordinator.run(scope, operation, controller.signal)
  const rejected = expect(second).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  await rejected
  finish.resolve()
  await first
  await Promise.resolve()
  expect(operation).not.toHaveBeenCalled()
})
test('without Web Locks only one tab can claim ownership', async () => {
  const ownership = owners()
  const a = new MutationCoordinator({ ownerId: () => 'a', ownership })
  const b = new MutationCoordinator({ ownerId: () => 'b', ownership })
  expect(await Promise.all([a.prepare(scope), b.prepare(scope)])).toEqual(['fallback-writer', 'fallback-reader'])
  const operation = vi.fn(async () => undefined)
  await expect(b.run(scope, operation)).rejects.toThrow('只读')
  expect(operation).not.toHaveBeenCalled()
  expect(await a.run(scope, async () => { await a.guard(scope); return 7 })).toBe(7)
})
test('stale ownership never expires automatically; explicit takeover revokes old writer', async () => {
  const ownership = owners()
  const a = new MutationCoordinator({ ownerId: () => 'a', ownership })
  const b = new MutationCoordinator({ ownerId: () => 'b', ownership })
  await a.prepare(scope)
  const entered = deferred(), resume = deferred()
  const first = a.run(scope, async () => { await a.guard(scope); entered.resolve(); await resume.promise; await a.guard(scope) })
  await entered.promise
  expect(await b.prepare(scope)).toBe('fallback-reader')
  expect(await b.prepare(scope, true)).toBe('fallback-writer')
  resume.resolve()
  await expect(first).rejects.toThrow('只读')
  expect(await ownership.owns(scope, 'b')).toBe(true)
})
test('reset aborts active context and old ownership release cannot erase new owner', async () => {
  const ownership = owners()
  let generation = 0
  const a = new MutationCoordinator({ ownerId: () => `a-${generation++}`, ownership })
  await a.prepare(scope)
  const entered = deferred(), finish = deferred()
  const running = a.run(scope, async () => { entered.resolve(); await finish.promise; await a.guard(scope) })
  await entered.promise
  const rejection = expect(running).rejects.toMatchObject({ name: 'AbortError' })
  a.reset()
  await rejection
  finish.resolve()
  await a.prepare(scope, true)
  expect(await ownership.owns(scope, 'a-1')).toBe(true)
})
test('ownership storage errors fail closed before running a write', async () => {
  const ownership = owners()
  ownership.claim = async () => { throw new Error('IDB blocked') }
  const coordinator = new MutationCoordinator({ ownerId: () => 'a', ownership })
  const operation = vi.fn(async () => undefined)
  await expect(coordinator.run(scope, operation)).rejects.toThrow('IDB blocked')
  expect(coordinator.getState()).toBe('unavailable')
  expect(operation).not.toHaveBeenCalled()
})
test('only opaque invalidations cross the channel; failed writes publish nothing', async () => {
  const broadcast = vi.fn()
  const coordinator = new MutationCoordinator({ ownerId: () => 'a', ownership: owners(), lock: locks(), broadcast })
  await coordinator.run(scope, async () => ({ name: 'private-file', key: 'never broadcast' }))
  expect(broadcast.mock.calls).toEqual([[{ kind: 'invalidate', scope }]])
  await expect(coordinator.run(scope, async () => { throw new Error('failed') })).rejects.toThrow('failed')
  expect(broadcast).toHaveBeenCalledTimes(1)
  const invalidation = vi.fn()
  coordinator.subscribeInvalidation(invalidation)
  coordinator.receive({ kind: 'invalidate', scope, key: 'unexpected' })
  coordinator.receive({ kind: 'invalidate', scope })
  expect(invalidation.mock.calls).toEqual([[scope]])
})
test('rejects extra fields, keys, plaintext scopes and malformed channel messages', () => {
  for (const value of [null, [], { kind: 'key', scope }, { kind: 'invalidate', scope, cryptoKey: {} }, { kind: 'invalidate', scope: 'my files' }]) expect(parseCoordinationMessage(value)).toBeNull()
})
