import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadFile } from './client'
import type { DriveEntry, UnlockedVault } from './client'

const ceiling = 512 * 1024 ** 2
const entry = (size: number): DriveEntry => ({ entryId: 'budget-entry', kind: 'file', name: 'budget.bin', size, fileId: 'budget-file', manifestObjectId: 'budget-manifest', manifestSha256: 'a'.repeat(64) })
// These preflight tests deliberately stop at the first manifest read; no fixture
// ciphertext, plaintext or large allocation is needed to test admission.
const unusedVault = {} as UnlockedVault
afterEach(() => vi.unstubAllGlobals())

describe('single-file memory fallback admission', () => {
  it('refuses one byte above the ceiling before any object request', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(downloadFile(unusedVault, entry(ceiling + 1))).rejects.toThrow('安全内存下载上限')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('admits the exact ceiling to manifest validation without allocating that file', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 400 }))
    vi.stubGlobal('fetch', fetch)
    await expect(downloadFile(unusedVault, entry(ceiling))).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(String(fetch.mock.calls[0]?.[0])).toContain('/api/v1/objects/budget-manifest')
  })

  it('does not impose the memory ceiling on streaming output and aborts that output on manifest failure', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 400 }))
    vi.stubGlobal('fetch', fetch)
    const abort = vi.fn(), write = vi.fn()
    const writable = new WritableStream<Uint8Array>({ abort, write })
    await expect(downloadFile(unusedVault, entry(ceiling + 1), undefined, writable)).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(write).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce())
  })
})
