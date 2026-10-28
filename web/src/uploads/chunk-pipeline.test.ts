import { afterEach, expect, test, vi } from 'vitest'
import { runUploadChunk } from './chunk-pipeline'
import { runBoundedTasks } from './bounded-tasks'
import { uploadNetwork } from '../transfers/policy'

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
afterEach(() => vi.unstubAllGlobals())
function preferences(uploadConcurrency = 4) {
  vi.stubGlobal('window', { xdrivePreferences: { getSnapshot: () => ({ uploadConcurrency, downloadConcurrency: 4, downloadMemoryMiB: 64, autoTransfer: false }) } })
}

test('prepares one ciphertext ahead of four active sends, bounding all buffers across files', async () => {
  preferences()
  const hold = deferred(), prepared: Uint8Array[] = []
  let persisted = 0, sent = 0, preparing = 0, peakPreparation = 0
  const task = (_index: number, signal: AbortSignal) => runUploadChunk(async () => {
    peakPreparation = Math.max(peakPreparation, ++preparing)
    await Promise.resolve()
    const ciphertext = new Uint8Array(16).fill(17)
    prepared.push(ciphertext); preparing--; persisted++
    return { ciphertext, persisted: true }
  }, chunk => uploadNetwork.run(async () => { expect(chunk.persisted).toBe(true); sent++; await hold.promise }, signal), signal)
  // Two files share the same gates, rather than each receiving its own budget.
  const files = [runBoundedTasks(7, 5, task), runBoundedTasks(7, 5, task)]
  await vi.waitFor(() => { expect(sent).toBe(4); expect(persisted).toBe(5) })
  expect(peakPreparation).toBe(1)
  hold.resolve(); await Promise.all(files)
  expect(sent).toBe(14); expect(prepared.every(bytes => bytes.every(b => b === 0))).toBe(true)
})

test('cancellation during write-ahead completion wipes returned ciphertext and never sends it', async () => {
  preferences()
  const controller = new AbortController(), ciphertext = new Uint8Array(16).fill(23), send = vi.fn()
  await expect(runUploadChunk(async () => { controller.abort(); return { ciphertext } }, send, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(send).not.toHaveBeenCalled(); expect(ciphertext.every(b => b === 0)).toBe(true)
})

test('write-ahead failure stops sibling admission and drains prepared ciphertext on abort', async () => {
  preferences(2)
  const failure = new Error('IndexedDB full'), send = vi.fn(), buffers: Uint8Array[] = []
  const result = runBoundedTasks(10, 2, (i, signal) => runUploadChunk(async () => {
    if (i === 0) throw failure
    const ciphertext = new Uint8Array(16).fill(42); buffers.push(ciphertext); return { ciphertext }
  }, async chunk => { send(); await new Promise<void>((_, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }) }); chunk.ciphertext.fill(0) }, signal))
  await expect(result).rejects.toBe(failure)
  expect(buffers.every(bytes => bytes.every(b => b === 0))).toBe(true)
  // Subsequent uploads still acquire every permit after the failed batch.
  await runBoundedTasks(4, 2, (_, signal) => runUploadChunk(async () => ({ ciphertext: new Uint8Array(8) }), async () => {}, signal))
})

test('failure in the network stage erases the prepared buffer', async () => {
  preferences()
  const ciphertext = new Uint8Array(16).fill(99)
  await expect(runUploadChunk(async () => ({ ciphertext }), async () => { throw new Error('network failed') }, new AbortController().signal)).rejects.toThrow('network failed')
  expect(ciphertext.every(b => b === 0)).toBe(true)
})
