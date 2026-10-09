// @vitest-environment jsdom
import { StrictMode, type ReactNode } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { fetchStorageUsage, type StorageUsage } from '../api/client'
import { APIError } from '../api/api-error'
import { StorageScreen } from '../components/StorageScreen'
import { UnlockedQueries } from './UnlockedQueries'
import { useStorageUsage } from './storage-usage'

vi.mock('../api/client', () => ({ fetchStorageUsage: vi.fn() }))
vi.mock('../preferences/preferences', async importOriginal => ({
  ...await importOriginal<object>(), usePreferences: () => ({ backupReminderDays: 30 }),
}))
afterEach(() => { cleanup(); vi.resetAllMocks() })
const usage: StorageUsage = { quotaBytes: 100, usedBytes: 10, reservedBytes: 5, trashBytes: 2, pendingBytes: 1, freeDiskBytes: 1000, availableBytes: 85, backupWarnAfterDays: 30, lastBackupAt: null }
function wrapper({ children }: { children: ReactNode }) { return <UnlockedQueries>{children}</UnlockedQueries> }
function deferred() {
  let resolve!: (value: StorageUsage) => void
  const promise = new Promise<StorageUsage>(done => { resolve = done })
  return { promise, resolve }
}

test('two usage observers share one live request and successful server counters', async () => {
  const gate = deferred()
  vi.mocked(fetchStorageUsage).mockReturnValue(gate.promise)
  const { result } = renderHook(() => [useStorageUsage(1), useStorageUsage(1)], { wrapper })
  await waitFor(() => expect(fetchStorageUsage).toHaveBeenCalledTimes(1))
  await act(async () => { gate.resolve(usage) })
  await waitFor(() => expect(result.current.every(query => query.data === usage)).toBe(true))
})

test('leaving one view keeps a shared read alive until its last unlocked observer disappears', async () => {
  const gate = deferred(); let signal!: AbortSignal
  vi.mocked(fetchStorageUsage).mockImplementation(value => { signal = value!; return gate.promise })
  function Observer() { useStorageUsage(1); return null }
  const { rerender, unmount } = render(<UnlockedQueries><Observer key="sidebar" /><Observer key="storage" /></UnlockedQueries>)
  await waitFor(() => expect(fetchStorageUsage).toHaveBeenCalledTimes(1))
  rerender(<UnlockedQueries><Observer key="sidebar" /></UnlockedQueries>)
  expect(signal.aborted).toBe(false)
  expect(fetchStorageUsage).toHaveBeenCalledTimes(1)
  unmount(); expect(signal.aborted).toBe(true)
  await act(async () => { gate.resolve(usage) })
})

test('lock unmount aborts and clears the cache; an ignored late response cannot repopulate it', async () => {
  const gate = deferred(); let signal!: AbortSignal; let client!: QueryClient
  vi.mocked(fetchStorageUsage).mockImplementation(value => { signal = value!; return gate.promise })
  const { unmount } = renderHook(() => { client = useQueryClient(); return useStorageUsage(1) }, { wrapper })
  await waitFor(() => expect(fetchStorageUsage).toHaveBeenCalledTimes(1))
  expect(client.getQueryCache().getAll()).toHaveLength(1)
  unmount(); expect(signal.aborted).toBe(true)
  expect(client.getQueryCache().getAll()).toHaveLength(0)
  await act(async () => { gate.resolve(usage) })
  expect(client.getQueryCache().getAll()).toHaveLength(0)
  vi.mocked(fetchStorageUsage).mockResolvedValue(usage)
  const fresh = renderHook(() => useStorageUsage(1), { wrapper })
  await waitFor(() => expect(fresh.result.current.data).toEqual(usage))
  expect(fetchStorageUsage).toHaveBeenCalledTimes(2)
})

test('revision change aborts the previous read and ignores its late result', async () => {
  const old = deferred(), current = deferred(); const signals: AbortSignal[] = []
  vi.mocked(fetchStorageUsage).mockImplementation(signal => { signals.push(signal!); return signals.length === 1 ? old.promise : current.promise })
  const { result, rerender } = renderHook(({ revision }) => useStorageUsage(revision), { wrapper, initialProps: { revision: 1 } })
  await waitFor(() => expect(signals).toHaveLength(1))
  rerender({ revision: 2 })
  await waitFor(() => expect(signals).toHaveLength(2))
  expect(signals[0].aborted).toBe(true)
  await act(async () => { current.resolve({ ...usage, usedBytes: 20 }); old.resolve(usage) })
  await waitFor(() => expect(result.current.data?.usedBytes).toBe(20))
})

test('StrictMode cleanup permits a real remount fetch instead of leaving a permanently cancelled query', async () => {
  vi.mocked(fetchStorageUsage).mockImplementation(async signal => { signal!.throwIfAborted(); return usage })
  const { result } = renderHook(() => useStorageUsage(1), { wrapper: ({ children }) => <StrictMode><UnlockedQueries>{children}</UnlockedQueries></StrictMode> })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(result.current.data).toEqual(usage)
})

test('failed counters have no automatic retries and retain the actual error identity', async () => {
  const error = new Error('offline')
  vi.mocked(fetchStorageUsage).mockRejectedValue(error)
  const { result } = renderHook(() => useStorageUsage(1), { wrapper })
  await waitFor(() => expect(result.current.isError).toBe(true))
  expect(result.current.error).toBe(error)
  expect(fetchStorageUsage).toHaveBeenCalledTimes(1)
})

test('a retained refresh callback cannot start another HTTP request after its unlocked owner ends', async () => {
  vi.mocked(fetchStorageUsage).mockResolvedValue(usage)
  const { result, unmount } = renderHook(() => useStorageUsage(1), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  const refresh = result.current.refetch
  unmount()
  await expect(refresh({ throwOnError: true })).rejects.toMatchObject({ name: 'AbortError' })
  expect(fetchStorageUsage).toHaveBeenCalledTimes(1)
})

test('storage refresh preserves last good counters, labels them stale and uses the new response request ID', async () => {
  vi.mocked(fetchStorageUsage).mockResolvedValueOnce(usage)
  const requestId = '0123456789abcdef0123456789abcdef'
  const error = new APIError(503, 'storage_unavailable', undefined, requestId)
  vi.mocked(fetchStorageUsage).mockRejectedValue(error)
  render(<UnlockedQueries><StorageScreen now={0} revision={1} formatBytes={String} onTrash={() => {}} onClearTrash={() => {}} clearDisabled /></UnlockedQueries>)
  await screen.findByText('10 已用，共 100')
  await waitFor(() => expect((screen.getByRole('button', { name: '刷新用量' }) as HTMLButtonElement).disabled).toBe(false))
  await act(async () => { screen.getByRole('button', { name: '刷新用量' }).click() })
  await waitFor(() => expect((screen.getByRole('textbox', { name: '\u8bf7\u6c42\u7f16\u53f7' }) as HTMLInputElement).value).toBe(requestId))
  expect(screen.getByRole('alert').textContent).toContain('上次读取')
  expect(screen.getByText('10 已用，共 100')).toBeTruthy()
  expect(fetchStorageUsage).toHaveBeenCalledTimes(2)
})

test('two observers changing revision replace one stale read, preserving last good data through a failed refresh', async () => {
  vi.mocked(fetchStorageUsage).mockResolvedValueOnce(usage)
  const { result, rerender } = renderHook(({ revision }) => [useStorageUsage(revision), useStorageUsage(revision)], { wrapper, initialProps: { revision: 1 } })
  await waitFor(() => expect(result.current.every(query => query.data === usage)).toBe(true))
  const error = new Error('offline')
  vi.mocked(fetchStorageUsage).mockRejectedValue(error)
  rerender({ revision: 2 })
  await waitFor(() => expect(result.current.every(query => query.isError)).toBe(true))
  expect(result.current.every(query => query.data === usage && query.error === error)).toBe(true)
  expect(fetchStorageUsage).toHaveBeenCalledTimes(2)
})

test('task quota read supersedes an older observer read and publishes directly to both observers', async () => {
  const old = deferred(), fresh = deferred(); const signals: (AbortSignal | undefined)[] = []
  vi.mocked(fetchStorageUsage).mockImplementation(signal => { signals.push(signal); return signals.length === 1 ? old.promise : fresh.promise })
  const { result } = renderHook(() => [useStorageUsage(1), useStorageUsage(1)], { wrapper })
  await waitFor(() => expect(signals).toHaveLength(1))
  const controller = new AbortController()
  let request!: Promise<StorageUsage>
  await act(async () => { request = result.current[0].read(controller.signal); await Promise.resolve() })
  await waitFor(() => expect(signals).toHaveLength(2))
  expect(signals[0]?.aborted).toBe(true); expect(signals[1]).toBe(controller.signal)
  await act(async () => { fresh.resolve({ ...usage, usedBytes: 20 }); await request; old.resolve(usage) })
  await waitFor(() => expect(result.current.every(query => query.data?.usedBytes === 20)).toBe(true))
})

test('an ignored late task quota response cannot publish after abort or unlock owner close', async () => {
  for (const action of ['abort', 'close'] as const) {
    vi.mocked(fetchStorageUsage).mockResolvedValueOnce(usage)
    let client!: QueryClient
    const { result, unmount } = renderHook(() => { client = useQueryClient(); return useStorageUsage(1) }, { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const gate = deferred(); vi.mocked(fetchStorageUsage).mockReturnValueOnce(gate.promise)
    const controller = new AbortController()
    const request = result.current.read(controller.signal)
    const failure = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    await waitFor(() => expect(fetchStorageUsage).toHaveBeenLastCalledWith(controller.signal))
    if (action === 'abort') controller.abort(); else unmount()
    await act(async () => { gate.resolve({ ...usage, usedBytes: 90 }); await failure })
    if (action === 'abort') expect(client.getQueryData(['storage-usage'])).toBe(usage)
    else expect(client.getQueryCache().getAll()).toHaveLength(0)
    unmount(); vi.resetAllMocks()
  }
})

test('retained task read rejects a closed owner before starting HTTP', async () => {
  vi.mocked(fetchStorageUsage).mockResolvedValue(usage)
  const { result, unmount } = renderHook(() => useStorageUsage(1), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  const read = result.current.read; unmount()
  await expect(read(new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(fetchStorageUsage).toHaveBeenCalledTimes(1)
})
