import { afterEach, expect, test, vi } from 'vitest'
import { encryptObject, parseEncryptedObject } from './envelope'
import { wrapVaultKey } from './keys'

afterEach(() => vi.restoreAllMocks())

async function aesKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new Uint8Array(32).fill(23), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

test('each encrypted object requests a new 96-bit CSPRNG nonce', async () => {
  let requests = 0
  const entropy = vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
    if (!(array instanceof Uint8Array) || array.byteLength !== 12) throw new Error('unexpected random allocation')
    requests += 1
    array.fill(requests)
    return array
  })
  const key = await aesKey()
  const first = await encryptObject(key, new Uint8Array([1]), new Uint8Array([2]))
  const second = await encryptObject(key, new Uint8Array([3]), new Uint8Array([4]))
  const firstNonce = parseEncryptedObject(first).nonce
  const secondNonce = parseEncryptedObject(second).nonce
  expect(entropy).toHaveBeenCalledTimes(2)
  expect(firstNonce).toEqual(new Uint8Array(12).fill(1))
  expect(secondNonce).toEqual(new Uint8Array(12).fill(2))
  expect(firstNonce).not.toEqual(secondNonce)
})

test('failed envelope and key-slot encryption clear generated nonce and temporary plaintext/AAD copies', async () => {
  const key = await aesKey()
  const observedNonces: Uint8Array[] = []
  const observedInputs: Uint8Array[] = []
  let entropyValue = 0
  vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
    if (!(array instanceof Uint8Array) || array.byteLength !== 12) throw new Error('unexpected random allocation')
    entropyValue += 1
    array.fill(entropyValue)
    observedNonces.push(array)
    return array
  })
  vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(async (algorithm, _key, data) => {
    const aes = algorithm as AesGcmParams
    for (const source of [aes.iv, aes.additionalData, data]) {
      observedInputs.push(new Uint8Array(source as ArrayBuffer))
    }
    throw new Error('injected crypto failure')
  })

  await expect(encryptObject(key, new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]))).rejects.toThrow('injected crypto failure')
  await expect(wrapVaultKey(key, new Uint8Array(32).fill(9), 'slot-id-0000000001', { alg: 'argon2id', salt: 'AAAAAAAAAAAAAAAAAAAAAA==', m: 32768, t: 2, p: 1 })).rejects.toThrow('injected crypto failure')

  expect(observedNonces).toHaveLength(2)
  for (const nonce of observedNonces) expect(nonce).toEqual(new Uint8Array(12))
  expect(observedInputs).toHaveLength(6)
  for (const input of observedInputs) expect(input).toEqual(new Uint8Array(input.byteLength))
})
