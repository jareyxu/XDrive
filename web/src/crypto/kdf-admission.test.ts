import { afterEach, expect, test, vi } from 'vitest'
import { derivePasswordKey } from './argon-worker-client'
import { validateArgon2idParams } from './kdf'
import { encodeBase64 } from './encoding'

const params = { alg: 'argon2id', salt: 'AAECAwQFBgcICQoLDA0ODw==', m: 65536, t: 3, p: 1 }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

test('rejects oversized canonical Base64 before decoding or allocating a Worker', async () => {
  const decoder = vi.spyOn(globalThis, 'atob')
  const worker = vi.fn()
  vi.stubGlobal('Worker', worker)
  // A valid multiple-of-four Base64 string; rejection cannot rely on bad syntax.
  await expect(derivePasswordKey('synthetic admission fixture', { ...params, salt: 'A'.repeat(92) })).rejects.toThrow()
  expect(decoder).not.toHaveBeenCalled()
  expect(worker).not.toHaveBeenCalled()
})

test.each([{ m: 131073 }, { t: 1 }, { p: 4.5 }])('validates numeric admission before decoding salt: %j', override => {
  const decoder = vi.spyOn(globalThis, 'atob')
  expect(() => validateArgon2idParams({ ...params, ...override })).toThrow(RangeError)
  expect(decoder).not.toHaveBeenCalled()
})

test.each([16, 17, 63, 64])('retains canonical %i-byte salt compatibility', length => {
  const salt = encodeBase64(new Uint8Array(length).fill(29))
  expect(validateArgon2idParams({ ...params, salt }).salt).toBe(salt)
})

test.each([15, 65, 66])('rejects decoded %i-byte salt even when encoded length fits the bound', length => {
  const salt = encodeBase64(new Uint8Array(length).fill(29))
  expect(() => validateArgon2idParams({ ...params, salt })).toThrow(RangeError)
})
