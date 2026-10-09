import { takeArrayBufferBytes, zeroArrayBuffer } from './encoding'

/** Hashes bytes while clearing Web Crypto input/output buffers after completion. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = bytes.slice()
  let digest: Uint8Array | undefined
  let digestBuffer: ArrayBuffer | undefined
  try {
    digestBuffer = await crypto.subtle.digest('SHA-256', input.buffer as ArrayBuffer)
    digest = takeArrayBufferBytes(digestBuffer)
    return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  } finally {
    input.fill(0)
    digest?.fill(0)
    if (!digest && digestBuffer) zeroArrayBuffer(digestBuffer)
  }
}
