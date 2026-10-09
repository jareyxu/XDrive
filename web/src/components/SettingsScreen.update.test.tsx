// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const api = vi.hoisted(() => ({
  fetchStorageUsage: vi.fn(),
  fetchSystemInfo: vi.fn(),
  fetchSystemUpdateInfo: vi.fn(),
  fetchSystemUpdateStatus: vi.fn(),
  startSystemUpdate: vi.fn(),
}))

vi.mock('../api/client', () => api)
vi.mock('../preferences/preferences', () => ({
  effectiveBackupReminderDays: () => 30,
  backupIsOverdue: () => false,
  setPreferences: vi.fn(),
  usePreferences: () => ({
    persistenceAvailable: true, theme: 'system', clarity: 0.7, reduceTransparency: false,
    view: 'grid', uploadConcurrency: 2, backupReminderDays: 30,
  }),
}))

import { SettingsScreen } from './SettingsScreen'

beforeEach(() => {
  api.fetchStorageUsage.mockResolvedValue({ quotaBytes: 1000, usedBytes: 100, reservedBytes: 0, trashBytes: 0, pendingBytes: 0, freeDiskBytes: 1000, availableBytes: 900, backupWarnAfterDays: 30, lastBackupAt: null })
  api.fetchSystemInfo.mockResolvedValue({ version: 'v1.3.1', commit: 'abc123', clientProtocolVersion: 1, encryptedFormatVersion: 2 })
  api.fetchSystemUpdateInfo.mockResolvedValue({ currentVersion: 'v1.3.1', latestVersion: 'v1.4.0', name: 'XDrive v1.4.0', releaseUrl: 'https://github.com/jareyxu/XDrive/releases/tag/v1.4.0', publishedAt: '2026-10-09T00:00:00Z', releaseNotes: 'Security and stability updates', updateAvailable: true, canInstall: true })
  api.startSystemUpdate.mockResolvedValue({ id: 'abcdefghijklmnopqrstu_', version: 'v1.4.0', state: 'queued', updatedAt: 1 })
  api.fetchSystemUpdateStatus.mockResolvedValue({ id: 'abcdefghijklmnopqrstu_', version: 'v1.4.0', state: 'succeeded', updatedAt: 2 })
})

afterEach(() => vi.clearAllMocks())

it('checks a release, asks for confirmation, and reports the completed server update', async () => {
  const user = userEvent.setup()
  render(<SettingsScreen now={Date.now()} revision={0} onChangePassword={() => undefined} passwordDisabled={false} />)

  await user.click(screen.getByRole('button', { name: '检查更新' }))
  expect((await screen.findByRole('link', { name: 'v1.4.0' })).getAttribute('href')).toBe('https://github.com/jareyxu/XDrive/releases/tag/v1.4.0')
  await user.click(screen.getByRole('button', { name: '安装 v1.4.0' }))
  expect(screen.getByRole('group', { name: '确认安装更新' })).not.toBeNull()
  await user.click(screen.getByRole('button', { name: '确认更新' }))

  expect(api.startSystemUpdate).toHaveBeenCalledWith('v1.4.0', expect.any(AbortSignal))
  expect((await screen.findByText('更新完成，请刷新页面载入新版界面。')).textContent).toBe('更新完成，请刷新页面载入新版界面。')
  expect(api.fetchSystemUpdateStatus).toHaveBeenCalledWith('abcdefghijklmnopqrstu_', expect.any(AbortSignal))
})
