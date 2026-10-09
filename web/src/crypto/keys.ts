import { keySlotAAD } from './aad'
import { ARGON2ID_LIMITS } from './constants'
import { decodeBase64Strict, encodeBase64, utf8Strict, zeroArrayBuffer } from './encoding'
import { validateArgon2idParams } from './kdf'
import type { Argon2idParams } from './constants'
import { derivePasswordKey } from './argon-worker-client'

export interface VaultKeySlot {
  readonly slotId: string
  readonly type: string
  readonly kdf: Argon2idParams
  readonly wrapped: { readonly nonce: string; readonly ciphertext: string }
}

export interface VaultConfigV1 {
  readonly formatVersion: 1 | 2
  readonly revision: number
  readonly slots: readonly VaultKeySlot[]
}

export async function createPasswordKDF(): Promise<Argon2idParams> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const params: Argon2idParams = {
    alg: 'argon2id',
    salt: encodeBase64(salt),
    m: ARGON2ID_LIMITS.memoryKiB.default,
    t: ARGON2ID_LIMITS.iterations.default,
    p: ARGON2ID_LIMITS.parallelism.default,
  }
  salt.fill(0)
  return params
}

export async function derivePasswordMaterials(password: string, untrustedKDF: unknown, signal?: AbortSignal): Promise<{ kek: CryptoKey; authKey: Uint8Array }> {
  const kdf = validateArgon2idParams(untrustedKDF)
  const salt = decodeBase64Strict(kdf.salt)
  let passwordKey: Uint8Array | undefined
  let importBytes: Uint8Array | undefined
  let authKeyBuffer: ArrayBuffer | undefined
  let authKeyTransferred = false
  try {
    passwordKey = await derivePasswordKey(password, kdf, signal)
    signal?.throwIfAborted()
    importBytes = passwordKey.slice()
    const hkdf = await crypto.subtle.importKey('raw', importBytes.buffer as ArrayBuffer, 'HKDF', false, ['deriveBits', 'deriveKey'])
    signal?.throwIfAborted()
    const parameters = (label: string): HkdfParams => ({
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: utf8Strict(label).buffer as ArrayBuffer,
    })
    // Both derivations are started together, but Promise.all rejects as soon
    // as either one fails. The other Web Crypto operation cannot be cancelled;
    // if deriveBits later succeeds, its raw authentication key would otherwise
    // be left without an owner that can clear it. Wait for both outcomes so the
    // raw result is always either returned to the caller or explicitly wiped.
    const [kekResult, authKeyResult] = await Promise.allSettled([
      crypto.subtle.deriveKey(parameters('xdrive/v1/kek'), hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
      crypto.subtle.deriveBits(parameters('xdrive/v1/auth'), hkdf, 256),
    ])
    if (authKeyResult.status === 'fulfilled') authKeyBuffer = authKeyResult.value
    if (kekResult.status === 'rejected') throw kekResult.reason
    if (authKeyResult.status === 'rejected') throw authKeyResult.reason
    const kek = kekResult.value
    const authKey = new Uint8Array(authKeyBuffer!)
    if (signal?.aborted) { authKey.fill(0); signal.throwIfAborted() }
    authKeyTransferred = true
    return { kek, authKey }
  } finally {
    if (authKeyBuffer && !authKeyTransferred) zeroArrayBuffer(authKeyBuffer)
    passwordKey?.fill(0)
    importBytes?.fill(0)
    salt.fill(0)
  }
}

export async function wrapVaultKey(kek: CryptoKey, vaultKey: Uint8Array, slotId: string, kdf: Argon2idParams, configRevision = 1, formatVersion: 1 | 2 = 1): Promise<VaultKeySlot> {
  const aad = keySlotAAD({ formatVersion, configRevision, slotId, type: 'password', kdf })
  let nonce: Uint8Array | undefined
  let iv: Uint8Array | undefined
  let additionalData: Uint8Array | undefined
  let input: Uint8Array | undefined
  let ciphertext: Uint8Array | undefined
  try {
    nonce = crypto.getRandomValues(new Uint8Array(12))
    iv = nonce.slice()
    additionalData = aad.slice()
    input = vaultKey.slice()
    ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer, additionalData: additionalData.buffer as ArrayBuffer, tagLength: 128 },
      kek,
      input.buffer as ArrayBuffer,
    ))
    return {
      slotId,
      type: 'password',
      kdf,
      wrapped: { nonce: encodeBase64(nonce), ciphertext: encodeBase64(ciphertext) },
    }
  } finally {
    nonce?.fill(0)
    iv?.fill(0)
    additionalData?.fill(0)
    input?.fill(0)
    ciphertext?.fill(0)
    aad.fill(0)
  }
}

export async function unwrapVaultKey(kek: CryptoKey, configuration: VaultConfigV1): Promise<CryptoKey> {
  const rawVaultKey = await unwrapVaultKeyBytes(kek, configuration)
  let importBytes: Uint8Array | undefined
  try {
    importBytes = rawVaultKey.slice()
    return await crypto.subtle.importKey('raw', importBytes.buffer as ArrayBuffer, 'HKDF', false, ['deriveBits', 'deriveKey'])
  } finally { importBytes?.fill(0); rawVaultKey.fill(0) }
}

export async function unwrapVaultKeyBytes(kek: CryptoKey, configuration: VaultConfigV1): Promise<Uint8Array> {
  if ((configuration.formatVersion !== 1 && configuration.formatVersion !== 2) || !Number.isSafeInteger(configuration.revision) || configuration.revision < 1 || configuration.slots.length !== 1) {
    throw new TypeError('unsupported vault configuration')
  }
  const slot = configuration.slots[0]
  if (!slot || slot.type !== 'password') throw new TypeError('password key slot is missing')
  const kdf = validateArgon2idParams(slot.kdf)
  const nonce = decodeBase64Strict(slot.wrapped.nonce)
  const ciphertext = decodeBase64Strict(slot.wrapped.ciphertext)
  const aad = keySlotAAD({ formatVersion: configuration.formatVersion, configRevision: configuration.revision, slotId: slot.slotId, type: slot.type, kdf })
  let iv: Uint8Array | undefined
  let additionalData: Uint8Array | undefined
  let ciphertextInput: Uint8Array | undefined
  let plaintextBuffer: ArrayBuffer | undefined
  let rawVaultKey: Uint8Array | undefined
  let transferred = false
  try {
    if (nonce.byteLength !== 12 || ciphertext.byteLength !== 48) throw new TypeError('invalid wrapped Vault Key')
    iv = nonce.slice()
    additionalData = aad.slice()
    ciphertextInput = ciphertext.slice()
    plaintextBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer, additionalData: additionalData.buffer as ArrayBuffer, tagLength: 128 },
      kek,
      ciphertextInput.buffer as ArrayBuffer,
    )
    rawVaultKey = new Uint8Array(plaintextBuffer)
    if (rawVaultKey.byteLength !== 32) {
      throw new TypeError('invalid Vault Key length')
    }
    transferred = true
    return rawVaultKey
  } finally {
    iv?.fill(0)
    additionalData?.fill(0)
    ciphertextInput?.fill(0)
    nonce.fill(0)
    ciphertext.fill(0)
    aad.fill(0)
    if (!transferred) {
      if (rawVaultKey) rawVaultKey.fill(0)
      else if (plaintextBuffer) zeroArrayBuffer(plaintextBuffer)
    }
  }
}

export async function importVaultKey(rawVaultKey: Uint8Array): Promise<CryptoKey> {
  if (rawVaultKey.byteLength !== 32) throw new TypeError('Vault Key must be 32 bytes')
  const importBytes = rawVaultKey.slice()
  try {
    return await crypto.subtle.importKey('raw', importBytes.buffer as ArrayBuffer, 'HKDF', false, ['deriveBits', 'deriveKey'])
  } finally { importBytes.fill(0) }
}

export async function deriveVaultKey(vaultKey: CryptoKey, label: string, usages: KeyUsage[] = ['encrypt', 'decrypt']): Promise<CryptoKey> {
  return crypto.subtle.deriveKey({
    name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8Strict(label).buffer as ArrayBuffer,
  }, vaultKey, { name: 'AES-GCM', length: 256 }, false, usages)
}

/** Derive the non-exportable V2 data-key root while retaining the V1 Vault Key. */
export async function deriveDataKey(vaultKey: CryptoKey): Promise<CryptoKey> {
  let derivedBuffer: ArrayBuffer | undefined
  let bytes: Uint8Array | undefined
  let importBytes: Uint8Array | undefined
  try {
    derivedBuffer = await crypto.subtle.deriveBits({
      name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8Strict('xdrive/v1/data').buffer as ArrayBuffer,
    }, vaultKey, 256)
    bytes = new Uint8Array(derivedBuffer)
    importBytes = bytes.slice()
    return await crypto.subtle.importKey('raw', importBytes.buffer as ArrayBuffer, 'HKDF', false, ['deriveBits', 'deriveKey'])
  } finally {
    if (bytes) bytes.fill(0)
    else if (derivedBuffer) zeroArrayBuffer(derivedBuffer)
    importBytes?.fill(0)
  }
}

export async function deriveFileKey(vaultKey: CryptoKey, dataKey: CryptoKey, fileId: string, version: 1 | 2): Promise<CryptoKey> {
  if (version === 1) return deriveVaultKey(vaultKey, `xdrive/v1/file/${fileId}`)
  if (version !== 2) throw new TypeError('unsupported file crypto version')
  return deriveDataChildKey(dataKey, fileId, 'xdrive/v1/file')
}

export async function deriveThumbnailKey(vaultKey: CryptoKey, dataKey: CryptoKey, fileId: string, version: 1 | 2): Promise<CryptoKey> {
  if (version === 1) return deriveVaultKey(vaultKey, `xdrive/v1/thumb/${fileId}`)
  if (version !== 2) throw new TypeError('unsupported thumbnail crypto version')
  return deriveDataChildKey(dataKey, fileId, 'xdrive/v1/thumb')
}

async function deriveDataChildKey(dataKey: CryptoKey, fileId: string, info: string): Promise<CryptoKey> {
  return crypto.subtle.deriveKey({
    name: 'HKDF', hash: 'SHA-256', salt: utf8Strict(fileId).buffer as ArrayBuffer, info: utf8Strict(info).buffer as ArrayBuffer,
  }, dataKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

export async function deriveIndexId(vaultKey: CryptoKey, branch: 'root' | 'trash'): Promise<string> {
  let derivedBuffer: ArrayBuffer | undefined
  let bytes: Uint8Array | undefined
  try {
    derivedBuffer = await crypto.subtle.deriveBits({
      name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8Strict(`xdrive/v1/id/${branch}`).buffer as ArrayBuffer,
    }, vaultKey, 256)
    bytes = new Uint8Array(derivedBuffer)
    return base32(bytes).slice(0, 26).toLowerCase()
  } finally {
    if (bytes) bytes.fill(0)
    else if (derivedBuffer) zeroArrayBuffer(derivedBuffer)
  }
}

function base32(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let buffer = 0
  let bits = 0
  let result = ''
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      result += alphabet[(buffer >>> bits) & 31]
    }
  }
  if (bits > 0) result += alphabet[(buffer << (5 - bits)) & 31]
  return result
}

interface HkdfParams extends Algorithm {
  readonly name: 'HKDF'
  readonly hash: string
  readonly salt: BufferSource
  readonly info: BufferSource
}
