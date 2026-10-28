// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Preferences } from '../preferences/preferences'

const server = vi.hoisted(() => ({ uploadConcurrency: 4, downloadConcurrency: 8 }))
vi.mock('../transfers/policy', () => ({
  confirmedTransferCapabilities: () => ({ ...server }),
  refreshTransferCapabilities: vi.fn(async () => {}),
}))
vi.mock('../api/client', () => ({
  fetchStorageUsage: vi.fn().mockResolvedValue({ backupWarnAfterDays: 30, lastBackupAt: null }),
  fetchSystemInfo: vi.fn().mockResolvedValue({ version: 'test', commit: 'test', clientProtocolVersion: 1, encryptedFormatVersion: 2 }),
  fetchSystemUpdateInfo: vi.fn(), fetchSystemUpdateStatus: vi.fn(), prepareBackupDownload: vi.fn(), startSystemUpdate: vi.fn(),
}))
vi.mock('../preferences/wallpaper', () => ({
  clearWallpaper: vi.fn(), chooseBuiltinWallpaper: vi.fn(), saveWallpaper: vi.fn(), MAX_WALLPAPER_BYTES: 10485760,
  useWallpaper: () => ({ ready: true, url: '/wallpapers/default.jpg', builtinId: 'default' }), WALLPAPER_TYPES: [],
}))
import { SettingsScreen } from './SettingsScreen'

beforeEach(() => {
  server.downloadConcurrency = 8
  let snapshot = { theme: 'system', view: 'grid', backupReminderDays: 30, uploadConcurrency: 4, downloadConcurrency: 4, downloadMemoryMiB: 64, autoTransfer: true, persistenceAvailable: true } as ReturnType<Window['xdrivePreferences']['getSnapshot']>
  const listeners = new Set<() => void>()
  window.xdrivePreferences = {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: (change: Partial<Preferences>) => { snapshot = { ...snapshot, ...change }; listeners.forEach(listener => listener()) },
  }
})
afterEach(() => cleanup())

test('explains the two-slot memory ceiling and applies the requested budget without silently raising it', async () => {
  const user = userEvent.setup()
  render(<SettingsScreen now={Date.now()} revision={0} onChangePassword={() => {}} passwordDisabled={false} category="transfer" />)
  expect(screen.getByRole('status').textContent).toContain('上传 4 路，下载 2 路')
  await user.click(screen.getByRole('button', { name: '调整预算为 128 MiB' }))
  expect(window.xdrivePreferences.getSnapshot().downloadMemoryMiB).toBe(128)
  expect(screen.getByRole('status').textContent).toContain('上传 4 路，下载 4 路')
  await user.selectOptions(screen.getByLabelText('下载最大并发'), '8')
  expect(window.xdrivePreferences.getSnapshot().downloadMemoryMiB).toBe(128)
  await user.click(screen.getByRole('button', { name: '调整预算为 256 MiB' }))
  expect(screen.getByRole('status').textContent).toContain('下载 8 路')
  await user.selectOptions(screen.getByLabelText('下载流水线预算'), '64')
  expect(screen.getByRole('status').textContent).toContain('下载 2 路')
})

test('a higher browser budget cannot exceed the server concurrency limit', async () => {
  server.downloadConcurrency = 1
  const user = userEvent.setup()
  render(<SettingsScreen now={Date.now()} revision={0} onChangePassword={() => {}} passwordDisabled={false} category="transfer" />)
  await user.click(screen.getByRole('button', { name: '调整预算为 128 MiB' }))
  expect(screen.getByRole('status').textContent).toContain('下载 1 路')
  await user.click(screen.getByRole('button', { name: '恢复传输默认设置' }))
  expect(window.xdrivePreferences.getSnapshot()).toMatchObject({ uploadConcurrency: 4, downloadConcurrency: 4, downloadMemoryMiB: 64, autoTransfer: true })
})
