// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { VirtualEntryGrid } from './VirtualEntryGrid'
beforeEach(() => {
 for (const key of ['offsetHeight', 'clientHeight']) Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => 400 })
 for (const key of ['offsetWidth', 'clientWidth']) Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => 800 })
 Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value(this: HTMLElement, options: ScrollToOptions) { this.scrollTop = options.top ?? 0; this.dispatchEvent(new Event('scroll')) } })
 vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
 vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const entries = Array.from({ length: 5000 }, (_, i) => ({ id: String(i), name: `file-${i}` }))
const grid = () => render(<VirtualEntryGrid entries={entries} itemKey={entry => entry.id} renderEntry={entry => <div role="listitem"><button>{entry.name}</button><input aria-label={`select-${entry.name}`} type="checkbox" /></div>} />)
test('5000 grid cards have bounded DOM, row virtualization and full ARIA positions', () => {
 const view = grid()
 expect(view.getByRole('list')).toHaveProperty('dataset.columns', '4')
 expect(view.getAllByRole('listitem').length).toBeLessThan(40)
 expect(view.getAllByRole('listitem')[0]!.getAttribute('aria-setsize')).toBe('5000')
 expect(view.queryByRole('button', { name: 'file-4999' })).toBeNull()
})
test('End/Home reach unmounted cards and arrows follow the grid columns', async () => {
 const view = grid(), first = view.getAllByRole('listitem')[0]!
 first.focus(); fireEvent.keyDown(first, { key: 'ArrowDown' })
 await waitFor(() => expect(document.activeElement?.getAttribute('aria-posinset')).toBe('5'))
 fireEvent.keyDown(document.activeElement!, { key: 'End' })
 await waitFor(() => expect(document.activeElement?.getAttribute('aria-posinset')).toBe('5000'))
 expect(view.getAllByRole('listitem').length).toBeLessThan(40)
 fireEvent.keyDown(document.activeElement!, { key: 'Home' })
 await waitFor(() => expect(document.activeElement?.getAttribute('aria-posinset')).toBe('1'))
})
test('compact grid fits two readable columns at phone width and checkbox navigation remains native', () => {
 vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
 for (const key of ['offsetWidth', 'clientWidth']) Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => 340 })
 const view = grid(); expect(view.getByRole('list').dataset.columns).toBe('2')
 const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
 view.getByRole('checkbox', { name: 'select-file-0' }).dispatchEvent(event); expect(event.defaultPrevented).toBe(false)
})
