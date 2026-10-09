import { expect, test, vi } from 'vitest'
import fixture from '../../../tests/testdata/crypto-aead.json'
import { decodeBase64Strict, encodeBase64 } from './encoding'
import { unwrapVaultKeyBytes, wrapVaultKey } from './keys'
import type { Argon2idParams } from './constants'
const bytes = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], value => Number.parseInt(value, 16))
test.each(fixture.keySlots)('wrapped-key format $input.formatVersion matches independent Go/Node bytes', async v => {
  const key = await crypto.subtle.importKey('raw', bytes(v.keyHex), 'AES-GCM', false, ['encrypt', 'decrypt'])
  const formatVersion = v.input.formatVersion as 1 | 2
  const entropy = vi.spyOn(crypto, 'getRandomValues').mockImplementationOnce(<T extends ArrayBufferView | null>(array: T): T => {
    if (!(array instanceof Uint8Array) || array.length !== 12) throw new Error('unexpected nonce allocation')
    array.set(bytes(v.nonceHex)); return array
  })
  let slot: Awaited<ReturnType<typeof wrapVaultKey>>
  try { slot = await wrapVaultKey(key, bytes(v.plaintextHex), v.input.slotId, v.input.kdf as Argon2idParams, v.input.configRevision, formatVersion) } finally { entropy.mockRestore() }
  expect(decodeBase64Strict(slot.wrapped.nonce)).toEqual(bytes(v.nonceHex))
  expect(decodeBase64Strict(slot.wrapped.ciphertext)).toEqual(bytes(v.ciphertextHex))
  const configuration = { formatVersion, revision: v.input.configRevision, slots: [slot] }
  expect(await unwrapVaultKeyBytes(key, configuration)).toEqual(bytes(v.plaintextHex))
  for (const field of ['nonce', 'ciphertext'] as const) {
    const value = decodeBase64Strict(slot.wrapped[field])
    for (let offset = 0; offset < value.length; offset++) for (let bit = 1; bit <= 128; bit *= 2) {
      const changed = value.slice(); changed[offset] = changed[offset]! ^ bit
      await expect(unwrapVaultKeyBytes(key, { ...configuration, slots: [{ ...slot, wrapped: { ...slot.wrapped, [field]: encodeBase64(changed) } }] })).rejects.toMatchObject({ name: 'OperationError' })
    }
  }
  for (const config of [
    { ...configuration, formatVersion: (formatVersion === 1 ? 2 : 1) as 1 | 2 },
    { ...configuration, revision: configuration.revision + 1 },
    { ...configuration, slots: [{ ...slot, slotId: `${slot.slotId}-changed` }] },
    { ...configuration, slots: [{ ...slot, kdf: { ...slot.kdf, t: slot.kdf.t + 1 } }] },
  ]) await expect(unwrapVaultKeyBytes(key, config)).rejects.toMatchObject({ name: 'OperationError' })
  const decrypt = vi.spyOn(crypto.subtle, 'decrypt')
  try {
    for (const unsupported of [0, 3, 255]) await expect(unwrapVaultKeyBytes(key, { ...configuration, formatVersion: unsupported as 1 | 2 })).rejects.toBeInstanceOf(TypeError)
    expect(decrypt).not.toHaveBeenCalled()
  } finally { decrypt.mockRestore() }
})
