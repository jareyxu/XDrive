// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  deleteSystemWallpaper: vi.fn(),
  fetchSystemWallpaper: vi.fn(),
  fetchSystemWallpaperSelection: vi.fn(),
  setSystemWallpaperSelection: vi.fn(),
  SYSTEM_WALLPAPER_MAX_BYTES: 10 * 1024 * 1024,
  uploadSystemWallpaper: vi.fn(),
}))

vi.mock('../api/client', () => api)

import { chooseBuiltinWallpaper } from './wallpaper'
afterEach(() => {
  document.documentElement.style.removeProperty('--xdrive-wallpaper-image')
  vi.clearAllMocks()
})

it('applies a bundled wallpaper immediately and persists its selection on the server', async () => {
  await chooseBuiltinWallpaper('03')

  expect(document.documentElement.style.getPropertyValue('--xdrive-wallpaper-image')).toBe('url("/wallpapers/03.jpg")')
  expect(api.setSystemWallpaperSelection).toHaveBeenCalledWith('03')
  expect(api.uploadSystemWallpaper).not.toHaveBeenCalled()
})
