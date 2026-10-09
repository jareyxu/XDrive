import { expect, test } from 'vitest'
import { listKeyboardTarget } from './list-navigation'
test('large list navigation clamps boundaries and handles viewport page steps', () => {
  expect(listKeyboardTarget('End', 0, 5000, 10)).toBe(4999)
  expect(listKeyboardTarget('Home', 4999, 5000, 10)).toBe(0)
  expect(listKeyboardTarget('PageDown', 3, 5000, 10)).toBe(13)
  expect(listKeyboardTarget('PageUp', 3, 5000, 10)).toBe(0)
  expect(listKeyboardTarget('ArrowUp', 0, 5000, 10)).toBe(0)
  expect(listKeyboardTarget('ArrowDown', 4999, 5000, 10)).toBe(4999)
  expect(listKeyboardTarget('End', 0, 0, 10)).toBeNull()
  expect(listKeyboardTarget('Enter', 1, 10, 5)).toBeNull()
})
