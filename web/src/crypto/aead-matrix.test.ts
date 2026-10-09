import { expect, test, vi } from 'vitest'
import fixture from '../../../tests/testdata/crypto-aead.json'
import { decryptObject, encryptObject, parseEncryptedObject } from './envelope'
const bytes = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], value => Number.parseInt(value, 16))

test.each(fixture.vectors)('$name reproduces full envelope and rejects every-bit AEAD mutations', async vector => {
  const rawKey = bytes(vector.keyHex), nonce = bytes(vector.nonceHex), aad = bytes(vector.aadHex), plaintext = bytes(vector.plaintextHex), envelope = bytes(vector.envelopeHex)
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt', 'decrypt'])
  // Fixed nonce injection is local to this one test; production retains real entropy.
  const entropy = vi.spyOn(crypto, 'getRandomValues').mockImplementationOnce(<T extends ArrayBufferView | null>(array: T): T => {
    if (!(array instanceof Uint8Array) || array.length !== 12) throw new Error('unexpected nonce allocation')
    array.set(nonce); return array
  })
  let encrypted: Uint8Array
  try { encrypted = await encryptObject(key, plaintext, aad) } finally { entropy.mockRestore() }
  expect(encrypted).toEqual(envelope)
  expect(encrypted.length).toBe(plaintext.length + 36)
  expect(await decryptObject(key, envelope, aad)).toEqual(plaintext)
  for (const [begin, end] of [[8, 20], [20, envelope.length - 16], [envelope.length - 16, envelope.length]]) {
    for (let offset = begin!; offset < end!; offset++) for (let bit = 1; bit <= 128; bit *= 2) {
      const changed = envelope.slice(); changed[offset] = changed[offset]! ^ bit
      await expect(decryptObject(key, changed, aad)).rejects.toMatchObject({ name: 'OperationError' })
    }
  }
  for (let offset = 0; offset < aad.length; offset++) for (let bit = 1; bit <= 128; bit *= 2) {
    const changed = aad.slice(); changed[offset] = changed[offset]! ^ bit
    await expect(decryptObject(key, envelope, changed)).rejects.toMatchObject({ name: 'OperationError' })
  }
  const wrong = rawKey.slice(); wrong[0] = wrong[0]! ^ 1
  const wrongKey = await crypto.subtle.importKey('raw', wrong, 'AES-GCM', false, ['decrypt'])
  await expect(decryptObject(wrongKey, envelope, aad)).rejects.toMatchObject({ name: 'OperationError' })
})

test('unknown/destructive envelope headers and short tags reject before AEAD', async () => {
  const envelope = bytes(fixture.vectors[0]!.envelopeHex)
  const key = await crypto.subtle.importKey('raw', bytes(fixture.vectors[0]!.keyHex), 'AES-GCM', false, ['decrypt'])
  const decrypt = vi.spyOn(crypto.subtle, 'decrypt')
  try {
    for (let offset = 0; offset < 8; offset++) for (let bit = 1; bit <= 128; bit *= 2) {
      const changed = envelope.slice(); changed[offset] = changed[offset]! ^ bit
      expect(() => parseEncryptedObject(changed)).toThrow(TypeError)
      await expect(decryptObject(key, changed, bytes(fixture.vectors[0]!.aadHex))).rejects.toBeInstanceOf(TypeError)
    }
    for (let length = 0; length < 36; length++) expect(() => parseEncryptedObject(envelope.slice(0, length))).toThrow(TypeError)
    expect(decrypt).not.toHaveBeenCalled()
  } finally { decrypt.mockRestore() }
})
