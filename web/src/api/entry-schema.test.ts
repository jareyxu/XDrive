import { afterEach, expect, test, vi } from 'vitest'
import { clearRevisionContext, loadDirectory } from './client'
import type { UnlockedVault } from './client'
import { encryptObject } from '../crypto/envelope'
import { indexAAD } from '../crypto/aad'
const indexId = 'directory-index-0123456789'
const base = { entryId: 'folder-entry-0123456789', kind: 'folder', name: '资料', childIndexId: 'child-index-0123456789' }
afterEach(() => { clearRevisionContext(); vi.unstubAllGlobals() })
async function read(extra: Record<string, unknown>) {
 clearRevisionContext()
 const key = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(71), 'AES-GCM', false, ['encrypt', 'decrypt'])
 const entry = { ...base, ...extra }
 const bytes = await encryptObject(key, new TextEncoder().encode(JSON.stringify({ version: 1, indexId, entries: [entry] })), indexAAD(indexId, 1))
 const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer))].map(n => n.toString(16).padStart(2, '0')).join('')
 vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ objectId: 'encrypted-index-object-012345', revision: 1, sizeBytes: bytes.byteLength, sha256 }))).mockResolvedValueOnce(new Response(bytes.slice().buffer as ArrayBuffer, { headers: { 'Content-Length': String(bytes.byteLength) } })))
 return loadDirectory({ rootIndexId: 'other-root-index-0123456789', metadataKey: key } as UnlockedVault, indexId)
}
test('older entries without timestamps remain readable; optional safe timestamps survive actual AEAD parsing', async () => {
 expect((await read({})).entries[0]).toEqual(base)
 expect((await read({ originalModifiedAt: 0, createdAt: 8640000000000000 })).entries[0]).toMatchObject({ originalModifiedAt: 0, createdAt: 8640000000000000 })
})
test.each([{ originalModifiedAt: -1 }, { originalModifiedAt: 1.5 }, { originalModifiedAt: '1' }, { originalModifiedAt: null }, { createdAt: 8640000000000001 }, { additional: true }])('unsafe or unknown entry fields %j fail closed after authentication', async extra => {
 await expect(read(extra)).rejects.toThrow('invalid directory index')
})
