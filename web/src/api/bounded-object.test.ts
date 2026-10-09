import { afterEach, expect, test, vi } from 'vitest'
import { clearRevisionContext, createEncryptedRangeReader, loadDirectory } from './client'
import { encryptObject } from '../crypto/envelope'
import { indexAAD } from '../crypto/aad'
import type { DriveEntry, UnlockedVault } from './client'

const entry: DriveEntry = { kind: 'file', entryId: 'entry', name: 'sample', size: 1, fileId: 'file', manifestObjectId: 'manifest', manifestSha256: '0'.repeat(64) }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

test('an understated encrypted-body length stops and cancels reading before decryption', async () => {
  const cancelled = vi.fn()
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(37)) }, cancel: cancelled })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'Content-Length': '36' } })))
  await expect(createEncryptedRangeReader({} as UnlockedVault, entry)).rejects.toThrow('size does not match')
  expect(cancelled).toHaveBeenCalledTimes(1)
})

test('a short encrypted-body read is rejected before hashing or decryption', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(35), { headers: { 'Content-Length': '36' } })))
  await expect(createEncryptedRangeReader({} as UnlockedVault, entry)).rejects.toThrow('size does not match')
})

test.each([undefined, '-1', '36x', '1e3', '4194305'])('invalid or excessive object length %s is cancelled before consumption', async (length) => {
  const cancelled = vi.fn()
  const body = new ReadableStream<Uint8Array>({ cancel: cancelled })
  const headers = new Headers()
  if (length !== undefined) headers.set('Content-Length', length)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers })))
  await expect(createEncryptedRangeReader({} as UnlockedVault, entry)).rejects.toThrow('configured read limit')
  expect(cancelled).toHaveBeenCalledTimes(1)
})

test('cancelling a stalled body read cancels its stream and rejects with AbortError', async () => {
  const controller = new AbortController()
  const cancelled = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }), { headers: { 'Content-Length': '36' } })))
  const reading = createEncryptedRangeReader({} as UnlockedVault, entry, controller.signal)
  const rejected = expect(reading).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
  controller.abort()
  await rejected
  expect(cancelled).toHaveBeenCalledTimes(1)
})

test('an index body arriving after lock cannot start decryption in the expired context', async () => {
  const indexId = 'directory-index-0123456789'
  const key = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(0x71), 'AES-GCM', false, ['encrypt', 'decrypt'])
  const plaintext = new TextEncoder().encode(JSON.stringify({ version: 1, indexId, entries: [] }))
  const encrypted = await encryptObject(key, plaintext, indexAAD(indexId, 1))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encrypted.slice().buffer as ArrayBuffer))
  const sha256 = [...digest].map((value) => value.toString(16).padStart(2, '0')).join('')
  let deliver!: (response: Response) => void
  const pending = new Promise<Response>((resolve) => { deliver = resolve })
  const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ objectId: 'encrypted-index-object-012345', revision: 1, sizeBytes: encrypted.byteLength, sha256 }))).mockImplementationOnce(() => pending)
  vi.stubGlobal('fetch', fetchMock)
  const decrypt = vi.spyOn(crypto.subtle, 'decrypt')
  const reading = loadDirectory({ rootIndexId: 'other-root-index-0123456789', metadataKey: key } as UnlockedVault, indexId)
  const rejected = expect(reading).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  clearRevisionContext()
  deliver(new Response(encrypted.slice().buffer as ArrayBuffer, { headers: { 'Content-Length': String(encrypted.byteLength) } }))
  await rejected
  expect(decrypt).not.toHaveBeenCalled()
  plaintext.fill(0); encrypted.fill(0)
})
