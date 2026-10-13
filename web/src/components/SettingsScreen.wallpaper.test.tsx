// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const actions = vi.hoisted(() => ({ chooseBuiltinWallpaper: vi.fn() }))
vi.mock('../preferences/wallpaper', () => ({
  clearWallpaper: vi.fn(), chooseBuiltinWallpaper: actions.chooseBuiltinWallpaper,
  MAX_WALLPAPER_BYTES: 10 * 1024 * 1024, saveWallpaper: vi.fn(),
  useWallpaper: () => ({ ready: true, url: '/wallpapers/default.jpg', builtinId: 'default' }),
  WALLPAPER_TYPES: ['image/jpeg', 'image/png', 'image/webp', 'image/avif'],
}))
vi.mock('../api/client', () => ({
  fetchStorageUsage: vi.fn().mockResolvedValue({ quotaBytes: 1000, usedBytes: 0, reservedBytes: 0, trashBytes: 0, pendingBytes: 0, freeDiskBytes: 1000, availableBytes: 1000, backupWarnAfterDays: 30, lastBackupAt: null }),
  fetchSystemInfo: vi.fn().mockResolvedValue({ version: 'v2.0.7', commit: 'abc123', clientProtocolVersion: 1, encryptedFormatVersion: 2 }),
  fetchSystemUpdateInfo: vi.fn(), fetchSystemUpdateStatus: vi.fn(), prepareBackupDownload: vi.fn(), startSystemUpdate: vi.fn(),
  SYSTEM_WALLPAPER_MAX_BYTES: 10 * 1024 * 1024,
}))
vi.mock('../preferences/preferences', () => ({
  effectiveBackupReminderDays: () => 30, backupIsOverdue: () => false, setPreferences: vi.fn(),
  usePreferences: () => ({ persistenceAvailable: true, theme: 'system', view: 'grid', uploadConcurrency: 2, backupReminderDays: 30 }),
}))

import { SettingsScreen } from './SettingsScreen'

afterEach(() => { cleanup(); vi.clearAllMocks() })

it('shows eight bundled wallpaper previews in a selectable gallery', async () => {
  const user = userEvent.setup()
  render(<SettingsScreen now={Date.now()} revision={0} onChangePassword={() => undefined} passwordDisabled={false} />)

  const gallery = screen.getByRole('group', { name: '选择系统壁纸' })
  const choices = within(gallery).getAllByRole('button')
  expect(choices).toHaveLength(8)
  expect(choices[0].querySelector('img')?.getAttribute('src')).toBe('/wallpapers/thumbs/default.jpg')
  expect(choices[0].getAttribute('aria-pressed')).toBe('true')
  await user.click(choices[2])
  expect(actions.chooseBuiltinWallpaper).toHaveBeenCalledWith('03')
})
