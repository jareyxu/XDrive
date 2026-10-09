export const FORMAT_VERSION = 1
export const ENVELOPE_HEADER_BYTES = 20
export const GCM_TAG_BYTES = 16
export const ENVELOPE_OVERHEAD_BYTES = ENVELOPE_HEADER_BYTES + GCM_TAG_BYTES
export const FILE_CHUNK_BYTES = 8 * 1024 * 1024
export const MAX_CLIENT_FILE_CHUNK_BYTES = 16 * 1024 * 1024 - ENVELOPE_OVERHEAD_BYTES

export const ARGON2ID_LIMITS = Object.freeze({
  memoryKiB: { min: 32_768, max: 131_072, default: 65_536 },
  iterations: { min: 2, max: 6, default: 3 },
  parallelism: { min: 1, max: 4, default: 1 },
  saltBytes: { min: 16, max: 64 },
})

export interface Argon2idParams {
  readonly alg: 'argon2id'
  readonly salt: string
  readonly m: number
  readonly t: number
  readonly p: number
}
