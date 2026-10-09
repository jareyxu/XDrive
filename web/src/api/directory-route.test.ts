import { afterEach, expect, test, vi } from 'vitest'
import { clearRevisionContext, resolveDirectoryRoute } from './client'
import type { DriveEntry } from './client'
import { encryptObject } from '../crypto/envelope'
import { indexAAD } from '../crypto/aad'
const root = 'root-directory-0123456789', parent = 'parent-directory-0123456789', child = 'child-directory-0123456789'
const edge = (name: string, id: string): DriveEntry => ({ entryId: `entry-${id}`, kind: 'folder', name, childIndexId: id })
afterEach(() => { clearRevisionContext(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
async function fixture(tree: Record<string, readonly DriveEntry[]>, revisions: number[] = [1, 1]) {
  clearRevisionContext()
  const key = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(77), 'AES-GCM', false, ['encrypt', 'decrypt'])
  const objects = new Map<string, Uint8Array>(), pointers = new Map<string, object>()
  for (const [id, entries] of Object.entries(tree)) {
    const objectId = `object-${id}`
    const body = await encryptObject(key, new TextEncoder().encode(JSON.stringify({ version: 1, indexId: id, entries })), indexAAD(id, 1))
    objects.set(objectId, body)
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', body.slice().buffer as ArrayBuffer))].map(n => n.toString(16).padStart(2, '0')).join('')
    pointers.set(id, { objectId, revision: 1, sizeBytes: body.byteLength, sha256 })
  }
  let reads = 0
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    requests.push(url)
    if (url.endsWith('/vault/state')) return Response.json({ vaultMutationRevision: revisions[Math.min(reads++, revisions.length - 1)] })
    const id = url.split('/').at(-1)!
    if (url.includes('/metadata/')) return pointers.has(id) ? Response.json(pointers.get(id)) : Response.json({ code: 'not_found', message: 'missing' }, { status: 404 })
    const bytes = objects.get(id)
    if (!bytes) throw new Error('unexpected object request')
    return new Response(bytes.slice().buffer as ArrayBuffer, { headers: { 'Content-Length': String(bytes.length) } })
  }))
  return { vault: { rootIndexId: root, metadataKey: key }, requests }
}
const tree = () => ({ [root]: [edge('私密父目录', parent)], [parent]: [edge('私密子目录', child)], [child]: [] })
test('bare opaque ID resolves current authenticated edges and full breadcrumbs', async () => {
  const { vault } = await fixture(tree())
  expect(await resolveDirectoryRoute(vault, child)).toMatchObject({ indexId: child, path: [{ indexId: root, name: '私密父目录' }, { indexId: parent, name: '私密子目录' }] })
})
test('history hints are revalidated and cannot choose names or resurrect an unreachable index', async () => {
  const { vault, requests } = await fixture({ [root]: [], [child]: [] })
  await expect(resolveDirectoryRoute(vault, child, [root])).rejects.toThrow('回收站')
  expect(requests.some(url => url.endsWith(`/metadata/${child}`))).toBe(false)
})
test('stale or forged ancestor IDs fall back to the active tree and current names', async () => {
  const { vault } = await fixture(tree())
  expect((await resolveDirectoryRoute(vault, child, [root, 'forged-directory-0123456789'])).path.map(item => item.name)).toEqual(['私密父目录', '私密子目录'])
})
test('revision changes discard the traversal and fetch a fresh root snapshot', async () => {
  const { vault, requests } = await fixture(tree(), [1, 2, 2, 2])
  vi.spyOn(Math, 'random').mockReturnValue(0)
  expect((await resolveDirectoryRoute(vault, child)).indexId).toBe(child)
  expect(requests.filter(url => url.endsWith(`/metadata/${root}`))).toHaveLength(2)
})
test('four unstable traversals terminate without an unlimited background retry', async () => {
  const { vault, requests } = await fixture(tree(), [1, 2, 3, 4, 5, 6, 7, 8])
  vi.spyOn(Math, 'random').mockReturnValue(0)
  await expect(resolveDirectoryRoute(vault, child)).rejects.toMatchObject({ code: 'concurrent_mutation_retry_exhausted' })
  expect(requests.filter(url => url.endsWith(`/metadata/${root}`))).toHaveLength(4)
})
test('a cyclic active tree fails closed instead of looping', async () => {
  const { vault } = await fixture({ [root]: [edge('loop', root)] })
  await expect(resolveDirectoryRoute(vault, child)).rejects.toThrow('循环')
})
test('invalid IDs and a cancelled owner issue no requests', async () => {
  const { vault } = await fixture(tree())
  await expect(resolveDirectoryRoute(vault, '../private')).rejects.toThrow('地址')
  const controller = new AbortController(); controller.abort()
  await expect(resolveDirectoryRoute(vault, child, [], controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(fetch).not.toHaveBeenCalled()
})
