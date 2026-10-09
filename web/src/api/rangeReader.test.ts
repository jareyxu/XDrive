import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEncryptedRangeReader } from './client'
import type { DriveEntry, UnlockedVault } from './client'
import { chunkAAD, manifestAAD } from '../crypto/aad'
import { ENVELOPE_OVERHEAD_BYTES, FILE_CHUNK_BYTES } from '../crypto/constants'
import { encryptObject } from '../crypto/envelope'
import { deriveDataKey, deriveFileKey, deriveVaultKey, importVaultKey } from '../crypto/keys'

const digest = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer))].map((byte) => byte.toString(16).padStart(2, '0')).join('')

describe('PDF encrypted range reader', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads a cross-chunk range, verifies ciphertext, and clears its cache on destroy', async () => {
    const fileId = 'file-id'
    const entry: DriveEntry = { entryId: 'entry', kind: 'file', name: 'sample.pdf', mime: 'application/pdf', size: FILE_CHUNK_BYTES + 5, fileId, manifestObjectId: 'manifest-object-0001', manifestSha256: '' }
    const rawVaultKey = new Uint8Array(32).fill(7)
    const vaultKey = await importVaultKey(rawVaultKey)
    rawVaultKey.fill(0)
    const dataKey = await deriveDataKey(vaultKey)
    const fileKey = await deriveVaultKey(vaultKey, `xdrive/v1/file/${fileId}`)
    const plaintextChunks = [new Uint8Array(FILE_CHUNK_BYTES).fill(0x31), new Uint8Array(5).fill(0x42)]
    const records: { objectId: string; plaintextSize: number; sha256: string }[] = []
    const objects = new Map<string, Uint8Array>()
    for (let index = 0; index < plaintextChunks.length; index += 1) {
      const plaintext = plaintextChunks[index]!
      const objectId = `chunk-object-${index.toString().padStart(4, '0')}`
      const aad = chunkAAD({ fileId, chunkIndex: index, chunkCount: plaintextChunks.length, plaintextSize: plaintext.byteLength })
      const encrypted = await encryptObject(fileKey, plaintext, aad)
      aad.fill(0)
      records.push({ objectId, plaintextSize: plaintext.byteLength, sha256: await digest(encrypted) })
      objects.set(objectId, encrypted)
    }
    const manifest = new TextEncoder().encode(JSON.stringify({ version: 1, fileId, size: entry.size, mime: entry.mime, chunks: records }))
    const manifestObject = await encryptObject(fileKey, manifest, manifestAAD(fileId))
    manifest.fill(0)
    const fullEntry = { ...entry, manifestSha256: await digest(manifestObject) }
    objects.set(fullEntry.manifestObjectId!, manifestObject)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const objectId = decodeURIComponent(String(input).split('/').at(-1)!)
      const object = objects.get(objectId)
      if (!object) return new Response(null, { status: 404 })
      return new Response(object.slice().buffer, { headers: { 'Content-Length': String(object.byteLength) } })
    }))
    const vault = { vaultKey, dataKey } as UnlockedVault
    const reader = await createEncryptedRangeReader(vault, fullEntry)

    const begin = FILE_CHUNK_BYTES - 2
    const range = await reader.readRange(begin, begin + 7)
    expect([...range]).toEqual([0x31, 0x31, 0x42, 0x42, 0x42, 0x42, 0x42])
    range.fill(0)
    expect(ENVELOPE_OVERHEAD_BYTES).toBe(36)
    expect(fetch).toHaveBeenCalledTimes(3)
    await expect(reader.readRange(-1, 2)).rejects.toThrow(RangeError)
    await expect(reader.readRange(0, 16 * 1024 * 1024 + 1)).rejects.toThrow(/16 MiB/)

    reader.destroy()
    await expect(reader.readRange(0, 1)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('uses the manifest chunk size for V2 ranges through K_data and rejects a wrong file version', async () => {
    const fileId = 'file-version-two'
    const vaultKey = await importVaultKey(new Uint8Array(32).fill(8))
    const dataKey = await deriveDataKey(vaultKey)
    const fileKey = await deriveFileKey(vaultKey, dataKey, fileId, 2)
    const plaintextChunks = [new Uint8Array([7, 8]), new Uint8Array([9, 10])]
    const plaintext = new Uint8Array([7, 8, 9, 10])
    const chunkObjects = new Map<string, Uint8Array>()
    const manifestObjectId = 'manifest-v2-object-01'
    const chunks = await Promise.all(plaintextChunks.map(async (chunk, index) => {
      const objectId = `chunk-v2-object-000${index + 1}`
      const chunkEnvelope = await encryptObject(fileKey, chunk, chunkAAD({ fileId, chunkIndex: index, chunkCount: plaintextChunks.length, plaintextSize: chunk.length }, 2))
      chunkObjects.set(objectId, chunkEnvelope)
      return { objectId, plaintextSize: chunk.length, sha256: await digest(chunkEnvelope) }
    }))
    const manifest = new TextEncoder().encode(JSON.stringify({ version: 3, fileCryptoVersion: 2, fileId, size: plaintext.length, chunkSize: 2, chunkCount: chunks.length, mime: 'application/octet-stream', originalModifiedAt: 0, chunks: chunks.map((chunk, index) => ({ index, ...chunk })), thumbnail: null }))
    const manifestEnvelope = await encryptObject(fileKey, manifest, manifestAAD(fileId, 2))
    const objects = new Map([...chunkObjects, [manifestObjectId, manifestEnvelope] as const])
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const objectId = decodeURIComponent(String(input).split('/').at(-1)!)
      const object = objects.get(objectId)
      return object ? new Response(object.slice().buffer, { headers: { 'Content-Length': String(object.byteLength) } }) : new Response(null, { status: 404 })
    }))
    const entry: DriveEntry = { entryId: 'entry-v2', kind: 'file', name: 'v2.bin', size: plaintext.length, mime: 'application/octet-stream', fileId, fileCryptoVersion: 2, originalModifiedAt: 0, manifestObjectId, manifestSha256: await digest(manifestEnvelope) }
    const vault = { vaultKey, dataKey } as UnlockedVault
    const reader = await createEncryptedRangeReader(vault, entry)
    expect([...await reader.readRange(1, plaintext.length)]).toEqual([8, 9, 10])
    expect(fetch).toHaveBeenCalledTimes(3)
    reader.destroy()
    await expect(createEncryptedRangeReader(vault, { ...entry, fileCryptoVersion: 1 })).rejects.toThrow()
  })

})
