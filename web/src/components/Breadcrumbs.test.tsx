// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { Breadcrumbs } from './Breadcrumbs'
afterEach(cleanup)
test('replaced path removes an open disclosure and its old plaintext ancestors', () => {
  const select = vi.fn()
  const items = ['root', 'old-private-parent', 'parent', 'current'].map(name => ({ id: name, name, onSelect: select }))
  const view = render(<Breadcrumbs items={items} />)
  const details = document.querySelector('details')!
  details.open = true
  view.rerender(<Breadcrumbs items={[items[0]!, { id: 'other', name: 'new-current', onSelect: select }]} />)
  expect(document.querySelector('details')).toBeNull()
  expect(document.body.textContent).not.toContain('old-private-parent')
  expect(select).not.toHaveBeenCalled()
})
test('outside pointer closes the disclosure without stealing focus', () => {
  render(<><Breadcrumbs items={['root', 'hidden', 'parent', 'current'].map(name => ({ id: name, name, onSelect: vi.fn() }))} /><button>outside</button></>)
  const details = document.querySelector('details')!
  details.open = true
  const outside = screen.getByRole('button', { name: 'outside' }); outside.focus()
  fireEvent.pointerDown(outside)
  expect(details.open).toBe(false)
  expect(document.activeElement).toBe(outside)
})
test('pointer blur without a known new focus target does not discard ancestor activation', () => {
  const select = vi.fn()
  render(<Breadcrumbs items={['root', 'hidden', 'parent', 'current'].map(name => ({ id: name, name, onSelect: select }))} />)
  const details = document.querySelector('details')!
  details.open = true
  fireEvent.blur(details.querySelector('summary')!, { relatedTarget: null })
  expect(details.open).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'hidden' }))
  expect(select).toHaveBeenCalledOnce()
  expect(details.open).toBe(false)
})
test.each([4499, 4500, 5000])('directory count %i preserves full text and threshold state', count => {
  render(<Breadcrumbs items={[{ id: 'root', name: 'root', onSelect: vi.fn() }]} count={count} />)
  const badge = screen.getByLabelText(`当前目录 ${count} 项${count === 5000 ? '，已满' : ''}`)
  expect(badge.textContent).toBe(`${count}${count === 5000 ? ' 已满' : ''}`)
  expect(badge.className.includes('warning')).toBe(count === 4500)
  expect(badge.className.includes('full')).toBe(count === 5000)
})
test('inside pointer keeps native dialog focus forwarding from hiding the clicked ancestor', () => {
  const select = vi.fn()
  render(<dialog open><Breadcrumbs items={['root', 'hidden', 'parent', 'current'].map(name => ({ id: name, name, onSelect: select }))} /></dialog>)
  const details = document.querySelector('details')!, dialog = document.querySelector('dialog')!
  details.open = true
  const button = screen.getByRole('button', { name: 'hidden' })
  fireEvent.pointerDown(button)
  fireEvent.blur(details.querySelector('summary')!, { relatedTarget: dialog })
  expect(details.open).toBe(true)
  fireEvent.click(button)
  expect(select).toHaveBeenCalledOnce()
  expect(details.open).toBe(false)
  details.open = true
  fireEvent.keyDown(details, { key: 'Tab' })
  fireEvent.blur(details.querySelector('summary')!, { relatedTarget: dialog })
  expect(details.open).toBe(false)
})
