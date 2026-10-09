// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { VirtualEntryList } from './VirtualEntryList'

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 180 })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 900 })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 180 })
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value(this: HTMLElement, options: ScrollToOptions) { this.scrollTop = options.top ?? 0; this.dispatchEvent(new Event('scroll')) } })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const entries = Array.from({ length: 5000 }, (_, index) => ({ id: `entry-${index}`, name: `file-${index}` }))
function list() {
  return render(<VirtualEntryList entries={entries} itemKey={(entry) => entry.id} renderEntry={(entry) => <div role="listitem"><button>{entry.name}</button><input aria-label={`select-${entry.name}`} type="checkbox" /></div>} />)
}
test('5000 entries render only a bounded visible range, with full collection ARIA positions', () => {
  const view = list()
  const rows = view.getAllByRole('listitem')
  expect(rows.length).toBeLessThan(40)
  expect(rows[0]!.getAttribute('aria-setsize')).toBe('5000')
  expect(rows[0]!.getAttribute('aria-posinset')).toBe('1')
  expect(view.queryByRole('button', { name: 'file-4999' })).toBeNull()
})
test('End/Home navigate beyond mounted rows, preserve focus and keep the DOM bounded', async () => {
  const view = list()
  const first = view.getAllByRole('listitem')[0]!
  first.focus()
  fireEvent.keyDown(first, { key: 'End' })
  await waitFor(() => expect(document.activeElement?.getAttribute('aria-posinset')).toBe('5000'))
  expect(view.getAllByRole('listitem').length).toBeLessThan(40)
  fireEvent.keyDown(document.activeElement!, { key: 'Home' })
  await waitFor(() => expect(document.activeElement?.getAttribute('aria-posinset')).toBe('1'))
})
test('checkbox keys are not intercepted and Enter on child buttons remains native', () => {
  const view = list()
  const checkbox = view.getByRole('checkbox', { name: 'select-file-0' })
  const key = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
  checkbox.dispatchEvent(key)
  expect(key.defaultPrevented).toBe(false)
  const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  view.getByRole('button', { name: 'file-0' }).dispatchEvent(enter)
  expect(enter.defaultPrevented).toBe(false)
})
