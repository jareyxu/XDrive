import { describe, expect, it, vi } from 'vitest'
const { derivePasswordKeyMock } = vi.hoisted(() => ({ derivePasswordKeyMock: vi.fn() }))
vi.mock('./argon-worker-client', () => ({ derivePasswordKey: derivePasswordKeyMock }))
import vectors from '../../../tests/testdata/crypto-v1.json'
import vectorsV2 from '../../../tests/testdata/crypto-v2.json'
import { chunkAAD, indexAAD, keySlotAAD, localStateAAD, manifestAAD, thumbnailAAD } from './aad'
import { decodeBase64Strict, encodeBase64 } from './encoding'
import { decryptObject, parseEncryptedObject } from './envelope'
import { validateArgon2idParams } from './kdf'
import { deriveDataKey, deriveFileKey, deriveIndexId, derivePasswordMaterials, deriveThumbnailKey, importVaultKey, unwrapVaultKey, unwrapVaultKeyBytes, wrapVaultKey } from './keys'

const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
const fromHex = (value: string) => Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16))
const NativeUint8Array = globalThis.Uint8Array

function failUint8ArrayViewFor(buffer: ArrayBuffer, message: string): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Uint8Array')!
  const Native = descriptor.value as typeof Uint8Array
  const replacement = new Proxy(Native, {
    construct(target, args, newTarget) {
      if (args[0] === buffer) throw new Error(message)
      return Reflect.construct(target, args, newTarget)
    },
  })
  Object.defineProperty(globalThis, 'Uint8Array', { ...descriptor, value: replacement })
  return () => Object.defineProperty(globalThis, 'Uint8Array', descriptor)
}

describe('V1 shared crypto vectors', () => {
  it('encodes every AAD structure byte-for-byte', () => {
    expect(hex(keySlotAAD(vectors.keySlot.input as Parameters<typeof keySlotAAD>[0]))).toBe(vectors.keySlot.aadHex)
    expect(hex(chunkAAD(vectors.chunk.input))).toBe(vectors.chunk.aadHex)
    expect(hex(manifestAAD(vectors.manifest.fileId))).toBe(vectors.manifest.aadHex)
    expect(hex(thumbnailAAD(vectors.thumbnail.fileId))).toBe(vectors.thumbnail.aadHex)
    expect(hex(indexAAD(vectors.index.metadataId, vectors.index.revision))).toBe(vectors.index.aadHex)
    expect(hex(localStateAAD(vectors.localState.recordType, vectors.localState.recordId))).toBe(vectors.localState.aadHex)
  })

  it('decrypts the shared AES-256-GCM envelope and rejects a changed AAD', async () => {
    const fixture = vectors.encryptedObject
    const encryptedObject = fromHex(fixture.envelopeHex)
    const key = await crypto.subtle.importKey(
      'raw', fromHex(fixture.keyHex),
      { name: 'AES-GCM' }, false, ['decrypt'],
    )
    const plaintext = await decryptObject(key, encryptedObject, fromHex(fixture.aadHex))
    expect(hex(plaintext)).toBe(fixture.plaintextHex)
    await expect(decryptObject(key, encryptedObject, new Uint8Array([1]))).rejects.toThrow()
  })

  it('clears temporary decrypt inputs after success and authentication failure', async () => {
    const fixture = vectors.encryptedObject
    const encryptedObject = fromHex(fixture.envelopeHex)
    const aad = fromHex(fixture.aadHex)
    const key = await crypto.subtle.importKey('raw', fromHex(fixture.keyHex), 'AES-GCM', false, ['decrypt'])
    const originalDecrypt = crypto.subtle.decrypt.bind(crypto.subtle)
    const observedInputs: Uint8Array[] = []
    const capture = (value: BufferSource): void => {
      if (value instanceof ArrayBuffer) observedInputs.push(new Uint8Array(value))
      else if (ArrayBuffer.isView(value)) observedInputs.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
    }
    const decryptSpy = vi.spyOn(crypto.subtle, 'decrypt').mockImplementation((algorithm, decryptKey, data) => {
      const params = algorithm as AesGcmParams
      capture(params.iv)
      if (params.additionalData) capture(params.additionalData)
      capture(data)
      return originalDecrypt(algorithm, decryptKey, data)
    })

    try {
      const plaintext = await decryptObject(key, encryptedObject, aad)
      expect(plaintext).toEqual(fromHex(fixture.plaintextHex))
      plaintext.fill(0)
      expect(observedInputs).toHaveLength(3)
      for (const input of observedInputs) expect(input).toEqual(new Uint8Array(input.byteLength))

      observedInputs.length = 0
      const tampered = encryptedObject.slice()
      tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1
      await expect(decryptObject(key, tampered, aad)).rejects.toMatchObject({ name: 'OperationError' })
      expect(observedInputs).toHaveLength(3)
      for (const input of observedInputs) expect(input).toEqual(new Uint8Array(input.byteLength))
    } finally { decryptSpy.mockRestore() }
  })
})

describe('V2 shared crypto vectors', () => {
  it('encodes V2 AAD and key-slot bytes byte-for-byte', () => {
    expect(hex(keySlotAAD(vectorsV2.keySlot.input as Parameters<typeof keySlotAAD>[0]))).toBe(vectorsV2.keySlot.aadHex)
    expect(hex(chunkAAD(vectorsV2.chunk.input, 2))).toBe(vectorsV2.chunk.aadHex)
    expect(hex(manifestAAD(vectorsV2.manifest.fileId, 2))).toBe(vectorsV2.manifest.aadHex)
    expect(hex(thumbnailAAD(vectorsV2.thumbnail.fileId, 2))).toBe(vectorsV2.thumbnail.aadHex)
  })

  it('derives the versioned key hierarchy and preserves the V1 direct derivation', async () => {
    const fixture = vectorsV2.keyDerivation
    const vaultKey = await importVaultKey(fromHex(fixture.vaultKeyHex))
    const dataKey = await deriveDataKey(vaultKey)
    const dataBits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('xdrive/v1/data') }, vaultKey, 256))
    expect(hex(dataBits)).toBe(fixture.dataKeyHex)
    dataBits.fill(0)
    const fileBits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(fixture.fileId), info: new TextEncoder().encode('xdrive/v1/file') }, dataKey, 256))
    const thumbnailBits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(fixture.fileId), info: new TextEncoder().encode('xdrive/v1/thumb') }, dataKey, 256))
    expect(hex(fileBits)).toBe(fixture.fileKeyHex)
    expect(hex(thumbnailBits)).toBe(fixture.thumbnailKeyHex)
    const plaintext = new TextEncoder().encode('versioned file fixture')
    const fileKeyV2 = await deriveFileKey(vaultKey, dataKey, fixture.fileId, 2)
    const encryptedV2 = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12), additionalData: fromHex(vectorsV2.manifest.aadHex), tagLength: 128 }, fileKeyV2, plaintext)
    expect(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(12), additionalData: fromHex(vectorsV2.manifest.aadHex), tagLength: 128 }, fileKeyV2, encryptedV2))).toEqual(plaintext)
    const fileKeyV1 = await deriveFileKey(vaultKey, dataKey, fixture.fileId, 1)
    const thumbKeyV1 = await deriveThumbnailKey(vaultKey, dataKey, fixture.fileId, 1)
    expect(fileKeyV1.extractable).toBe(false)
    expect(thumbKeyV1.extractable).toBe(false)
    fileBits.fill(0); thumbnailBits.fill(0)
  })

  it('round-trips legacy and V2 key slots and binds the selected config version', async () => {
    const kek = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(9), 'AES-GCM', false, ['encrypt', 'decrypt'])
    const vaultBytes = new Uint8Array(32).fill(4)
    const kdf = { alg: 'argon2id' as const, salt: 'AAECAwQFBgcICQoLDA0ODw==', m: 65536, t: 3, p: 1 }
    for (const formatVersion of [1, 2] as const) {
      const slot = await wrapVaultKey(kek, vaultBytes, `slot-v${formatVersion}`, kdf, 1, formatVersion)
      const configuration = { formatVersion, revision: 1, slots: [slot] }
      const opened = await unwrapVaultKeyBytes(kek, configuration)
      expect(opened).toEqual(vaultBytes)
      opened.fill(0)
      const changed = { ...configuration, formatVersion: formatVersion === 1 ? 2 as const : 1 as const }
      await expect(unwrapVaultKeyBytes(kek, changed)).rejects.toThrow()
    }
    vaultBytes.fill(0)
  })

  it('clears decoded key-slot inputs and Web Crypto copies after decrypt success or authentication failure', async () => {
    const originalDecrypt = crypto.subtle.decrypt.bind(crypto.subtle)
    const kek = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(0x2d), 'AES-GCM', false, ['encrypt', 'decrypt'])
    const kdf = { alg: 'argon2id' as const, salt: 'AAECAwQFBgcICQoLDA0ODw==', m: 65536, t: 3, p: 1 }

    for (const corruptCiphertext of [false, true]) {
      const vaultBytes = new Uint8Array(32).fill(0x71)
      const slot = await wrapVaultKey(kek, vaultBytes, `slot-input-cleanup-${corruptCiphertext}`, kdf)
      vaultBytes.fill(0)
      let wrapped = slot
      if (corruptCiphertext) {
        const ciphertext = decodeBase64Strict(slot.wrapped.ciphertext)
        ciphertext[0] = ciphertext[0]! ^ 1
        wrapped = { ...slot, wrapped: { ...slot.wrapped, ciphertext: encodeBase64(ciphertext) } }
        ciphertext.fill(0)
      }
      const configuration = { formatVersion: 1 as const, revision: 1, slots: [wrapped] }
      const observedInputs: Uint8Array[] = []
      const capture = (value: BufferSource): void => {
        if (value instanceof ArrayBuffer) observedInputs.push(new Uint8Array(value))
        else if (ArrayBuffer.isView(value)) observedInputs.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
      }
      const decryptSpy = vi.spyOn(crypto.subtle, 'decrypt').mockImplementation((algorithm, key, data) => {
        const params = algorithm as AesGcmParams
        capture(params.iv)
        if (params.additionalData) capture(params.additionalData)
        capture(data)
        return originalDecrypt(algorithm, key, data)
      })

      try {
        if (corruptCiphertext) {
          await expect(unwrapVaultKeyBytes(kek, configuration)).rejects.toMatchObject({ name: 'OperationError' })
        } else {
          const unwrapped = await unwrapVaultKeyBytes(kek, configuration)
          expect(unwrapped).toEqual(new Uint8Array(32).fill(0x71))
          unwrapped.fill(0)
        }
        expect(observedInputs).toHaveLength(3)
        for (const input of observedInputs) expect(input).toEqual(new Uint8Array(input.byteLength))
      } finally { decryptSpy.mockRestore() }
    }
  })

  it('clears temporary raw Vault Key copies after Web Crypto import', async () => {
    const originalImportKey = crypto.subtle.importKey.bind(crypto.subtle)
    const importedBuffers: Uint8Array[] = []
    const spy = vi.spyOn(crypto.subtle, 'importKey').mockImplementation((format, keyData, algorithm, extractable, keyUsages) => {
      if (format === 'raw' && keyData instanceof ArrayBuffer) importedBuffers.push(new Uint8Array(keyData))
      return originalImportKey(format, keyData, algorithm, extractable, keyUsages)
    })

    try {
      const rawVaultKey = new Uint8Array(32).fill(37)
      await importVaultKey(rawVaultKey)
      expect(rawVaultKey).toEqual(new Uint8Array(32).fill(37))
      expect(importedBuffers[0]).toEqual(new Uint8Array(32))

      const kek = await originalImportKey('raw', new Uint8Array(32).fill(11), 'AES-GCM', false, ['encrypt', 'decrypt'])
      const vaultBytes = new Uint8Array(32).fill(83)
      const kdf = { alg: 'argon2id' as const, salt: 'AAECAwQFBgcICQoLDA0ODw==', m: 65536, t: 3, p: 1 }
      const slot = await wrapVaultKey(kek, vaultBytes, 'slot-cleanup', kdf)
      const configuration = { formatVersion: 1 as const, revision: 1, slots: [slot] }
      const beforeUnwrap = importedBuffers.length
      const unwrapped = await unwrapVaultKey(kek, configuration)
      expect(unwrapped.extractable).toBe(false)
      expect(importedBuffers).toHaveLength(beforeUnwrap + 1)
      expect(importedBuffers[beforeUnwrap]).toEqual(new Uint8Array(32))
      vaultBytes.fill(0)
    } finally { spy.mockRestore() }
  })

  it('clears the unwrapped Vault Key when allocating the Web Crypto import copy fails', async () => {
    const rawVaultKey = new Uint8Array(32).fill(0x5a)
    const decryptSpy = vi.spyOn(crypto.subtle, 'decrypt').mockResolvedValue(rawVaultKey.buffer)
    const originalSlice = Uint8Array.prototype.slice
    const sliceSpy = vi.spyOn(Uint8Array.prototype, 'slice').mockImplementation(function (this: Uint8Array, start?: number, end?: number) {
      if (this.buffer === rawVaultKey.buffer) throw new Error('Vault Key copy allocation failed')
      return originalSlice.call(this, start, end)
    })
    const configuration = {
      formatVersion: 1 as const,
      revision: 1,
      slots: [{
        slotId: 'allocation-failure',
        type: 'password' as const,
        kdf: { ...vectors.keySlot.input.kdf, alg: 'argon2id' as const },
        wrapped: { nonce: encodeBase64(new Uint8Array(12)), ciphertext: encodeBase64(new Uint8Array(48)) },
      }],
    }

    try {
      await expect(unwrapVaultKey({} as CryptoKey, configuration)).rejects.toThrow('Vault Key copy allocation failed')
      expect(rawVaultKey).toEqual(new Uint8Array(32))
    } finally {
      sliceSpy.mockRestore()
      decryptSpy.mockRestore()
    }
  })

  it('clears unwrapped Vault Key bytes when creating the first typed-array view fails', async () => {
    const plaintextBuffer = new ArrayBuffer(32)
    new NativeUint8Array(plaintextBuffer).fill(0x3c)
    const decryptSpy = vi.spyOn(crypto.subtle, 'decrypt').mockResolvedValue(plaintextBuffer)
    const configuration = {
      formatVersion: 1 as const,
      revision: 1,
      slots: [{
        slotId: 'view-allocation-failure',
        type: 'password' as const,
        kdf: { ...vectors.keySlot.input.kdf, alg: 'argon2id' as const },
        wrapped: { nonce: encodeBase64(new NativeUint8Array(12)), ciphertext: encodeBase64(new NativeUint8Array(48)) },
      }],
    }
    const restoreConstructor = failUint8ArrayViewFor(plaintextBuffer, 'Vault Key view allocation failed')

    try {
      await expect(unwrapVaultKeyBytes({} as CryptoKey, configuration)).rejects.toThrow('Vault Key view allocation failed')
      expect(new NativeUint8Array(plaintextBuffer)).toEqual(new NativeUint8Array(32))
    } finally {
      restoreConstructor()
      decryptSpy.mockRestore()
    }
  })

  it('clears derived data-root bytes when allocating the Web Crypto import copy fails', async () => {
    const derivedBytes = new Uint8Array(32).fill(0x6b)
    const deriveBitsSpy = vi.spyOn(crypto.subtle, 'deriveBits').mockResolvedValue(derivedBytes.buffer)
    const originalSlice = Uint8Array.prototype.slice
    const sliceSpy = vi.spyOn(Uint8Array.prototype, 'slice').mockImplementation(function (this: Uint8Array, start?: number, end?: number) {
      if (this.buffer === derivedBytes.buffer) throw new Error('data-root copy allocation failed')
      return originalSlice.call(this, start, end)
    })

    try {
      await expect(deriveDataKey({} as CryptoKey)).rejects.toThrow('data-root copy allocation failed')
      expect(derivedBytes).toEqual(new Uint8Array(32))
    } finally {
      sliceSpy.mockRestore()
      deriveBitsSpy.mockRestore()
    }
  })

  it('clears derived data-root bytes when creating the first typed-array view fails', async () => {
    const derivedBuffer = new ArrayBuffer(32)
    new NativeUint8Array(derivedBuffer).fill(0x6b)
    const deriveBitsSpy = vi.spyOn(crypto.subtle, 'deriveBits').mockResolvedValue(derivedBuffer)
    const restoreConstructor = failUint8ArrayViewFor(derivedBuffer, 'data-root view allocation failed')

    try {
      await expect(deriveDataKey({} as CryptoKey)).rejects.toThrow('data-root view allocation failed')
      expect(new NativeUint8Array(derivedBuffer)).toEqual(new NativeUint8Array(32))
    } finally {
      restoreConstructor()
      deriveBitsSpy.mockRestore()
    }
  })

  it('clears derived index-id bytes when creating the first typed-array view fails', async () => {
    const derivedBuffer = new ArrayBuffer(32)
    new NativeUint8Array(derivedBuffer).fill(0x4e)
    const deriveBitsSpy = vi.spyOn(crypto.subtle, 'deriveBits').mockResolvedValue(derivedBuffer)
    const restoreConstructor = failUint8ArrayViewFor(derivedBuffer, 'index-id view allocation failed')

    try {
      await expect(deriveIndexId({} as CryptoKey, 'root')).rejects.toThrow('index-id view allocation failed')
      expect(new NativeUint8Array(derivedBuffer)).toEqual(new NativeUint8Array(32))
    } finally {
      restoreConstructor()
      deriveBitsSpy.mockRestore()
    }
  })

  it('clears a decrypted plaintext ArrayBuffer when creating its view fails', async () => {
    const plaintextBuffer = new ArrayBuffer(24)
    new NativeUint8Array(plaintextBuffer).fill(0x77)
    const decryptSpy = vi.spyOn(crypto.subtle, 'decrypt').mockResolvedValue(plaintextBuffer)
    const fixture = vectors.encryptedObject
    const encryptedObject = fromHex(fixture.envelopeHex)
    const aad = fromHex(fixture.aadHex)
    const key = await crypto.subtle.importKey('raw', fromHex(fixture.keyHex), 'AES-GCM', false, ['decrypt'])
    const restoreConstructor = failUint8ArrayViewFor(plaintextBuffer, 'plaintext view allocation failed')

    try {
      await expect(decryptObject(key, encryptedObject, aad)).rejects.toThrow('plaintext view allocation failed')
      expect(new NativeUint8Array(plaintextBuffer)).toEqual(new NativeUint8Array(24))
    } finally {
      restoreConstructor()
      decryptSpy.mockRestore()
    }
  })
})

describe('password material cleanup', () => {
  it('waits for both HKDF operations and clears a late auth-key result when KEK derivation fails', async () => {
    const passwordKey = new Uint8Array(32).fill(21)
    derivePasswordKeyMock.mockResolvedValue(passwordKey)
    let finishAuthDerivation!: (value: ArrayBuffer) => void
    const authBuffer = new ArrayBuffer(32)
    new Uint8Array(authBuffer).fill(99)
    const deriveKeySpy = vi.spyOn(crypto.subtle, 'deriveKey').mockRejectedValue(new Error('KEK derivation failed'))
    const deriveBitsSpy = vi.spyOn(crypto.subtle, 'deriveBits').mockImplementation(() => new Promise<ArrayBuffer>((resolve) => { finishAuthDerivation = resolve }))

    try {
      let settled = false
      const attempt = derivePasswordMaterials('synthetic password', vectors.keySlot.input.kdf).finally(() => { settled = true })
      await vi.waitFor(() => expect(finishAuthDerivation).toBeTypeOf('function'))
      expect(settled).toBe(false)
      finishAuthDerivation(authBuffer)
      await expect(attempt).rejects.toThrow('KEK derivation failed')
      expect(new Uint8Array(authBuffer)).toEqual(new Uint8Array(32))
      expect(passwordKey).toEqual(new Uint8Array(32))
    } finally {
      deriveKeySpy.mockRestore()
      deriveBitsSpy.mockRestore()
      derivePasswordKeyMock.mockReset()
    }
  })

  it('clears the authentication-key ArrayBuffer when creating its first view fails', async () => {
    const passwordKey = new NativeUint8Array(32).fill(21)
    derivePasswordKeyMock.mockResolvedValue(passwordKey)
    const authKeyBuffer = new ArrayBuffer(32)
    new NativeUint8Array(authKeyBuffer).fill(0x63)
    const deriveKeySpy = vi.spyOn(crypto.subtle, 'deriveKey').mockResolvedValue({} as CryptoKey)
    const deriveBitsSpy = vi.spyOn(crypto.subtle, 'deriveBits').mockResolvedValue(authKeyBuffer)
    const restoreConstructor = failUint8ArrayViewFor(authKeyBuffer, 'auth-key view allocation failed')

    try {
      await expect(derivePasswordMaterials('synthetic password', vectors.keySlot.input.kdf)).rejects.toThrow('auth-key view allocation failed')
      expect(new NativeUint8Array(authKeyBuffer)).toEqual(new NativeUint8Array(32))
      expect(passwordKey).toEqual(new NativeUint8Array(32))
    } finally {
      restoreConstructor()
      deriveKeySpy.mockRestore()
      deriveBitsSpy.mockRestore()
      derivePasswordKeyMock.mockReset()
    }
  })
})

describe('strict byte and KDF parsing', () => {
  it('accepts canonical base64 and rejects noncanonical encodings', () => {
    const bytes = Uint8Array.from([0, 1, 2, 3, 4])
    expect(encodeBase64(decodeBase64Strict('AAECAwQ='))).toBe('AAECAwQ=')
    expect(() => decodeBase64Strict('AAECAwQ')).toThrow()
    expect(() => decodeBase64Strict('AAECAwR=')).toThrow()
    expect(bytes).toHaveLength(5)
  })

  it('rejects unsafe Argon2id parameters before worker creation', () => {
    expect(validateArgon2idParams(vectors.keySlot.input.kdf)).toMatchObject({ alg: 'argon2id', m: 65536, t: 3, p: 1 })
    expect(() => validateArgon2idParams({ ...vectors.keySlot.input.kdf, m: 1 })).toThrow(RangeError)
    expect(() => validateArgon2idParams({ ...vectors.keySlot.input.kdf, p: 1.5 })).toThrow(RangeError)
    expect(() => validateArgon2idParams({ ...vectors.keySlot.input.kdf, salt: 'not base64' })).toThrow(TypeError)
  })

  it('rejects malformed envelopes before AEAD processing', () => {
    expect(() => parseEncryptedObject(new Uint8Array(4))).toThrow()
    const object = fromHex(vectors.encryptedObject.envelopeHex)
    object[6] = 1
    expect(() => parseEncryptedObject(object)).toThrow(/reserved flags/)
  })
})
