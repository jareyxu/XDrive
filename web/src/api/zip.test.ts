import { describe, expect, it, vi } from 'vitest'
import { downloadDirectoryAsZip } from './client'
import type { DirectoryState, DriveEntry, UnlockedVault } from './client'

const fakeVault = {} as UnlockedVault
const directory = (entries: readonly DriveEntry[]): DirectoryState => ({ indexId: 'root-index', revision: 1, entries, path: [] })

describe('ZIP path validation', () => {
  it('aborts a chosen output file when preparation fails before writing bytes', async () => {
    const abort = vi.fn(), write = vi.fn()
    const output = new WritableStream<Uint8Array>({ abort, write })
    await expect(downloadDirectoryAsZip(fakeVault, directory([{ entryId: 'bad', kind: 'file', name: '../bad' }]), undefined, output)).rejects.toThrow(/路径/)
    expect(abort).toHaveBeenCalledTimes(1)
    expect(write).not.toHaveBeenCalled()
  })
  it.each(['../secret.txt', '/absolute.txt', 'C:secret.txt', 'bad\\name.txt', 'bad\u0000name.txt', 'trailing.'])('rejects unsafe archive segment %s before reading file data', async (name) => {
    const entry: DriveEntry = { entryId: 'entry', kind: 'file', name, size: 1, fileId: 'file', manifestObjectId: 'manifest-object-0001', manifestSha256: '0'.repeat(64) }
    await expect(downloadDirectoryAsZip(fakeVault, directory([entry]))).rejects.toThrow(/ZIP|路径/)
  })

  it('rejects case-only paths that commonly collide on extraction filesystems', async () => {
    const entries: DriveEntry[] = [
      { entryId: 'one', kind: 'file', name: 'Report.txt', size: 0, fileId: 'file-1', manifestObjectId: 'manifest-object-0001', manifestSha256: '0'.repeat(64) },
      { entryId: 'two', kind: 'file', name: 'report.txt', size: 0, fileId: 'file-2', manifestObjectId: 'manifest-object-0002', manifestSha256: '0'.repeat(64) },
    ]
    await expect(downloadDirectoryAsZip(fakeVault, directory(entries))).rejects.toThrow(/大小写冲突/)
  })
})
