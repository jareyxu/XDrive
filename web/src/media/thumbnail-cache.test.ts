import { afterEach, expect, test, vi } from 'vitest'
import { ThumbnailCache } from './thumbnail-cache'
import type { ThumbnailIdentity } from './thumbnail-cache'
const identity = (id: number): ThumbnailIdentity => ({ fileId: `file-${id}`, thumbnail: { objectId: `object-${id}`, sizeBytes: 40, sha256: '0'.repeat(64), mime: 'image/webp', width: 1, height: 1 } })
afterEach(() => vi.restoreAllMocks())
function urls() { let count = 0; const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${++count}`), revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {}); return { create, revoke } }
test('whole read/decrypt operations stay at six, queued consumers abort without leaking slots', async () => {
 urls(); const complete: (() => void)[] = [], read = vi.fn(() => new Promise<Blob>(resolve => complete.push(() => resolve(new Blob(['data'])))))
 const cache = new ThumbnailCache(read); cache.open()
 const signals = Array.from({ length: 10 }, () => new AbortController()), tasks = signals.map((signal, i) => cache.load(identity(i), signal.signal).catch(error => error))
 await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(6)); expect(cache.stats).toMatchObject({ active: 6, queued: 4 })
 signals[9]!.abort(); await vi.waitFor(() => expect(cache.stats.queued).toBe(3))
 complete.shift()!(); await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(7)); expect(cache.stats.active).toBe(6)
 while (read.mock.calls.length < 9) { complete.shift()!(); await new Promise(resolve => setTimeout(resolve, 0)) }
 for (const finish of complete) finish(); await Promise.all(tasks)
 expect(cache.stats).toMatchObject({ active: 0, queued: 0 }); cache.dispose()
})
test('LRU and byte bounds revoke exactly once, cache hits avoid reads and dispose invalidates all URLs', async () => {
 const { revoke } = urls(), read = vi.fn(async () => new Blob(['1234'])), cache = new ThumbnailCache(read, 2, 8); cache.open()
 const signal = new AbortController().signal
 const one = await cache.load(identity(1), signal); await cache.load(identity(2), signal); expect(await cache.load(identity(1), signal)).toBe(one)
 await cache.load(identity(3), signal); expect(read).toHaveBeenCalledTimes(3); expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:2')
 expect(cache.stats).toMatchObject({ entries: 2, bytes: 8 }); cache.dispose(); expect(revoke).toHaveBeenCalledTimes(3); expect(cache.stats.bytes).toBe(0)
 await expect(cache.load(identity(1), signal)).rejects.toMatchObject({ name: 'AbortError' })
})
test('StrictMode owner restart cannot admit new work until abandoned native tasks settle or publish stale URLs', async () => {
 const { create } = urls(), complete: ((blob: Blob) => void)[] = []
 const read = vi.fn(() => new Promise<Blob>(resolve => complete.push(resolve))), cache = new ThumbnailCache(read); cache.open()
 const signal = new AbortController().signal, old = Array.from({ length: 6 }, (_, i) => cache.load(identity(i), signal).catch(error => error))
 await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(6)); cache.dispose(); cache.open()
 const next = cache.load(identity(10), signal); expect(cache.stats).toMatchObject({ active: 6, queued: 1 })
 complete[0]!(new Blob(['old'])); await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(7)); expect(create).not.toHaveBeenCalled()
 for (const finish of complete.slice(1, 6)) finish(new Blob(['old']))
 complete[6]!(new Blob(['new'])); await next; await Promise.all(old)
 expect(create).toHaveBeenCalledTimes(1); expect(cache.stats.active).toBe(0); cache.dispose()
})
test('failures release slots and oversized blobs never create URLs', async () => {
 const { create } = urls(), cache = new ThumbnailCache(async () => new Blob(['too large']), 1, 1); cache.open()
 await expect(cache.load(identity(1), new AbortController().signal)).rejects.toThrow('budget'); expect(create).not.toHaveBeenCalled(); expect(cache.stats.active).toBe(0); cache.dispose()
})
