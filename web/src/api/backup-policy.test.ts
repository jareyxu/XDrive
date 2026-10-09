import { afterEach, expect, it, vi } from 'vitest'
import { fetchStorageUsage } from './client'

afterEach(() => vi.unstubAllGlobals())
it.each([undefined, 0, -1, 1.5, 3651, '30'])('rejects invalid storage reminder policy %s rather than inventing a default', async value => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ backupWarnAfterDays: value, lastBackupAt: null }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
  await expect(fetchStorageUsage()).rejects.toThrow('备份提醒策略不可用')
})
it('preserves configured integer threshold and real backup timestamp', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ backupWarnAfterDays: 2, lastBackupAt: 1234000 }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
  await expect(fetchStorageUsage()).resolves.toMatchObject({ backupWarnAfterDays: 2, lastBackupAt: 1234000 })
})
