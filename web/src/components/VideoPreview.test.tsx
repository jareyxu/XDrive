// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { VideoStreamError } from '../media/video-range'
import { VideoPreview } from './VideoPreview'

const mocks = vi.hoisted(() => ({ create: vi.fn(), supports: vi.fn(), limit: vi.fn(), download: vi.fn() }))
vi.mock('../api/client', () => ({ downloadFile: mocks.download, fetchVideoBlobFallbackLimit: mocks.limit }))
vi.mock('../media/video-range', async importOriginal => ({ ...await importOriginal<typeof import('../media/video-range')>(), createVideoRangeSession: mocks.create, supportsVideoRange: mocks.supports }))
const entry = { kind: 'file', entryId: 'private-video', mime: 'video/mp4', size: 2 * 1024 ** 3 } as never
const vault = {} as never
function session(id = 'session') { return { url: `/__xdrive_media/${id}`, close: vi.fn(), cancelPendingReads: vi.fn(), failure: vi.fn() } }
function mount() { return render(<VideoPreview vault={vault} entry={entry} holdIdleLock={() => vi.fn()} />) }
function video(): HTMLVideoElement { return document.querySelector('video')! }

beforeEach(() => {
  mocks.supports.mockReturnValue(true)
  mocks.create.mockResolvedValue(session())
  mocks.limit.mockResolvedValue(256 * 1024 ** 2)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks() })

test('a 2 GiB video uses a verified stream without consulting the Blob fallback policy', async () => {
  mount()
  await waitFor(() => expect(video()?.getAttribute('src')).toBe('/__xdrive_media/session'))
  expect(video().getAttribute('preload')).toBe('metadata')
  expect(mocks.limit).not.toHaveBeenCalled()
  expect(mocks.download).not.toHaveBeenCalled()
})

test('unsupported streaming refuses a large Blob but provides retry', async () => {
  mocks.supports.mockReturnValue(false)
  mount()
  expect((await screen.findByRole('alert')).textContent).toContain('内存播放上限')
  expect(mocks.download).not.toHaveBeenCalled()
  mocks.supports.mockReturnValue(true)
  fireEvent.click(screen.getByRole('button', { name: '重试播放' }))
  await waitFor(() => expect(video()).toBeTruthy())
  expect(screen.queryByRole('alert')).toBeNull()
})

test('integrity and network failures are not hidden by a Blob fallback', async () => {
  mocks.create.mockRejectedValue(new VideoStreamError('integrity', '视频数据完整性校验失败。'))
  mount()
  expect((await screen.findByRole('alert')).textContent).toContain('完整性校验失败')
  expect(mocks.limit).not.toHaveBeenCalled()
  expect(mocks.download).not.toHaveBeenCalled()
})

test('seeking cancels old reads and leaving the page closes the owned session', async () => {
  const owned = session()
  mocks.create.mockResolvedValue(owned)
  const rendered = mount()
  await waitFor(() => expect(video()).toBeTruthy())
  video().currentTime = 12
  fireEvent.seeking(video())
  expect(owned.cancelPendingReads).toHaveBeenCalledOnce()
  rendered.unmount()
  expect(owned.close).toHaveBeenCalledOnce()
})

test('background return replaces the session and restores position without autoplay', async () => {
  const first = session('first'), second = session('second')
  mocks.create.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
  mount()
  await waitFor(() => expect(video()).toBeTruthy())
  fireEvent.loadedMetadata(video())
  video().currentTime = 37
  fireEvent.timeUpdate(video())
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
  fireEvent(document, new Event('visibilitychange'))
  expect(first.close).toHaveBeenCalledOnce()
  expect(video()).toBeNull()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  fireEvent(document, new Event('visibilitychange'))
  await waitFor(() => expect(video()?.getAttribute('src')).toBe(second.url))
  fireEvent.loadedMetadata(video())
  expect(video().currentTime).toBe(37)
  expect(video().autoplay).toBe(false)
})

test('native media network errors differ from decoding errors', async () => {
  mount()
  await waitFor(() => expect(video()).toBeTruthy())
  Object.defineProperty(video(), 'error', { configurable: true, value: { code: 2 } })
  fireEvent.error(video())
  expect(screen.getByRole('alert').textContent).toContain('网络')
  fireEvent.click(screen.getByRole('button', { name: '重试播放' }))
  await waitFor(() => expect(video()).toBeTruthy())
  Object.defineProperty(video(), 'error', { configurable: true, value: { code: 3 } })
  fireEvent.error(video())
  expect(screen.getByRole('alert').textContent).toContain('无法解码')
})

test('native stream rejection falls back only for a small video and releases the Blob on error', async () => {
  const createURL = vi.fn(() => 'blob:test-small-video'), revokeURL = vi.fn()
  vi.stubGlobal('URL', class extends URL { static createObjectURL = createURL; static revokeObjectURL = revokeURL })
  mocks.download.mockResolvedValue(new Blob([new Uint8Array(16)], { type: 'video/mp4' }))
  render(<VideoPreview vault={vault} entry={{ kind: 'file', entryId: 'small', mime: 'video/mp4', size: 16 } as never} holdIdleLock={() => vi.fn()} />)
  await waitFor(() => expect(video()).toBeTruthy())
  Object.defineProperty(video(), 'error', { configurable: true, value: { code: 4 } })
  fireEvent.error(video())
  await waitFor(() => expect(video()?.getAttribute('src')).toBe('blob:test-small-video'))
  expect(mocks.download).toHaveBeenCalledOnce()
  Object.defineProperty(video(), 'error', { configurable: true, value: { code: 4 } })
  fireEvent.error(video())
  expect(screen.getByRole('alert').textContent).toContain('无法解码')
  expect(revokeURL).toHaveBeenCalledWith('blob:test-small-video')
  vi.unstubAllGlobals()
})

test('native metadata timeout stops decryption and offers retry', async () => {
  mount()
  await waitFor(() => expect(video()).toBeTruthy())
  vi.useFakeTimers()
  // Restart the source effect with fake timers without changing the entry.
  fireEvent.error(video())
  fireEvent.click(screen.getByRole('button', { name: '重试播放' }))
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
  expect(screen.getByRole('alert').textContent).toContain('未能加载视频信息')
  expect(video()).toBeNull()
})
