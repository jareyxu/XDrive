// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { useAuthAttempt } from './use-auth-attempt'
afterEach(cleanup)
test('a replaced attempt loses ownership and cancellation cannot invalidate its replacement', () => {
  const { result } = renderHook(useAuthAttempt)
  const first = result.current.begin(), second = result.current.begin()
  expect(first.signal.aborted).toBe(true)
  expect(result.current.owns(first)).toBe(false)
  result.current.finish(first)
  expect(result.current.owns(second)).toBe(true)
  result.current.cancel()
  expect(second.signal.aborted).toBe(true)
  expect(result.current.owns(second)).toBe(false)
})
test('ordinary rerender preserves a live attempt, unmount aborts it and blocks a late completion', () => {
  const { result, rerender, unmount } = renderHook(useAuthAttempt)
  const attempt = result.current.begin()
  rerender(); expect(result.current.owns(attempt)).toBe(true)
  unmount(); expect(attempt.signal.aborted).toBe(true)
  expect(result.current.owns(attempt)).toBe(false)
})
test('finished requests release ownership without aborting their completed result', () => {
  const { result, unmount } = renderHook(useAuthAttempt)
  const attempt = result.current.begin()
  result.current.finish(attempt)
  expect(result.current.owns(attempt)).toBe(false)
  unmount(); expect(attempt.signal.aborted).toBe(false)
})
