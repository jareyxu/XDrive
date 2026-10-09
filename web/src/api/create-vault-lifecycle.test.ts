import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createPasswordKDF: vi.fn(),
  derivePasswordMaterials: vi.fn(),
}))

vi.mock('../crypto/keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../crypto/keys')>()
  return { ...actual, ...mocks }
})

import { createVault } from './client'

let authKey: Uint8Array

beforeEach(() => {
  vi.resetAllMocks()
  authKey = new Uint8Array(32).fill(0xa5)
  mocks.createPasswordKDF.mockResolvedValue({ alg: 'argon2id', salt: 'AAAAAAAAAAAAAAAAAAAAAA==', m: 65536, t: 3, p: 1 })
  mocks.derivePasswordMaterials.mockResolvedValue({ kek: {} as CryptoKey, authKey })
  vi.spyOn(crypto, 'getRandomValues').mockImplementation(() => { throw new Error('test random source failure') })
})

afterEach(() => vi.restoreAllMocks())

test('clears the derived auth key when Vault Key random generation fails', async () => {
  await expect(createVault({ token: 'setup-token', username: 'admin', password: 'synthetic password' }))
    .rejects.toThrow('test random source failure')

  expect(authKey).toEqual(new Uint8Array(32))
})
