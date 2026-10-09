import { isThumbnailReference, THUMBNAIL_MAX_BYTES, type SavedThumbnail } from '../media/thumbnail-schema'
import { parseStrictJson } from '../crypto/strict-json'
import { localStateAAD } from '../crypto/aad'
import { decodeBase64Strict, encodeBase64, utf8Strict, zeroArrayBuffer } from '../crypto/encoding'
import { decryptObject, encryptObject } from '../crypto/envelope'
import { deriveVaultKey } from '../crypto/keys'
import { ENVELOPE_OVERHEAD_BYTES } from '../crypto/constants'

export interface UploadPiece {
  readonly objectId: string
  readonly sizeBytes: number
  readonly sha256: string
}

export interface UploadResumeRecord {
  readonly version: 1 | 2 | 3 | 4
  readonly fileCryptoVersion?: 1 | 2
  readonly thumbnail?: SavedThumbnail | null
  readonly id: string
  readonly uploadId: string
  readonly expiresAt: number
  readonly directoryId: string
  readonly name: string
  readonly mime: string
  readonly size: number
  readonly lastModified: number
  readonly fingerprint: string
  readonly fileId: string
  readonly entryId: string
  readonly chunks: readonly (UploadPiece | null)[]
  readonly manifest: UploadPiece | null
  readonly index: UploadPiece | null
  readonly indexRevision: number | null
  readonly idempotencyKey: string | null
  readonly targetName?: string
  readonly replaceEntryId?: string
  readonly replacementFingerprint?: string
  readonly tombstoneId?: string
  readonly trashIndex?: UploadPiece | null
  readonly directoryPath?: readonly { readonly indexId: string; readonly name: string }[]
}

const databaseName = 'xdrive-local-v1'
const storeName = 'encrypted-records'
const limitsRecordId = '!xdrive-upload-recovery-limits-v1'
const maxUploadResumeRecords = 4096
const maxUploadResumeRecordEncodedCharacters = 4 * 1024 * 1024
const maxUploadResumeTotalEncodedCharacters = 32 * 1024 * 1024
const opaqueId = /^[A-Za-z0-9_-]{16,64}$/u
const digest = /^[0-9a-f]{64}$/u

interface StoredUploadRecord {
  readonly id: string
  readonly encrypted: string
}

interface UploadResumeLimits {
  readonly id: typeof limitsRecordId
  readonly count: number
  readonly encodedCharacters: number
}

export async function fingerprintFile(file: File): Promise<string> {
  const sample = 64 * 1024
  const positions = [0, Math.max(0, Math.floor((file.size - sample) / 2)), Math.max(0, file.size - sample)]
  const header = new ArrayBuffer(16)
  const view = new DataView(header)
  view.setBigUint64(0, BigInt(file.size), false)
  view.setBigUint64(8, BigInt(file.lastModified), false)
  const sampledBuffers: ArrayBuffer[] = []
  const parts: Uint8Array[] = []
  let bytes: Uint8Array | undefined
  let digestBuffer: ArrayBuffer | undefined
  let digest: Uint8Array | undefined
  try {
    // allSettled keeps successful sample buffers reachable until every read has
    // finished, so one failed file slice cannot strand later successful reads.
    const results = await Promise.allSettled(positions.map(async (offset) => {
      const buffer = await file.slice(offset, offset + sample).arrayBuffer()
      sampledBuffers.push(buffer)
      const part = new Uint8Array(buffer)
      parts.push(part)
      return part
    }))
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure) throw failure.reason
    const resolvedParts = results.map((result) => (result as PromiseFulfilledResult<Uint8Array>).value)
    bytes = new Uint8Array(16 + resolvedParts.reduce((sum, part) => sum + part.byteLength, 0))
    bytes.set(new Uint8Array(header))
    let cursor = 16
    for (const part of resolvedParts) { bytes.set(part, cursor); cursor += part.byteLength }
    digestBuffer = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer)
    digest = new Uint8Array(digestBuffer)
    return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  } finally {
    bytes?.fill(0)
    digest?.fill(0)
    if (!digest && digestBuffer) zeroArrayBuffer(digestBuffer)
    for (const part of parts) part.fill(0)
    for (const buffer of sampledBuffers) {
      if (!parts.some((part) => part.buffer === buffer)) zeroArrayBuffer(buffer)
    }
  }
}

export async function assertOriginalFile(file: File, record: UploadResumeRecord): Promise<void> {
  if (file.name.normalize('NFC') !== record.name || file.size !== record.size || file.lastModified !== record.lastModified || await fingerprintFile(file) !== record.fingerprint) {
    throw new TypeError('所选文件与原上传文件不一致，请重新选择原文件。')
  }
}

export async function saveUploadRecord(vaultKey: CryptoKey, record: UploadResumeRecord): Promise<void> {
  if (!isUploadResumeRecord(record)) throw new TypeError('invalid upload recovery record')
  const plaintext = utf8Strict(JSON.stringify(record))
  let aad: Uint8Array | undefined
  let encrypted: Uint8Array | undefined
  try {
    if (encodedLength(plaintext.byteLength + ENVELOPE_OVERHEAD_BYTES) > maxUploadResumeRecordEncodedCharacters) {
      throw new TypeError('单个本地恢复记录超过安全大小上限。')
    }
    const key = await deriveVaultKey(vaultKey, 'xdrive/v1/local')
    aad = localStateAAD('upload-resume', record.id)
    encrypted = await encryptObject(key, plaintext, aad)
    const stored = { id: record.id, encrypted: encodeBase64(encrypted) }
    if (stored.encrypted.length > maxUploadResumeRecordEncodedCharacters) throw new TypeError('单个本地恢复记录超过安全大小上限。')
    await putUploadRecordWithinLimits(stored)
  } finally { plaintext.fill(0); aad?.fill(0); encrypted?.fill(0) }
}

export async function listUploadRecords(vaultKey: CryptoKey, signal?: AbortSignal): Promise<UploadResumeRecord[]> {
  signal?.throwIfAborted()
  const rows = await readBoundedUploadRows(signal)
  signal?.throwIfAborted()
  const key = await deriveVaultKey(vaultKey, 'xdrive/v1/local')
  signal?.throwIfAborted()
  const records: UploadResumeRecord[] = []
  for (const row of rows) {
    signal?.throwIfAborted()
    const aad = localStateAAD('upload-resume', row.id)
    const encrypted = decodeBase64Strict(row.encrypted)
    let plaintext: Uint8Array | undefined
    try {
      plaintext = await decryptObject(key, encrypted, aad)
      signal?.throwIfAborted()
      const parsed: unknown = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(plaintext))
      if (!isUploadResumeRecord(parsed) || parsed.id !== row.id) throw new TypeError('invalid encrypted upload recovery record')
      records.push(parsed)
    } finally { aad.fill(0); encrypted.fill(0); plaintext?.fill(0) }
  }
  return records.sort((a, b) => a.expiresAt - b.expiresAt)
}

export async function deleteUploadRecord(id: string): Promise<void> {
  if (!opaqueId.test(id)) throw new TypeError('invalid upload recovery id')
  await deleteUploadRecordWithinLimits(id)
}

function readBoundedUploadRows(signal?: AbortSignal): Promise<StoredUploadRecord[]> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(databaseName, 1)
    let database: IDBDatabase | undefined
    let transaction: IDBTransaction | undefined
    let failure: unknown
    let settled = false
    let abortListener: (() => void) | undefined
    const rows: StoredUploadRecord[] = []
    let count = 0
    let encodedCharacters = 0
    let limits: UploadResumeLimits | undefined
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      if (abortListener) signal?.removeEventListener('abort', abortListener)
      database?.close()
      if (error !== undefined) reject(error)
      else resolve(rows)
    }
    const fail = (error: unknown) => {
      if (failure === undefined) failure = error
      try { transaction?.abort() } catch { finish(failure) }
    }
    open.onerror = () => finish(open.error ?? new Error('IndexedDB open failed'))
    open.onblocked = () => finish(new Error('IndexedDB open was blocked'))
    open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains(storeName)) open.result.createObjectStore(storeName, { keyPath: 'id' }) }
    open.onsuccess = () => {
      if (settled) { open.result.close(); return }
      database = open.result
      try {
        transaction = database.transaction(storeName, 'readonly')
        const request = transaction.objectStore(storeName).openCursor()
        abortListener = () => fail(signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'))
        signal?.addEventListener('abort', abortListener, { once: true })
        if (signal?.aborted) abortListener()
        request.onerror = () => fail(request.error ?? new Error('IndexedDB cursor failed'))
        request.onsuccess = () => {
          if (failure !== undefined || settled) return
          try {
            signal?.throwIfAborted()
            const cursor = request.result
            if (!cursor) {
              if (limits && (limits.count !== count || limits.encodedCharacters !== encodedCharacters)) {
                fail(new TypeError('本地恢复存储状态不一致。'))
              }
              return
            }
            const row: unknown = cursor.value
            if (!isObject(row) || typeof row.id !== 'string') throw new TypeError('本地恢复记录格式无效。')
            if (row.id === limitsRecordId) {
              if (limits !== undefined || !isUploadResumeLimits(row)) throw new TypeError('本地恢复存储状态无效。')
              limits = row
              cursor.continue()
              return
            }
            const stored = readStoredUploadRecord(row)
            count++
            if (count > maxUploadResumeRecords) throw new TypeError('本地恢复任务超过安全上限。')
            encodedCharacters += stored.encrypted.length
            if (encodedCharacters > maxUploadResumeTotalEncodedCharacters) throw new TypeError('本地恢复记录总量超过安全读取上限。')
            rows.push(stored)
            cursor.continue()
          } catch (error) { fail(error) }
        }
        transaction.oncomplete = () => finish()
        transaction.onabort = () => finish(failure ?? transaction?.error ?? new Error('IndexedDB transaction aborted'))
        transaction.onerror = () => { failure ??= transaction?.error ?? new Error('IndexedDB transaction failed') }
      } catch (error) { finish(error) }
    }
  })
}

function putUploadRecordWithinLimits(row: StoredUploadRecord): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(databaseName, 1)
    let database: IDBDatabase | undefined
    let transaction: IDBTransaction | undefined
    let failure: unknown
    let settled = false
    let finishedScan = false
    let metadataLoaded = false
    let existingLoaded = false
    let metadata: unknown
    let existing: unknown
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      database?.close()
      if (error !== undefined) reject(error)
      else resolve()
    }
    const fail = (error: unknown) => {
      if (failure === undefined) failure = error
      try { transaction?.abort() } catch { finish(failure) }
    }
    const commit = (count: number, total: number, oldCharacters: number, replacing: boolean) => {
      const nextCount = count + (replacing ? 0 : 1)
      const nextCharacters = total - oldCharacters + row.encrypted.length
      if (nextCount > maxUploadResumeRecords) { fail(new TypeError('本地恢复任务超过安全上限。')); return }
      if (nextCharacters > maxUploadResumeTotalEncodedCharacters) { fail(new TypeError('本地恢复记录总量超过安全写入上限。')); return }
      try {
        const store = transaction!.objectStore(storeName)
        store.put(row)
        store.put({ id: limitsRecordId, count: nextCount, encodedCharacters: nextCharacters } satisfies UploadResumeLimits)
      } catch (error) { fail(error) }
    }
    const scanLegacyRows = () => {
      if (finishedScan || failure !== undefined) return
      finishedScan = true
      let count = 0
      let total = 0
      const request = transaction!.objectStore(storeName).openCursor()
      request.onerror = () => fail(request.error ?? new Error('IndexedDB cursor failed'))
      request.onsuccess = () => {
        if (failure !== undefined || settled) return
        try {
          const cursor = request.result
          if (!cursor) {
            const previous = existing === undefined ? undefined : readStoredUploadRecord(existing)
            commit(count, total, previous?.encrypted.length ?? 0, previous !== undefined)
            return
          }
          const value: unknown = cursor.value
          if (!isObject(value) || typeof value.id !== 'string') throw new TypeError('本地恢复记录格式无效。')
          if (value.id !== limitsRecordId) {
            const stored = readStoredUploadRecord(value)
            count++
            total += stored.encrypted.length
            if (count > maxUploadResumeRecords) throw new TypeError('本地恢复任务超过安全上限。')
            if (total > maxUploadResumeTotalEncodedCharacters) throw new TypeError('本地恢复记录总量超过安全写入上限。')
          }
          cursor.continue()
        } catch (error) { fail(error) }
      }
    }
    const continueAfterReads = () => {
      if (!metadataLoaded || !existingLoaded || failure !== undefined || settled || finishedScan) return
      try {
        const old = existing === undefined ? undefined : readStoredUploadRecord(existing)
        if (metadata === undefined) { scanLegacyRows(); return }
        if (!isUploadResumeLimits(metadata)) throw new TypeError('本地恢复存储状态无效。')
        commit(metadata.count, metadata.encodedCharacters, old?.encrypted.length ?? 0, old !== undefined)
      } catch (error) { fail(error) }
    }
    open.onerror = () => finish(open.error ?? new Error('IndexedDB open failed'))
    open.onblocked = () => finish(new Error('IndexedDB open was blocked'))
    open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains(storeName)) open.result.createObjectStore(storeName, { keyPath: 'id' }) }
    open.onsuccess = () => {
      if (settled) { open.result.close(); return }
      database = open.result
      try {
        transaction = database.transaction(storeName, 'readwrite')
        const store = transaction.objectStore(storeName)
        const metadataRequest = store.get(limitsRecordId)
        const existingRequest = store.get(row.id)
        metadataRequest.onerror = () => fail(metadataRequest.error ?? new Error('IndexedDB limits read failed'))
        existingRequest.onerror = () => fail(existingRequest.error ?? new Error('IndexedDB row read failed'))
        metadataRequest.onsuccess = () => { metadata = metadataRequest.result; metadataLoaded = true; continueAfterReads() }
        existingRequest.onsuccess = () => { existing = existingRequest.result; existingLoaded = true; continueAfterReads() }
        transaction.oncomplete = () => finish()
        transaction.onabort = () => finish(failure ?? transaction?.error ?? new Error('IndexedDB transaction aborted'))
        transaction.onerror = () => { failure ??= transaction?.error ?? new Error('IndexedDB transaction failed') }
      } catch (error) { finish(error) }
    }
  })
}

function deleteUploadRecordWithinLimits(id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(databaseName, 1)
    let database: IDBDatabase | undefined
    let transaction: IDBTransaction | undefined
    let failure: unknown
    let settled = false
    let metadata: unknown
    let existing: unknown
    let metadataLoaded = false
    let existingLoaded = false
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      database?.close()
      if (error !== undefined) reject(error)
      else resolve()
    }
    const fail = (error: unknown) => {
      if (failure === undefined) failure = error
      try { transaction?.abort() } catch { finish(failure) }
    }
    const commit = () => {
      if (!metadataLoaded || !existingLoaded || failure !== undefined || settled) return
      try {
        const store = transaction!.objectStore(storeName)
        if (existing === undefined) return
        const row = readStoredUploadRecord(existing)
        if (metadata !== undefined) {
          if (!isUploadResumeLimits(metadata) || metadata.count < 1 || metadata.encodedCharacters < row.encrypted.length) throw new TypeError('本地恢复存储状态无效。')
          store.put({ id: limitsRecordId, count: metadata.count - 1, encodedCharacters: metadata.encodedCharacters - row.encrypted.length } satisfies UploadResumeLimits)
        }
        store.delete(id)
      } catch (error) { fail(error) }
    }
    open.onerror = () => finish(open.error ?? new Error('IndexedDB open failed'))
    open.onblocked = () => finish(new Error('IndexedDB open was blocked'))
    open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains(storeName)) open.result.createObjectStore(storeName, { keyPath: 'id' }) }
    open.onsuccess = () => {
      if (settled) { open.result.close(); return }
      database = open.result
      try {
        transaction = database.transaction(storeName, 'readwrite')
        const store = transaction.objectStore(storeName)
        const metadataRequest = store.get(limitsRecordId)
        const existingRequest = store.get(id)
        metadataRequest.onerror = () => fail(metadataRequest.error ?? new Error('IndexedDB limits read failed'))
        existingRequest.onerror = () => fail(existingRequest.error ?? new Error('IndexedDB row read failed'))
        metadataRequest.onsuccess = () => { metadata = metadataRequest.result; metadataLoaded = true; commit() }
        existingRequest.onsuccess = () => { existing = existingRequest.result; existingLoaded = true; commit() }
        transaction.oncomplete = () => finish()
        transaction.onabort = () => finish(failure ?? transaction?.error ?? new Error('IndexedDB transaction aborted'))
        transaction.onerror = () => { failure ??= transaction?.error ?? new Error('IndexedDB transaction failed') }
      } catch (error) { finish(error) }
    }
  })
}

function readStoredUploadRecord(value: unknown): StoredUploadRecord {
  if (!isObject(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'id') || !Object.hasOwn(value, 'encrypted') || typeof value.id !== 'string' || !opaqueId.test(value.id) || typeof value.encrypted !== 'string' || !isCanonicalBase64(value.encrypted)) {
    throw new TypeError('本地恢复记录格式无效。')
  }
  if (value.encrypted.length < encodedLength(ENVELOPE_OVERHEAD_BYTES)) throw new TypeError('本地恢复记录密文无效。')
  if (value.encrypted.length > maxUploadResumeRecordEncodedCharacters) throw new TypeError('单个本地恢复记录超过安全大小上限。')
  return { id: value.id, encrypted: value.encrypted }
}

function isUploadResumeLimits(value: unknown): value is UploadResumeLimits {
  return isObject(value) && Object.keys(value).length === 3 && Object.hasOwn(value, 'id') && Object.hasOwn(value, 'count') && Object.hasOwn(value, 'encodedCharacters') && value.id === limitsRecordId && Number.isSafeInteger(value.count) && Number(value.count) >= 0 &&
    Number.isSafeInteger(value.encodedCharacters) && Number(value.encodedCharacters) >= 0
}

function isCanonicalBase64(value: string): boolean {
  return value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
}

function encodedLength(byteLength: number): number { return Math.ceil(byteLength / 3) * 4 }

function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function validPiece(value: unknown): value is UploadPiece {
  if (!isObject(value)) return false
  return Object.keys(value).length === 3 && opaqueId.test(String(value.objectId)) && Number.isSafeInteger(value.sizeBytes) && Number(value.sizeBytes) >= 36 && digest.test(String(value.sha256))
}
export function isUploadResumeRecord(value: unknown): value is UploadResumeRecord {
  if (!isObject(value)) return false
  const keys = ['version', 'id', 'uploadId', 'expiresAt', 'directoryId', 'name', 'mime', 'size', 'lastModified', 'fingerprint', 'fileId', 'entryId', 'chunks', 'manifest', 'index', 'indexRevision', 'idempotencyKey']
  const optional = ['targetName', 'replaceEntryId', 'replacementFingerprint', 'tombstoneId', 'trashIndex', 'directoryPath', 'thumbnail', 'fileCryptoVersion']
  if (keys.some((key) => !(key in value)) || Object.keys(value).some((key) => !keys.includes(key) && !optional.includes(key))) return false
  if ((value.version !== 1 && value.version !== 2 && value.version !== 3 && value.version !== 4) || !opaqueId.test(String(value.id)) || !opaqueId.test(String(value.uploadId)) || !opaqueId.test(String(value.directoryId)) || !opaqueId.test(String(value.fileId)) || !opaqueId.test(String(value.entryId))) return false
  if (value.version === 4 ? value.fileCryptoVersion !== 1 && value.fileCryptoVersion !== 2 : Object.hasOwn(value, 'fileCryptoVersion')) return false
  if (!Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) <= 0 || !Number.isSafeInteger(value.size) || Number(value.size) < 0 || !Number.isSafeInteger(value.lastModified) || Number(value.lastModified) < 0) return false
  if (typeof value.name !== 'string' || !value.name || value.name !== value.name.normalize('NFC') || typeof value.mime !== 'string' || value.mime.length > 255 || !digest.test(String(value.fingerprint))) return false
  if (!Array.isArray(value.chunks) || value.chunks.length !== Math.ceil(Number(value.size) / (8 * 1024 * 1024)) || value.chunks.length > 4094 || !value.chunks.every((piece) => piece === null || validPiece(piece))) return false
  if (value.manifest !== null && !validPiece(value.manifest)) return false
  if (value.index !== null && !validPiece(value.index)) return false
  if (value.indexRevision !== null && (!Number.isSafeInteger(value.indexRevision) || Number(value.indexRevision) < 1)) return false
  if (value.idempotencyKey !== null && !opaqueId.test(String(value.idempotencyKey))) return false
  if (value.targetName !== undefined && (typeof value.targetName !== 'string' || !isValidName(value.targetName))) return false
  if (value.replaceEntryId !== undefined && !opaqueId.test(String(value.replaceEntryId))) return false
  if (value.replacementFingerprint !== undefined && (typeof value.replacementFingerprint !== 'string' || !digest.test(value.replacementFingerprint) || value.replaceEntryId === undefined)) return false
  if (value.version === 1 && value.replacementFingerprint !== undefined) return false
  if ((value.version === 2 || value.version === 3) && value.replaceEntryId !== undefined && value.replacementFingerprint === undefined) return false
  if (value.version !== 3 && value.version !== 4 && Object.hasOwn(value, 'thumbnail')) return false
  if (value.version === 3 || value.version === 4) {
    if (!Object.hasOwn(value, 'thumbnail')) return false
    if (value.thumbnail !== null) {
      if (!isObject(value.thumbnail) || Object.keys(value.thumbnail).length !== 2 || !isThumbnailReference(value.thumbnail.reference) || typeof value.thumbnail.ciphertext !== 'string' || value.thumbnail.ciphertext.length > Math.ceil((THUMBNAIL_MAX_BYTES + 36) / 3) * 4) return false
      if (value.version === 4 && (value.thumbnail.reference.keyVersion ?? 1) !== value.fileCryptoVersion) return false
      let encrypted: Uint8Array | undefined
      try { encrypted = decodeBase64Strict(value.thumbnail.ciphertext); if (encrypted.length !== value.thumbnail.reference.sizeBytes) return false } catch { return false } finally { encrypted?.fill(0) }
    }
  }
  if (value.tombstoneId !== undefined && !opaqueId.test(String(value.tombstoneId))) return false
  if (value.trashIndex !== undefined && value.trashIndex !== null && !validPiece(value.trashIndex)) return false
  if ((value.replaceEntryId === undefined) !== (value.tombstoneId === undefined)) return false
  if (value.replaceEntryId === undefined && value.trashIndex !== undefined && value.trashIndex !== null) return false
  if (value.directoryPath !== undefined && (!Array.isArray(value.directoryPath) || value.directoryPath.length > 256 || !value.directoryPath.every((part: unknown) => isObject(part) && Object.keys(part).length === 2 && opaqueId.test(String(part.indexId)) && typeof part.name === 'string' && isValidName(part.name)))) return false
  return true
}

function isValidName(name: string): boolean {
  return name.length > 0 && name === name.normalize('NFC') && name !== '.' && name !== '..' &&
    !name.includes('/') && !name.includes('\\') && !Array.from(name).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
    })
}
