import { ARGON2ID_LIMITS } from './constants'
import { decodeBase64Strict } from './encoding'
import type { Argon2idParams } from './constants'

export function validateArgon2idParams(value: unknown): Argon2idParams {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('invalid KDF parameters')
  }
  const candidate = value as Partial<Argon2idParams>
  if (candidate.alg !== 'argon2id' || typeof candidate.salt !== 'string') {
    throw new TypeError('unsupported KDF parameters')
  }
  const inRange = (number: unknown, minimum: number, maximum: number): number => {
    if (typeof number !== 'number' || !Number.isInteger(number) || number < minimum || number > maximum) {
      throw new RangeError('KDF parameters are outside the allowed range')
    }
    return number
  }
  const m = inRange(candidate.m, ARGON2ID_LIMITS.memoryKiB.min, ARGON2ID_LIMITS.memoryKiB.max)
  const t = inRange(candidate.t, ARGON2ID_LIMITS.iterations.min, ARGON2ID_LIMITS.iterations.max)
  const p = inRange(candidate.p, ARGON2ID_LIMITS.parallelism.min, ARGON2ID_LIMITS.parallelism.max)
  // Bound attacker-controlled input before Base64 validation/decoding allocates.
  // 64 bytes need at most 88 canonical Base64 characters. The decoded check
  // remains necessary: 65 and 66 bytes have the same encoded length.
  const maximumEncodedLength = 4 * Math.ceil(ARGON2ID_LIMITS.saltBytes.max / 3)
  if (candidate.salt.length > maximumEncodedLength) {
    throw new RangeError('KDF salt length is outside the allowed range')
  }
  const salt = decodeBase64Strict(candidate.salt)
  try {
    if (salt.byteLength < ARGON2ID_LIMITS.saltBytes.min || salt.byteLength > ARGON2ID_LIMITS.saltBytes.max) {
      throw new RangeError('KDF salt length is outside the allowed range')
    }
    return Object.freeze({ alg: 'argon2id', salt: candidate.salt, m, t, p })
  } finally {
    salt.fill(0)
  }
}

export function assertPasswordLength(password: string): void {
  if ([...password].length < 12) throw new RangeError('password must contain at least 12 characters')
}
