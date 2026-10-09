import { ENVELOPE_HEADER_BYTES, ENVELOPE_OVERHEAD_BYTES, GCM_TAG_BYTES } from './constants'
import { zeroArrayBuffer } from './encoding'

const MAGIC = new Uint8Array([0x58, 0x44, 0x52, 0x56])
const VERSION = 1
const AES_256_GCM = 1

export interface ParsedEncryptedObject {
  readonly nonce: Uint8Array
  readonly ciphertextAndTag: Uint8Array
}

export function parseEncryptedObject(data: Uint8Array): ParsedEncryptedObject {
  if (data.byteLength < ENVELOPE_OVERHEAD_BYTES) throw new TypeError('encrypted object is too short')
  if (!MAGIC.every((byte, i) => data[i] === byte)) throw new TypeError('invalid encrypted object magic')
  if (data[4] !== VERSION || data[5] !== AES_256_GCM) throw new TypeError('unsupported encrypted object format')
  if (data[6] !== 0 || data[7] !== 0) throw new TypeError('encrypted object reserved flags must be zero')
  const nonce = data.slice(8, ENVELOPE_HEADER_BYTES)
  const ciphertextAndTag = data.slice(ENVELOPE_HEADER_BYTES)
  if (ciphertextAndTag.byteLength < GCM_TAG_BYTES) throw new TypeError('encrypted object authentication tag is missing')
  return { nonce, ciphertextAndTag }
}

export async function encryptObject(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  let iv: Uint8Array | undefined
  let additionalData: Uint8Array | undefined
  let input: Uint8Array | undefined
  let encrypted: Uint8Array | undefined
  try {
    iv = nonce.slice()
    additionalData = aad.slice()
    input = plaintext.slice()
    encrypted = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer, additionalData: additionalData.buffer as ArrayBuffer, tagLength: 128 },
      key,
      input.buffer as ArrayBuffer,
    ))
    const object = new Uint8Array(ENVELOPE_HEADER_BYTES + encrypted.byteLength)
    object.set(MAGIC, 0)
    object[4] = VERSION
    object[5] = AES_256_GCM
    object.set(nonce, 8)
    object.set(encrypted, ENVELOPE_HEADER_BYTES)
    return object
  } finally {
    nonce.fill(0)
    iv?.fill(0)
    additionalData?.fill(0)
    input?.fill(0)
    encrypted?.fill(0)
  }
}

export async function decryptObject(
  key: CryptoKey,
  encryptedObject: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const { nonce, ciphertextAndTag } = parseEncryptedObject(encryptedObject)
  let iv: Uint8Array | undefined
  let additionalData: Uint8Array | undefined
  let ciphertextInput: Uint8Array | undefined
  let plaintextBuffer: ArrayBuffer | undefined
  let plaintext: Uint8Array | undefined
  let transferred = false
  try {
    iv = nonce.slice()
    additionalData = aad.slice()
    ciphertextInput = ciphertextAndTag.slice()
    plaintextBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer, additionalData: additionalData.buffer as ArrayBuffer, tagLength: 128 },
      key,
      ciphertextInput.buffer as ArrayBuffer,
    )
    plaintext = new Uint8Array(plaintextBuffer)
    transferred = true
    return plaintext
  } finally {
    iv?.fill(0)
    additionalData?.fill(0)
    ciphertextInput?.fill(0)
    nonce.fill(0)
    ciphertextAndTag.fill(0)
    if (!transferred) {
      if (plaintext) plaintext.fill(0)
      else if (plaintextBuffer) zeroArrayBuffer(plaintextBuffer)
    }
  }
}
