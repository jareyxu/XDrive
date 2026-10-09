// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from 'vitest'
import { deleteUploadRecord, fingerprintFile, isUploadResumeRecord, listUploadRecords, saveUploadRecord } from './resume'

const mocks = vi.hoisted(() => ({ deriveVaultKey: vi.fn(), decryptObject: vi.fn(), encryptObject: vi.fn() }))
vi.mock('../crypto/keys', () => ({ deriveVaultKey: mocks.deriveVaultKey }))
vi.mock('../crypto/envelope', () => ({ decryptObject: mocks.decryptObject, encryptObject: mocks.encryptObject }))

const id = 'abcdefghijklmnop'
const limitsId = '!xdrive-upload-recovery-limits-v1'
const maxRows = 4096
const maxRecordCharacters = 4 * 1024 * 1024
const maxTotalCharacters = 32 * 1024 * 1024
const ciphertext = btoa(String.fromCharCode(...new Uint8Array(36)))
const base = { version: 2, id, uploadId: id, expiresAt: 123, directoryId: id, name: 'f.txt', mime: 'text/plain', size: 0, lastModified: 0, fingerprint: 'a'.repeat(64), fileId: id, entryId: id, chunks: [], manifest: null, index: null, indexRevision: null, idempotencyKey: null } as const

beforeEach(() => {
  mocks.deriveVaultKey.mockReset().mockResolvedValue({} as CryptoKey)
  mocks.decryptObject.mockReset().mockResolvedValue(new TextEncoder().encode(JSON.stringify(base)))
  mocks.encryptObject.mockReset().mockResolvedValue(new Uint8Array(36))
})

test('v2 replacement requires its fixed digest; a nonreplacement cannot carry one', () => {
  const replacement = { ...base, replaceEntryId: id, tombstoneId: id, replacementFingerprint: 'b'.repeat(64) }
  expect(isUploadResumeRecord(replacement)).toBe(true)
  const { replacementFingerprint: _, ...missing } = replacement
  expect(isUploadResumeRecord(missing)).toBe(false)
  for (const digest of ['', 'b'.repeat(63), 'Z'.repeat(64), [], null, 1]) expect(isUploadResumeRecord({ ...replacement, replacementFingerprint: digest })).toBe(false)
  expect(isUploadResumeRecord({ ...base, replacementFingerprint: replacement.replacementFingerprint })).toBe(false)
  expect(isUploadResumeRecord(base)).toBe(true)
})

test('legacy v1 reads without inventing identity; unknown or string versions and fields refuse', () => {
  expect(isUploadResumeRecord({ ...base, version: 1 })).toBe(true)
  expect(isUploadResumeRecord({ ...base, version: 1, replaceEntryId: id, tombstoneId: id })).toBe(true)
  expect(isUploadResumeRecord({ ...base, version: 1, replaceEntryId: id, tombstoneId: id, replacementFingerprint: 'b'.repeat(64) })).toBe(false)
  for (const version of ['1', '2', 0, 3, null]) expect(isUploadResumeRecord({ ...base, version })).toBe(false)
  expect(isUploadResumeRecord({ ...base, surprise: true })).toBe(false)
})

test('v3 and v4 require explicit bounded ciphertext state; v4 binds a file crypto version', () => {
 const reference = { objectId: id, sha256: 'a'.repeat(64), sizeBytes: 40, mime: 'image/webp', width: 1, height: 1 }
 const thumbnail = { reference, ciphertext: btoa(String.fromCharCode(...new Uint8Array(40))) }
 expect(isUploadResumeRecord({ ...base, version: 3, thumbnail: null })).toBe(true)
 expect(isUploadResumeRecord({ ...base, version: 3, thumbnail })).toBe(true)
 expect(isUploadResumeRecord({ ...base, thumbnail })).toBe(false)
 const v4 = { ...base, version: 4, fileCryptoVersion: 2, thumbnail: { ...thumbnail, reference: { ...reference, keyVersion: 2 } } }
 expect(isUploadResumeRecord(v4)).toBe(true)
 expect(isUploadResumeRecord({ ...v4, fileCryptoVersion: 3 })).toBe(false)
 expect(isUploadResumeRecord({ ...v4, fileCryptoVersion: undefined })).toBe(false)
 expect(isUploadResumeRecord({ ...v4, version: 4, fileCryptoVersion: 1, thumbnail: { ...thumbnail, reference } })).toBe(true)
 expect(isUploadResumeRecord({ ...v4, thumbnail: { ...thumbnail, reference: { ...reference, keyVersion: 1 } } })).toBe(false)
 expect(isUploadResumeRecord({ ...v4, version: 3, fileCryptoVersion: undefined })).toBe(false)
 for (const change of [{ ciphertext: 'x' }, { ciphertext: btoa('short') }, { reference: { ...reference, width: 300 } }, { reference: { ...reference, unexpected: true } }, { extra: true }]) expect(isUploadResumeRecord({ ...base, version: 3, thumbnail: { ...thumbnail, ...change } })).toBe(false)
})

test('fingerprint sample reads all settle and every successful plaintext sample is cleared on read failure', async () => {
  const samples: ArrayBuffer[] = []
  let readIndex = 0
  const file = {
    size: 200_000,
    lastModified: 1,
    slice: vi.fn(() => {
      readIndex += 1
      if (readIndex === 2) return { arrayBuffer: async () => { throw new Error('sample read failed') } }
      const sample = new ArrayBuffer(32)
      new Uint8Array(sample).fill(readIndex)
      samples.push(sample)
      return { arrayBuffer: async () => sample }
    }),
  } as unknown as File

  await expect(fingerprintFile(file)).rejects.toThrow('sample read failed')
  expect(samples).toHaveLength(2)
  for (const sample of samples) expect(new Uint8Array(sample)).toEqual(new Uint8Array(sample.byteLength))
})

test('fingerprint clears sampled content and raw digest output if its result view cannot be created', async () => {
  const samples: ArrayBuffer[] = []
  const file = {
    size: 200_000,
    lastModified: 1,
    slice: vi.fn(() => {
      const sample = new ArrayBuffer(32)
      new Uint8Array(sample).fill(0x6d)
      samples.push(sample)
      return { arrayBuffer: async () => sample }
    }),
  } as unknown as File
  const digestBuffer = new ArrayBuffer(32)
  new Uint8Array(digestBuffer).fill(0x7e)
  const NativeUint8Array = globalThis.Uint8Array
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Uint8Array')!
  const replacement = new Proxy(NativeUint8Array, {
    construct(target, args, newTarget) {
      if (args[0] === digestBuffer) throw new Error('fingerprint digest view allocation failed')
      return Reflect.construct(target, args, newTarget)
    },
  })
  let digestInput: Uint8Array | undefined
  const digestSpy = vi.spyOn(crypto.subtle, 'digest').mockImplementation((_algorithm, data) => {
    digestInput = data instanceof ArrayBuffer
      ? new NativeUint8Array(data)
      : new NativeUint8Array(data.buffer, data.byteOffset, data.byteLength)
    return Promise.resolve(digestBuffer)
  })
  Object.defineProperty(globalThis, 'Uint8Array', { configurable: true, enumerable: descriptor.enumerable, writable: true, value: replacement })

  try {
    await expect(fingerprintFile(file)).rejects.toThrow('fingerprint digest view allocation failed')
    expect(digestInput).toEqual(new NativeUint8Array(digestInput!.byteLength))
    expect(new NativeUint8Array(digestBuffer)).toEqual(new NativeUint8Array(digestBuffer.byteLength))
    for (const sample of samples) expect(new NativeUint8Array(sample)).toEqual(new NativeUint8Array(sample.byteLength))
  } finally {
    Object.defineProperty(globalThis, 'Uint8Array', descriptor)
    digestSpy.mockRestore()
  }
})

test('recovery cursor stops at the record-count limit before deriving a key', async () => {
  const database = installDatabase(Array.from({ length: maxRows + 1 }, (_, index) => ({ id: `resume-fixture-${String(index).padStart(6, '0')}`, encrypted: ciphertext })))
  try {
    await expect(listUploadRecords({} as CryptoKey)).rejects.toThrow('本地恢复任务超过安全上限。')
    expect(database.cursorRowsVisited()).toBe(maxRows + 1)
    expect(mocks.deriveVaultKey).not.toHaveBeenCalled()
  } finally { vi.unstubAllGlobals() }
})

test('single-row and aggregate encoded-byte limits are checked while scanning, before key derivation', async () => {
  const oversizedRow = { id, encrypted: 'A'.repeat(maxRecordCharacters + 4) }
  installDatabase([oversizedRow])
  try {
    await expect(listUploadRecords({} as CryptoKey)).rejects.toThrow('单个本地恢复记录超过安全大小上限。')
    expect(mocks.deriveVaultKey).not.toHaveBeenCalled()
  } finally { vi.unstubAllGlobals() }

  const shared = 'A'.repeat(1024 * 1024)
  installDatabase(Array.from({ length: 33 }, (_, index) => ({ id: `resume-fixture-${String(index).padStart(6, '0')}`, encrypted: shared })))
  try {
    await expect(listUploadRecords({} as CryptoKey)).rejects.toThrow('本地恢复记录总量超过安全读取上限。')
    expect(mocks.deriveVaultKey).not.toHaveBeenCalled()
  } finally { vi.unstubAllGlobals() }
})

test('malformed storage rows fail before key derivation and corrupted authenticated payloads fail closed', async () => {
  installDatabase([{ id, encrypted: 'not-base64' }])
  try {
    await expect(listUploadRecords({} as CryptoKey)).rejects.toThrow('本地恢复记录格式无效。')
    expect(mocks.deriveVaultKey).not.toHaveBeenCalled()
  } finally { vi.unstubAllGlobals() }

  installDatabase([{ id, encrypted: ciphertext }])
  mocks.decryptObject.mockRejectedValueOnce(new TypeError('authentication tag mismatch'))
  try {
    await expect(listUploadRecords({} as CryptoKey)).rejects.toThrow('authentication tag mismatch')
    expect(mocks.deriveVaultKey).toHaveBeenCalledOnce()
    expect(mocks.decryptObject).toHaveBeenCalledOnce()
  } finally { vi.unstubAllGlobals() }
})

test('decrypted non-JSON or schema-invalid recovery data is rejected and buffers are cleared', async () => {
  const plaintext = new TextEncoder().encode('{')
  mocks.decryptObject.mockResolvedValueOnce(plaintext)
  installDatabase([{ id, encrypted: ciphertext }])
  try {
    await expect(listUploadRecords({} as CryptoKey)).rejects.toThrow()
    expect(plaintext.every((byte) => byte === 0)).toBe(true)
  } finally { vi.unstubAllGlobals() }

  mocks.decryptObject.mockResolvedValueOnce(new TextEncoder().encode('{}'))
  installDatabase([{ id, encrypted: ciphertext }])
  try {
    await expect(listUploadRecords({} as CryptoKey)).rejects.toThrow('invalid encrypted upload recovery record')
  } finally { vi.unstubAllGlobals() }
})

test('bounded listing accepts valid encrypted rows and verifies the persisted count/byte ledger', async () => {
  const row = { id, encrypted: ciphertext }
  installDatabase([row, { id: limitsId, count: 1, encodedCharacters: ciphertext.length }])
  try {
    await expect(listUploadRecords({} as CryptoKey)).resolves.toEqual([base])
    expect(mocks.decryptObject).toHaveBeenCalledOnce()
  } finally { vi.unstubAllGlobals() }

  mocks.deriveVaultKey.mockClear()
  installDatabase([row, { id: limitsId, count: 2, encodedCharacters: ciphertext.length }])
  try {
    await expect(listUploadRecords({} as CryptoKey)).rejects.toThrow('本地恢复存储状态不一致。')
    expect(mocks.deriveVaultKey).not.toHaveBeenCalled()
  } finally { vi.unstubAllGlobals() }
})

test('save refuses a single oversized plaintext before encryption', async () => {
  const oversized = { ...base, name: 'x'.repeat(maxRecordCharacters) }
  await expect(saveUploadRecord({} as CryptoKey, oversized)).rejects.toThrow('单个本地恢复记录超过安全大小上限。')
  expect(mocks.deriveVaultKey).not.toHaveBeenCalled()
  expect(mocks.encryptObject).not.toHaveBeenCalled()
})

test('save tracks aggregate row count and encoded bytes atomically, including replacements', async () => {
  const database = installDatabase([{ id, encrypted: ciphertext }])
  try {
    await saveUploadRecord({} as CryptoKey, base)
    expect(database.rows()).toContainEqual({ id: limitsId, count: 1, encodedCharacters: ciphertext.length })
    expect(database.rows()).toContainEqual({ id, encrypted: ciphertext })

    const second = { ...base, id: 'qrstuvwxyzABCDEF', uploadId: 'qrstuvwxyzABCDEF', fileId: 'qrstuvwxyzABCDEF', entryId: 'qrstuvwxyzABCDEF' }
    await saveUploadRecord({} as CryptoKey, second)
    expect(database.rows()).toContainEqual({ id: limitsId, count: 2, encodedCharacters: ciphertext.length * 2 })
    await deleteUploadRecord(second.id)
    expect(database.rows()).toContainEqual({ id: limitsId, count: 1, encodedCharacters: ciphertext.length })
    expect(database.rows().some((row) => typeof row === 'object' && row !== null && 'id' in row && (row as { id: string }).id === second.id)).toBe(false)
  } finally { vi.unstubAllGlobals() }

  const countFull = installDatabase([{ id: limitsId, count: maxRows, encodedCharacters: 0 }])
  await expect(saveUploadRecord({} as CryptoKey, base)).rejects.toThrow('本地恢复任务超过安全上限。')
  expect(countFull.rows().some((row) => typeof row === 'object' && row !== null && 'id' in row && (row as { id: string }).id === id)).toBe(false)
  vi.unstubAllGlobals()

  const bytesFull = installDatabase([{ id: limitsId, count: 1, encodedCharacters: maxTotalCharacters }])
  await expect(saveUploadRecord({} as CryptoKey, base)).rejects.toThrow('本地恢复记录总量超过安全写入上限。')
  expect(bytesFull.rows().some((row) => typeof row === 'object' && row !== null && 'id' in row && (row as { id: string }).id === id)).toBe(false)
  vi.unstubAllGlobals()
})

interface FakeDatabase {
  cursorRowsVisited(): number
  rows(): unknown[]
}

function installDatabase(initialRows: unknown[]): FakeDatabase {
  const rows = new Map<string, unknown>()
  for (const row of initialRows) if (typeof row === 'object' && row !== null && 'id' in row) rows.set(String((row as { id: unknown }).id), row)
  let visited = 0
  const database = {
    objectStoreNames: { contains: () => true },
    transaction: (_storeName: string, mode: IDBTransactionMode) => {
      let pending = 0
      let completeQueued = false
      let aborted = false
      const transaction = {
        mode,
        error: null as DOMException | null,
        oncomplete: null as ((event: Event) => void) | null,
        onabort: null as ((event: Event) => void) | null,
        onerror: null as ((event: Event) => void) | null,
        abort: () => {
          if (aborted) return
          aborted = true
          queueMicrotask(() => transaction.onabort?.call(transaction as unknown as IDBTransaction, new Event('abort')))
        },
        objectStore: () => store,
      }
      const maybeComplete = () => {
        if (pending !== 0 || completeQueued || aborted) return
        completeQueued = true
        queueMicrotask(() => transaction.oncomplete?.call(transaction as unknown as IDBTransaction, new Event('complete')))
      }
      const store = {
        openCursor: () => {
          const request = { result: null as IDBCursorWithValue | null, error: null, onsuccess: null as ((event: Event) => void) | null, onerror: null as ((event: Event) => void) | null }
          const snapshot = [...rows.values()]
          let index = 0
          pending++
          const step = () => queueMicrotask(() => {
            if (aborted) { pending--; maybeComplete(); return }
            const value = snapshot[index]
            if (value === undefined) {
              request.result = null
              request.onsuccess?.call(request as unknown as IDBRequest, new Event('success'))
              pending--
              maybeComplete()
              return
            }
            visited++
            const cursor = {
              value,
              continue: () => { index++; step() },
            }
            request.result = cursor as unknown as IDBCursorWithValue
            request.onsuccess?.call(request as unknown as IDBRequest, new Event('success'))
          })
          step()
          return request as unknown as IDBRequest<IDBCursorWithValue | null>
        },
        get: (key: IDBValidKey) => {
          const request = { result: undefined as unknown, error: null, onsuccess: null as ((event: Event) => void) | null, onerror: null as ((event: Event) => void) | null }
          pending++
          queueMicrotask(() => {
            request.result = rows.get(String(key))
            request.onsuccess?.call(request as unknown as IDBRequest, new Event('success'))
            pending--
            maybeComplete()
          })
          return request as unknown as IDBRequest
        },
        put: (value: unknown) => {
          if (mode !== 'readwrite') throw new DOMException('readonly transaction', 'ReadOnlyError')
          if (typeof value === 'object' && value !== null && 'id' in value) rows.set(String((value as { id: unknown }).id), value)
          return {} as IDBRequest
        },
        delete: (key: IDBValidKey) => { rows.delete(String(key)); return {} as IDBRequest },
      }
      return transaction as unknown as IDBTransaction
    },
    close: vi.fn(),
  } as unknown as IDBDatabase
  vi.stubGlobal('indexedDB', { open: vi.fn(() => {
    const request = { result: database, error: null, onsuccess: null as ((event: Event) => void) | null, onerror: null as ((event: Event) => void) | null, onblocked: null as ((event: Event) => void) | null, onupgradeneeded: null as ((event: Event) => void) | null }
    queueMicrotask(() => request.onsuccess?.call(request as unknown as IDBRequest, new Event('success')))
    return request as unknown as IDBOpenDBRequest
  }) })
  return { cursorRowsVisited: () => visited, rows: () => [...rows.values()] }
}
