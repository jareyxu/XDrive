import { afterEach, expect, test, vi } from 'vitest'
import { readThumbnail, type DriveEntry } from './client'
import { thumbnailAAD } from '../crypto/aad'
import { encryptObject } from '../crypto/envelope'
import { deriveDataKey, deriveThumbnailKey, importVaultKey } from '../crypto/keys'
const digest = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer))].map(byte => byte.toString(16).padStart(2, '0')).join('')
afterEach(() => vi.unstubAllGlobals())
async function fixture(version: 1 | 2 = 1, mime: 'image/webp' | 'image/jpeg' = 'image/webp') {
 const fileId = 'private-file-0000001', vaultKey = await importVaultKey(new Uint8Array(32).fill(7))
 const dataKey = await deriveDataKey(vaultKey)
 const webp = mime === 'image/jpeg' ? Uint8Array.from([255,216,255,192,0,8,8,0,64,0,128,1]) : new Uint8Array(30)
 if (mime === 'image/webp') { webp.set([82,73,70,70],0); webp.set([87,69,66,80,86,80,56,88],8); webp[24] = 127; webp[27] = 63 }
 const ciphertext = await encryptObject(await deriveThumbnailKey(vaultKey, dataKey, fileId, version), webp, thumbnailAAD(fileId, version))
 const entry: DriveEntry = { entryId: fileId, kind: 'file', name: 'private.png', fileId, ...(version === 2 ? { fileCryptoVersion: 2 as const } : {}), thumbnail: { objectId: 'thumb-object-0000001', sizeBytes: ciphertext.length, sha256: await digest(ciphertext), mime, width: 128, height: 64, ...(version === 2 ? { keyVersion: 2 as const } : {}) } }
 const respond = (bytes: Uint8Array) => vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes.slice().buffer, { headers: { 'Content-Length': String(bytes.length) } })))
 respond(ciphertext); return { vault: { vaultKey, dataKey }, entry, ciphertext, webp, respond }
}
test('authenticated thumbnail copy survives transient buffer wiping, uses file identity and verifies declared dimensions', async () => {
 const { vault, entry, webp } = await fixture(), blob = await readThumbnail(vault, entry)
 expect(blob.type).toBe('image/webp'); expect(new Uint8Array(await blob.arrayBuffer())).toEqual(webp)
 await expect(readThumbnail(vault, { ...entry, fileId: 'other-file-00000001' })).rejects.toThrow()
 await expect(readThumbnail(vault, { ...entry, thumbnail: { ...entry.thumbnail!, width: 129 } })).rejects.toThrow('尺寸')
})
test('V2 thumbnail uses its data-key child and rejects a directory reference with the wrong key version', async () => {
 const { vault, entry, webp } = await fixture(2)
 const blob = await readThumbnail(vault, entry)
 expect(new Uint8Array(await blob.arrayBuffer())).toEqual(webp)
 await expect(readThumbnail(vault, { ...entry, thumbnail: { ...entry.thumbnail!, keyVersion: 1 } })).rejects.toThrow('密钥版本')
})
test('tampered ciphertext fails hash or AEAD even when its declared hash is recomputed', async () => {
 const { vault, entry, ciphertext, respond } = await fixture(); ciphertext[ciphertext.length - 1]! ^= 1; respond(ciphertext)
 await expect(readThumbnail(vault, entry)).rejects.toThrow('完整性')
 await expect(readThumbnail(vault, { ...entry, thumbnail: { ...entry.thumbnail!, sha256: await digest(ciphertext) } })).rejects.toThrow()
})
test('cancellation during ciphertext retrieval stops decryption and never creates a thumbnail Blob', async () => {
 const { vault, entry, ciphertext } = await fixture(), controller = new AbortController()
 vi.stubGlobal('fetch', vi.fn(async () => { controller.abort(); return new Response(ciphertext.slice().buffer, { headers: { 'Content-Length': String(ciphertext.length) } }) }))
 await expect(readThumbnail(vault, entry, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
})
test.each([1, 2] as const)('authenticated JPEG uses the existing V%s thumbnail domain and retains exact plaintext', async version => {
 const { vault, entry, webp: plaintext } = await fixture(version, 'image/jpeg')
 const blob = await readThumbnail(vault, entry)
 expect(blob.type).toBe('image/jpeg'); expect(new Uint8Array(await blob.arrayBuffer())).toEqual(plaintext)
 await expect(readThumbnail(vault, { ...entry, fileId: 'other-file-00000001' })).rejects.toThrow()
})
test.each(['image/webp', 'image/jpeg'] as const)('rejects authenticated %s bytes with a mismatched declared MIME', async mime => {
 const { vault, entry } = await fixture(2, mime)
 await expect(readThumbnail(vault, { ...entry, thumbnail: { ...entry.thumbnail!, mime: mime === 'image/webp' ? 'image/jpeg' : 'image/webp' } })).rejects.toThrow('MIME')
})
