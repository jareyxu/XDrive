const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export function utf8Strict(value: string): Uint8Array {
  const bytes = encoder.encode(value)
  if (decoder.decode(bytes) !== value) {
    throw new TypeError('string is not well-formed UTF-16')
  }
  return bytes
}

export function lp(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength > 0xffff_ffff) throw new RangeError('LP field exceeds uint32')
  const result = new Uint8Array(4 + bytes.byteLength)
  new DataView(result.buffer).setUint32(0, bytes.byteLength, false)
  result.set(bytes, 4)
  return result
}

export function u32be(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError('value is outside uint32')
  }
  const result = new Uint8Array(4)
  new DataView(result.buffer).setUint32(0, value, false)
  return result
}

export function u64be(value: bigint | number): Uint8Array {
  const integer = typeof value === 'number' && Number.isSafeInteger(value)
    ? BigInt(value)
    : typeof value === 'bigint' ? value : -1n
  if (integer < 0n || integer > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError('value is outside uint64')
  }
  const result = new Uint8Array(8)
  new DataView(result.buffer).setBigUint64(0, integer, false)
  return result
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const size = parts.reduce((total, part) => total + part.byteLength, 0)
  const result = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

/** Best-effort clearing for sensitive Web Crypto output when a typed-array view could not be created. */
export function zeroArrayBuffer(buffer: ArrayBuffer): void {
  try {
    const view = new DataView(buffer)
    let offset = 0
    for (; offset + 4 <= buffer.byteLength; offset += 4) view.setUint32(offset, 0, false)
    for (; offset < buffer.byteLength; offset += 1) view.setUint8(offset, 0)
  } catch {
    // A detached or otherwise inaccessible buffer cannot be cleared here. Keep
    // cleanup failures from masking the original crypto/operation error.
  }
}

/** Take ownership of an ArrayBuffer as bytes, clearing it if view creation fails. */
export function takeArrayBufferBytes(buffer: ArrayBuffer): Uint8Array {
  try {
    return new Uint8Array(buffer)
  } catch (error) {
    zeroArrayBuffer(buffer)
    throw error
  }
}

export function decodeBase64Strict(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TypeError('invalid base64 encoding')
  }
  let binary: string
  try {
    binary = atob(value)
  } catch {
    throw new TypeError('invalid base64 encoding')
  }
  const result = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  if (encodeBase64(result) !== value) throw new TypeError('non-canonical base64 encoding')
  return result
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  const batchSize = 0x8000
  for (let i = 0; i < bytes.length; i += batchSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + batchSize))
  }
  return btoa(binary)
}
