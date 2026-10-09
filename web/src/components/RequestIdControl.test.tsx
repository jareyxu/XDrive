// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { APIError } from '../api/api-error'
import { RequestIdControl } from './RequestIdControl'
import { useErrorNotice } from './use-error-notice'
const first = 'a123456789abcdef0123456789abcdef', second = 'b123456789abcdef0123456789abcdef'
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function clipboard(writeText?: (text: string) => Promise<void>) {
  vi.stubGlobal('navigator', { clipboard: writeText ? { writeText } : undefined })
}
test('copy writes only the associated ID, not the surrounding message or document', async () => {
  const write = vi.fn().mockResolvedValue(undefined); clipboard(write)
  render(<RequestIdControl requestId={first} />)
  fireEvent.click(screen.getByRole('button', { name: '复制请求编号' }))
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('请求编号已复制。'))
  expect(write).toHaveBeenCalledExactlyOnceWith(first)
})
test('clipboard denial selects the read-only ID and explains manual copying', async () => {
  clipboard(vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')))
  render(<RequestIdControl requestId={first} />)
  fireEvent.click(screen.getByRole('button', { name: '复制请求编号' }))
  const input = screen.getByRole('textbox', { name: '请求编号' }) as HTMLInputElement
  await waitFor(() => expect(document.activeElement).toBe(input))
  expect(input.readOnly).toBe(true)
  expect(input.selectionStart).toBe(0); expect(input.selectionEnd).toBe(first.length)
  expect(screen.getByRole('status').textContent).toContain('手动复制')
})
test('missing clipboard offers the same manual-copy fallback', async () => {
  clipboard(); render(<RequestIdControl requestId={first} />)
  fireEvent.click(screen.getByRole('button', { name: '复制请求编号' }))
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('手动复制'))
})
test('a replaced request cannot inherit a late clipboard completion or copied status', async () => {
  let release!: () => void
  clipboard(() => new Promise<void>(resolve => { release = resolve }))
  const { rerender } = render(<RequestIdControl requestId={first} />)
  fireEvent.click(screen.getByRole('button', { name: '复制请求编号' }))
  rerender(<RequestIdControl requestId={second} />)
  await act(async () => release())
  expect(screen.getByRole('status').textContent).toBe('')
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(second)
})
test('missing or untrusted IDs render no copy action', () => {
  const { rerender } = render(<RequestIdControl />)
  expect(screen.queryByRole('button')).toBeNull()
  rerender(<RequestIdControl requestId={'<script>secret</script>'} />)
  expect(screen.queryByRole('textbox')).toBeNull()
})
test('local errors, resets and replacements cannot reuse the previous API request ID', () => {
  const { result, rerender } = renderHook(useErrorNotice)
  act(() => result.current[1]('失败', new APIError(500, 'storage_unavailable', undefined, first)))
  expect(result.current[2]).toBe(first)
  act(() => result.current[1](current => current || '读取失败', new Error('less specific error')))
  expect(result.current[2]).toBe(first)
  const setter = result.current[1]; rerender(); expect(result.current[1]).toBe(setter)
  act(() => result.current[1]('本地校验失败'))
  expect(result.current[2]).toBeUndefined()
  act(() => result.current[1]('其他请求失败', new APIError(500, 'request_failed', undefined, second)))
  expect(result.current[2]).toBe(second)
  act(() => result.current[1](''))
  expect(result.current[0]).toBe(''); expect(result.current[2]).toBeUndefined()
})
