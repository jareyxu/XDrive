import { expect, test } from 'vitest'
import { AdaptiveConcurrency } from './policy'

test('adaptive concurrency probes gradually, backs off on a plateau and respects caps', () => {
  const policy = new AdaptiveConcurrency()
  expect(policy.value(8)).toBe(2)
  expect(policy.value(1)).toBe(1)
  policy.observe(100, 1)
  policy.observe(10000, 5001)
  expect(policy.value(8)).toBe(3)
  policy.observe(10000, 10001)
  expect(policy.value(8)).toBe(2)
  policy.observe(10000, 15001)
  expect(policy.value(8)).toBe(2)
  policy.congested(15002)
  expect(policy.value(8)).toBe(1)
})
