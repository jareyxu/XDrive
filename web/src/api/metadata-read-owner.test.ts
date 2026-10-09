import { afterEach, expect, test, vi } from 'vitest'
import { clearRevisionContext, loadDirectory, type UnlockedVault } from './client'
import { encryptObject } from '../crypto/envelope'
import { indexAAD } from '../crypto/aad'
const id = 'child-metadata-0123456789', root = 'root-metadata-0123456789'
afterEach(() => { clearRevisionContext(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function fixture(malformed = false) {
  clearRevisionContext()
  const key = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(73), 'AES-GCM', false, ['encrypt', 'decrypt'])
  const json = malformed ? '{private-late-metadata' : JSON.stringify({ version: 1, indexId: id, entries: [{ entryId: 'private-entry-0123456789', kind: 'folder', name: 'private-late-metadata', childIndexId: 'grandchild-index-0123456789' }] })
  const envelope = await encryptObject(key, new TextEncoder().encode(json), indexAAD(id, 1))
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', envelope.slice().buffer as ArrayBuffer))].map(n => n.toString(16).padStart(2, '0')).join('')
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/metadata/')
    ? Response.json({ objectId: 'encrypted-object-0123456789', revision: 1, sizeBytes: envelope.length, sha256 })
    : new Response(envelope.slice().buffer as ArrayBuffer, { headers: { 'Content-Length': String(envelope.length) } })))
  return { vault: { rootIndexId: root, metadataKey: key } as UnlockedVault, json }
}
for (const stage of ['hash', 'aead'] as const) for (const end of ['abort', 'epoch'] as const) test(`late metadata ${stage} after ${end} is rejected before plaintext parse`, async () => {
  const { vault, json } = await fixture()
  let reached!: () => void, release!: () => void, plaintext: Uint8Array | null = null
  const started = new Promise<void>(resolve => { reached = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const digest = crypto.subtle.digest.bind(crypto.subtle), decrypt = crypto.subtle.decrypt.bind(crypto.subtle)
  let decryptCalls = 0
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
    const result = await digest(...args)
    if (stage === 'hash') { reached(); await gate }
    return result
  })
  vi.spyOn(crypto.subtle, 'decrypt').mockImplementation(async (...args) => {
    decryptCalls++
    const result = await decrypt(...args)
    if (stage === 'aead') { plaintext = new Uint8Array(result); reached(); await gate }
    return result
  })
  const parse = vi.spyOn(JSON, 'parse'), controller = new AbortController()
  const result = loadDirectory(vault, id, [], controller.signal).then(value => ({ value }), error => ({ error }))
  await started
  if (end === 'abort') controller.abort(); else clearRevisionContext()
  release()
  expect(await result).toMatchObject({ error: { name: 'AbortError' } })
  expect(parse.mock.calls.filter(([value]) => value === json)).toHaveLength(0)
  expect(decryptCalls).toBe(stage === 'hash' ? 0 : 1)
  if (stage === 'aead') expect(plaintext !== null && (plaintext as Uint8Array).length > 0 && (plaintext as Uint8Array).every(byte => byte === 0)).toBe(true)
  vi.restoreAllMocks()
  const fresh = await loadDirectory(vault, id)
  expect(fresh.entries[0]?.name).toBe('private-late-metadata')
})
for (const end of ['abort', 'epoch'] as const) test(`cancelled late malformed plaintext reports ${end} before JSON syntax errors`, async () => {
  const { vault, json } = await fixture(true)
  let reached!: () => void, release!: () => void, plaintext: Uint8Array | null = null
  const started = new Promise<void>(resolve => { reached = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const decrypt = crypto.subtle.decrypt.bind(crypto.subtle)
  vi.spyOn(crypto.subtle, 'decrypt').mockImplementation(async (...args) => {
    const result = await decrypt(...args); plaintext = new Uint8Array(result); reached(); await gate; return result
  })
  const parse = vi.spyOn(JSON, 'parse'), controller = new AbortController()
  const result = loadDirectory(vault, id, [], controller.signal).catch(error => error)
  await started
  if (end === 'abort') controller.abort(); else clearRevisionContext()
  release()
  expect(await result).toMatchObject({ name: 'AbortError' })
  expect(parse.mock.calls.filter(([value]) => value === json)).toHaveLength(0)
  expect(plaintext !== null && (plaintext as Uint8Array).length > 0 && (plaintext as Uint8Array).every(byte => byte === 0)).toBe(true)
})
