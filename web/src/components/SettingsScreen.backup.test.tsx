// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const api = vi.hoisted(() => ({
  fetchStorageUsage: vi.fn(),
  fetchSystemInfo: vi.fn(),
  fetchSystemUpdateInfo: vi.fn(),
  fetchSystemUpdateStatus: vi.fn(),
  prepareBackupDownload: vi.fn(),
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

afterEach(() => vi.clearAllMocks())

it('confirms a backup download before asking the server to stream it', async () => {
  const user = userEvent.setup()
  api.fetchStorageUsage.mockResolvedValue({ quotaBytes: 1000, usedBytes: 100, reservedBytes: 0, trashBytes: 0, pendingBytes: 0, freeDiskBytes: 1000, availableBytes: 900, backupWarnAfterDays: 30, lastBackupAt: null })
  api.fetchSystemInfo.mockResolvedValue({ version: 'v1.3.3', commit: 'abc123', clientProtocolVersion: 1, encryptedFormatVersion: 2 })
  api.prepareBackupDownload.mockRejectedValue(new Error('test failure'))
  render(<SettingsScreen now={Date.now()} revision={0} onChangePassword={() => undefined} passwordDisabled={false} />)
  await user.click(screen.getByRole('button', { name: '备份' }))

  await user.click(screen.getByRole('button', { name: '创建并下载备份' }))
  expect(screen.getByRole('group', { name: '确认创建备份' })).not.toBeNull()
  expect(screen.getByText(/账户数据库和加密文件对象/)).not.toBeNull()
  await user.click(screen.getByRole('button', { name: '确认并下载' }))

  expect(api.prepareBackupDownload).toHaveBeenCalledWith(expect.any(AbortSignal))
  expect(await screen.findByRole('alert')).not.toBeNull()
})
