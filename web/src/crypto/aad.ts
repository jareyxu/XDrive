import { concatBytes, decodeBase64Strict, lp, u32be, u64be, utf8Strict } from './encoding'
import type { Argon2idParams } from './constants'

export interface KeySlotAADInput {
  readonly formatVersion: number
  readonly configRevision: bigint | number
  readonly slotId: string
  readonly type: string
  readonly kdf: Argon2idParams
}

function assertObjectFormatVersion(version: number): asserts version is 1 | 2 {
  if (version !== 1 && version !== 2) throw new TypeError('unsupported object crypto version')
}

export function keySlotAAD(input: KeySlotAADInput): Uint8Array {
  return concatBytes(
    lp(utf8Strict('xdrive/v1/keyslot')),
    u32be(input.formatVersion),
    u64be(input.configRevision),
    lp(utf8Strict(input.slotId)),
    lp(utf8Strict(input.type)),
    lp(utf8Strict(input.kdf.alg)),
    u32be(input.kdf.m),
    u32be(input.kdf.t),
    u32be(input.kdf.p),
    lp(decodeBase64Strict(input.kdf.salt)),
  )
}

export function chunkAAD(input: {
  readonly fileId: string
  readonly chunkIndex: bigint | number
  readonly chunkCount: bigint | number
  readonly plaintextSize: bigint | number
}, formatVersion: 1 | 2 = 1): Uint8Array {
  assertObjectFormatVersion(formatVersion)
  return concatBytes(
    lp(utf8Strict('xdrive/v1/chunk')),
    u32be(formatVersion),
    lp(utf8Strict(input.fileId)),
    u64be(input.chunkIndex),
    u64be(input.chunkCount),
    u64be(input.plaintextSize),
  )
}

export function manifestAAD(fileId: string, formatVersion: 1 | 2 = 1): Uint8Array {
  assertObjectFormatVersion(formatVersion)
  return concatBytes(lp(utf8Strict('xdrive/v1/manifest')), u32be(formatVersion), lp(utf8Strict(fileId)))
}

export function thumbnailAAD(fileId: string, formatVersion: 1 | 2 = 1): Uint8Array {
  assertObjectFormatVersion(formatVersion)
  return concatBytes(lp(utf8Strict('xdrive/v1/thumbnail')), u32be(formatVersion), lp(utf8Strict(fileId)))
}

export function indexAAD(metadataId: string, revision: bigint | number): Uint8Array {
  return concatBytes(
    lp(utf8Strict('xdrive/v1/index')),
    u32be(1),
    lp(utf8Strict(metadataId)),
    u64be(revision),
  )
}

export function localStateAAD(recordType: string, recordId: string): Uint8Array {
  const allowedTypes = new Set(['upload-resume', 'revision-baseline'])
  if (!allowedTypes.has(recordType)) throw new TypeError('unsupported local-state record type')
  return concatBytes(
    lp(utf8Strict('xdrive/v1/local-state')),
    u32be(1),
    lp(utf8Strict(recordType)),
    lp(utf8Strict(recordId)),
  )
}
