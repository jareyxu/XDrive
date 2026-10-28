import { afterEach, expect, test, vi } from 'vitest'
import { AdaptiveConcurrency, downloadDepth, refreshTransferCapabilities, transferLimit, uploadDepth, uploadNetwork } from './policy'
import { recommendedDownloadMemory, transferCeilings } from './limits'

afterEach(() => vi.unstubAllGlobals())

test('starts at four, probes only sustained actual concurrency and backs off on a plateau', () => {
  const changed = vi.fn(), policy = new AdaptiveConcurrency(changed)
  expect(policy.value(8)).toBe(4)
  policy.activity(4, 0)
  policy.observe(100, 0); policy.observe(10000, 5000)
  expect(policy.value(8)).toBe(5); expect(changed).toHaveBeenCalledTimes(1)
  policy.activity(5, 5000)
  policy.observe(100, 5001); policy.observe(10000, 10001)
  expect(policy.value(8)).toBe(4)
  policy.activity(4, 10001)
  policy.observe(100, 10002); policy.observe(10000, 15002)
  expect(policy.value(8)).toBe(4)
  policy.congested(15003); expect(policy.value(8)).toBe(2)
})

test('does not probe beyond memory/server ceiling or mistake an unfilled probe for a plateau', () => {
  const limited = new AdaptiveConcurrency()
  expect(limited.value(2)).toBe(2)
  limited.activity(2, 0); limited.observe(100, 0); limited.observe(10000, 5000)
  expect(limited.value(2)).toBe(2)
  const policy = new AdaptiveConcurrency()
  policy.activity(4, 0); policy.observe(100, 0); policy.observe(10000, 5000)
  expect(policy.value(8)).toBe(5)
  // The workload only has four requests; no five-way trial actually happened.
  policy.observe(100, 10000); policy.observe(100, 20000)
  expect(policy.value(8)).toBe(5)
})

test('idle periods reset stale samples and recover initial concurrency for a new workload', () => {
  const policy = new AdaptiveConcurrency()
  policy.activity(4, 0); policy.congested(1)
  expect(policy.value(8)).toBe(2)
  policy.activity(0, 10)
  policy.activity(2, 1000)
  expect(policy.value(8)).toBe(2) // brief request gaps do not bypass backoff
  policy.activity(0, 2000); policy.activity(4, 32000)
  expect(policy.value(8)).toBe(4)
  policy.observe(100, 32000); policy.observe(10000, 37000)
  expect(policy.value(8)).toBe(5)
})

test('changing the resource ceiling invalidates an in-flight probe', () => {
  const policy = new AdaptiveConcurrency()
  policy.activity(4, 0); policy.observe(100, 0); policy.observe(10000, 5000)
  expect(policy.value(3)).toBe(3)
  policy.activity(3, 5000); policy.observe(100, 5001); policy.observe(10000, 10001)
  expect(policy.value(3)).toBe(3)
})

test('download memory, browser preferences and server ceilings agree', () => {
  const prefs = { uploadConcurrency: 8, downloadConcurrency: 8, downloadMemoryMiB: 64 }
  expect(transferCeilings(prefs, { uploadConcurrency: 4, downloadConcurrency: 8 })).toEqual({ upload: 4, download: 2, bufferSlots: 2 })
  expect(transferCeilings({ ...prefs, downloadMemoryMiB: 128 }, { uploadConcurrency: 8, downloadConcurrency: 8 }).download).toBe(4)
  expect(transferCeilings({ ...prefs, downloadMemoryMiB: 256 }, { uploadConcurrency: 8, downloadConcurrency: 3 }).download).toBe(3)
  expect([1, 2, 3, 4, 5, 8].map(recommendedDownloadMemory)).toEqual([64, 64, 128, 128, 256, 256])
})

test('preference changes immediately wake queued network work without exceeding server or buffer limits', async () => {
  let prefs = { uploadConcurrency: 2, downloadConcurrency: 4, downloadMemoryMiB: 64, autoTransfer: false }
  let listener = () => {}
  vi.stubGlobal('window', { xdrivePreferences: { getSnapshot: () => prefs, subscribe: (fn: () => void) => { listener = fn; return () => {} } } })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ uploadConcurrency: 4, downloadConcurrency: 8 }))))
  await refreshTransferCapabilities()
  expect(uploadDepth()).toBe(2); expect(downloadDepth()).toBe(2)
  const first = await uploadNetwork.acquire(), second = await uploadNetwork.acquire()
  let admitted = false
  const queued = uploadNetwork.acquire().then(release => { admitted = true; return release })
  await Promise.resolve(); expect(admitted).toBe(false)
  prefs = { ...prefs, uploadConcurrency: 8, downloadMemoryMiB: 128 }; listener()
  const third = await queued
  expect(admitted).toBe(true); expect(transferLimit('upload')).toBe(4)
  expect(uploadDepth()).toBe(5); expect(downloadDepth()).toBe(4)
  third(); second(); first()
})
