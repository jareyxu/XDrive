import { expect, test, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixtureKEK } from './encrypted-directory-fixture'
import { startIsolatedServer } from './isolated-server'
import { deriveDataKey, deriveIndexId, deriveThumbnailKey, deriveVaultKey, unwrapVaultKey, type VaultConfigV1 } from '../src/crypto/keys'
import { indexAAD, thumbnailAAD } from '../src/crypto/aad'
import { decryptObject } from '../src/crypto/envelope'
import type { DriveEntry } from '../src/api/client'
const password = 'correct horse battery'
async function setup(page: Page, url: string, token: string) {
 await page.addInitScript(() => Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined }))
 await page.goto(`${url}/setup#${token}`); await page.getByLabel('设置密码').fill(password); await page.getByLabel('再次输入密码').fill(password)
 await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check(); await page.getByRole('button', { name: '创建加密云盘' }).click()
 await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 30000 })
}
async function image(page: Page): Promise<Buffer> {
 const encoded = await page.evaluate(async () => {
  const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180
  const context = canvas.getContext('2d')!; context.fillStyle = '#2678c8'; context.fillRect(0, 0, 320, 180); context.fillStyle = '#f2c547'; context.fillRect(50, 30, 120, 100)
  const blob = await new Promise<Blob>(resolve => canvas.toBlob(result => resolve(result!), 'image/png'))
  const bytes = new Uint8Array(await blob.arrayBuffer()); return btoa(String.fromCharCode(...bytes))
 }); return Buffer.from(encoded, 'base64')
}
async function chooseOriginal(page: Page, original: Buffer, resume = false) {
 await page.locator('input[type="file"]:not([webkitdirectory])').nth(resume ? 1 : 0).evaluate((element, encoded) => {
  const data = Uint8Array.from(atob(encoded), character => character.charCodeAt(0)), transfer = new DataTransfer()
  transfer.items.add(new File([data], 'resume-image.png', { type: 'image/png', lastModified: 1700000000000 }))
  const input = element as HTMLInputElement; input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }))
 }, original.toString('base64'))
}
async function root(page: Page, baseURL: string) {
 const cookie = (await page.context().cookies()).find(item => item.name === 'xdrive_session')!
 const get = (path: string) => page.request.get(`${baseURL}/api/v1${path}`, { headers: { Cookie: `xdrive_session=${cookie.value}` } })
 const config = await (await get('/vault/config')).json() as VaultConfigV1
 const vaultKey = await unwrapVaultKey(await fixtureKEK(password, config.slots[0]!.kdf), config)
 const id = await deriveIndexId(vaultKey, 'root'), key = await deriveVaultKey(vaultKey, 'xdrive/v1/meta')
 const pointer = await (await get(`/metadata/${id}`)).json() as { revision: number; objectId: string; sha256: string }
 const encrypted = new Uint8Array(await (await get(`/objects/${pointer.objectId}`)).body())
 expect(createHash('sha256').update(encrypted).digest('hex')).toBe(pointer.sha256)
 const plaintext = await decryptObject(key, encrypted, indexAAD(id, pointer.revision))
 try { return { entries: (JSON.parse(new TextDecoder().decode(plaintext)) as { entries: DriveEntry[] }).entries, vaultKey, get } } finally { plaintext.fill(0); encrypted.fill(0) }
}
async function download(page: Page, name: string) {
 await page.getByRole('button', { name: `更多操作 ${name}`, exact: true }).click()
 const pending = page.waitForEvent('download'); await page.getByRole('button', { name: `下载 ${name}`, exact: true }).click()
 const stream = await (await pending).createReadStream(); if (!stream) throw new Error('missing download')
 const chunks = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks)
}
function listFiles(path: string): string[] {
 return readdirSync(path).flatMap(name => {
  const child = join(path, name)
  return statSync(child).isDirectory() ? listFiles(child) : [child]
 })
}
test('real image creates an authenticated encrypted preferred/fallback thumbnail, preserves original bytes and purges thumbnail membership', async ({ page }) => {
 test.setTimeout(120000); const server = await startIsolatedServer()
 try {
  await page.addInitScript(() => {
   const blobs: Blob[] = []
   Object.defineProperty(window, '__persistedThumbnailAudit', { value: blobs })
   const create = URL.createObjectURL.bind(URL)
   URL.createObjectURL = blob => {
    if (!(blob instanceof File) && ['image/webp', 'image/jpeg'].includes(blob.type)) blobs.push(blob)
    return create(blob)
   }
  })
  await setup(page, server.baseURL, server.token); const original = await image(page)
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'private-photo.png', mimeType: 'image/png', buffer: original })
  const card = page.locator('.entry-card').filter({ has: page.getByRole('button', { name: 'private-photo.png', exact: true }) })
  await expect(card.locator('img')).toBeVisible({ timeout: 30000 }); await expect.poll(() => card.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(256)
  expect(await card.locator('img').evaluate((img: HTMLImageElement) => img.naturalHeight)).toBe(144)
  const state = await root(page, server.baseURL), entry = state.entries[0]!, ref = entry.thumbnail!
  const displayedThumbnail = Buffer.from(await page.evaluate(async () => {
   const blobs = (window as Window & { __persistedThumbnailAudit?: Blob[] }).__persistedThumbnailAudit ?? []
   const thumbnail = blobs.at(-1)
   if (!thumbnail) throw new Error('displayed thumbnail blob missing')
   return Array.from(new Uint8Array(await thumbnail.arrayBuffer()))
  }))
  const persistedFiles = [
   ...listFiles(join(server.dataRoot, 'objects')),
   ...['drive.db', 'drive.db-wal', 'drive.db-shm', 'server.secret'].map(name => join(server.dataRoot, name)).filter(path => {
    try { return statSync(path).isFile() } catch { return false }
   }),
  ]
  const privateMarkers = [Buffer.from('private-photo.png'), Buffer.from('image/png'), original, displayedThumbnail]
  const leakedPaths = persistedFiles.filter(path => {
   const bytes = readFileSync(path)
   return privateMarkers.some(marker => bytes.includes(marker))
  })
  expect(leakedPaths, 'object files, SQLite files, and server secret must not contain the original image, its displayed thumbnail, its name, or MIME').toEqual([])
  const expectedMime = await page.evaluate(async () => { const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1; const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp')); return blob?.type === 'image/webp' ? 'image/webp' : 'image/jpeg' }); expect(ref).toMatchObject({ mime: expectedMime, width: 256, height: 144 }); expect(ref.sizeBytes).toBeLessThanOrEqual(262180)
  const ciphertext = new Uint8Array(await (await state.get(`/objects/${ref.objectId}`)).body())
  expect(ciphertext.length).toBe(ref.sizeBytes); expect(createHash('sha256').update(ciphertext).digest('hex')).toBe(ref.sha256)
  expect(Buffer.from(ciphertext).includes(Buffer.from('private-photo.png'))).toBe(false)
  const thumbVersion = entry.thumbnail!.keyVersion ?? entry.fileCryptoVersion ?? 1
  const thumbKey = await deriveThumbnailKey(state.vaultKey, await deriveDataKey(state.vaultKey), entry.fileId!, thumbVersion)
  const webp = await decryptObject(thumbKey, ciphertext, thumbnailAAD(entry.fileId!, thumbVersion)); if (expectedMime === 'image/webp') { expect(Buffer.from(webp.slice(0, 4)).toString()).toBe('RIFF'); expect(Buffer.from(webp.slice(8, 12)).toString()).toBe('WEBP') } else { expect([...webp.slice(0, 3)]).toEqual([255, 216, 255]) }; webp.fill(0)
  await expect(decryptObject(thumbKey, ciphertext, thumbnailAAD('different-file-id-000000000'))).rejects.toThrow()
  expect(await download(page, 'private-photo.png')).toEqual(original)
  await page.reload(); await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '解锁云盘', exact: true }).click(); await expect(card.locator('img')).toBeVisible({ timeout: 30000 })
  await page.getByRole('button', { name: '更多操作 private-photo.png', exact: true }).click(); page.once('dialog', dialog => void dialog.accept()); await page.getByRole('button', { name: '移到回收站 private-photo.png', exact: true }).click()
  await page.getByRole('button', { name: '回收站', exact: true }).click(); await expect(page.getByRole('button', { name: 'private-photo.png', exact: true })).toBeVisible()
  page.once('dialog', dialog => void dialog.accept()); await page.getByRole('button', { name: '永久删除 private-photo.png', exact: true }).click()
  await expect.poll(async () => (await state.get(`/objects/${ref.objectId}`)).status()).toBe(404)
  await page.getByRole('button', { name: '锁定云盘', exact: true }).click(); await expect(page.locator('img')).toHaveCount(0); await expect(page.locator('body')).not.toContainText('private-photo.png')
 } finally { await server.close() }
})
test('interrupted image upload reuses its acknowledged encrypted thumbnail after reload and unsafe dimensions fall back without blocking upload', async ({ page }) => {
 test.setTimeout(120000); const server = await startIsolatedServer()
 try {
  await setup(page, server.baseURL, server.token); const original = await image(page); let count = 0, thumbnailId = ''
  await page.route('**/api/v1/uploads/*/objects/*', async route => {
   if (route.request().method() !== 'PUT') { await route.continue(); return }
   count++
   if (count === 1) { thumbnailId = route.request().url().split('/').at(-1)!; const response = await route.fetch(); expect(response.status()).toBe(201); await route.fulfill({ response }); return }
   if (count === 2) { await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"test_interruption"}' }); return }
   await route.continue()
  })
  await chooseOriginal(page, original)
  await expect(page.getByRole('region', { name: '可恢复的上传任务' })).toContainText('resume-image.png', { timeout: 30000 }); expect(thumbnailId).not.toBe('')
  await page.reload(); await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
  await expect(page.getByRole('region', { name: '可恢复的上传任务' })).toContainText('resume-image.png', { timeout: 30000 })
  const resumed: string[] = []; page.on('request', request => { if (request.method() === 'PUT') resumed.push(request.url().split('/').at(-1)!) })
  await page.getByRole('button', { name: '重新选择原文件并续传' }).click()
  await chooseOriginal(page, original, true)
  await expect(page.getByRole('region', { name: '可恢复的上传任务' })).toHaveCount(0, { timeout: 30000 }); await expect(page.locator('.entry-card img')).toBeVisible(); expect(resumed).not.toContain(thumbnailId)
  expect((await root(page, server.baseURL)).entries[0]!.thumbnail!.objectId).toBe(thumbnailId); expect(await download(page, 'resume-image.png')).toEqual(original)
  const unsafe = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(unsafe); unsafe.write('IHDR', 12); unsafe.writeUInt32BE(100000, 16); unsafe.writeUInt32BE(600, 20)
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'too-large.png', mimeType: 'image/png', buffer: unsafe })
  await expect(page.getByRole('button', { name: 'too-large.png', exact: true })).toBeVisible({ timeout: 30000 }); const bad = (await root(page, server.baseURL)).entries.find(entry => entry.name === 'too-large.png')!
  expect(bad.thumbnail ?? null).toBeNull(); expect(await download(page, 'too-large.png')).toEqual(unsafe)
 } finally { await server.close() }
})

test('video poster generation uses a local File URL, produces a bounded encrypted thumbnail and lock revokes displayed plaintext URLs', async ({ page, browserName }) => {
 test.setTimeout(120000); const server = await startIsolatedServer()
 try {
  await page.addInitScript(() => {
   const created: string[] = [], revoked: string[] = [], nativeCreate = URL.createObjectURL.bind(URL), nativeRevoke = URL.revokeObjectURL.bind(URL)
   Object.defineProperty(window, '__thumbnailURLAudit', { value: { created, revoked } })
   URL.createObjectURL = blob => { const url = nativeCreate(blob); if (!(blob instanceof File) && ['image/webp', 'image/jpeg'].includes(blob.type)) created.push(url); return url }
   URL.revokeObjectURL = url => { revoked.push(url); nativeRevoke(url) }
  })
  await setup(page, server.baseURL, server.token)
  const bytes = readFileSync(join(import.meta.dirname, '..', '..', 'tests', 'testdata', 'media', 'tail-moov.mp4'))
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'private-video.mp4', mimeType: 'video/mp4', buffer: bytes })
  await expect(page.locator('.entry-card img')).toBeVisible({ timeout: 30000 })
  const entry = (await root(page, server.baseURL)).entries[0]!
  expect(entry.thumbnail!.width).toBeLessThanOrEqual(256); expect(entry.thumbnail!.height).toBeLessThanOrEqual(256); expect(entry.thumbnail!.sizeBytes).toBeLessThanOrEqual(262180)
  expect(await download(page, 'private-video.mp4')).toEqual(bytes)
  await page.getByRole('button', { name: '锁定云盘', exact: true }).click(); await expect(page.locator('img')).toHaveCount(0)
  const audit = await page.evaluate(() => (window as unknown as { __thumbnailURLAudit: { created: string[]; revoked: string[] } }).__thumbnailURLAudit)
  expect(audit.created.length).toBeGreaterThan(0); for (const url of audit.created) expect(audit.revoked).toContain(url)
  const directory = join(import.meta.dirname, '..', '..', 'docs', 'operations', 'artifacts', 'thumbnail-2026-10-02', browserName); mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'thumbnail-browser-check-2026-10-01.json'), JSON.stringify({ source: `real ${browserName} local MP4 upload, authenticated encrypted root inspection, original download, lock`, originalBytes: bytes.length, thumbnail: { mime: entry.thumbnail!.mime, width: entry.thumbnail!.width, height: entry.thumbnail!.height, encryptedBytes: entry.thumbnail!.sizeBytes }, displayedPlaintextURLs: audit.created.length, allDisplayedURLsRevoked: audit.created.every(url => audit.revoked.includes(url)), physicalDevicesVerified: false }, null, 2))
 } finally { await server.close() }
})
test('visible thumbnail requests admit six, lock cancels pending reads and unlock cannot publish stale images', async ({ page }) => {
 test.setTimeout(120000); const server = await startIsolatedServer()
 try {
  await setup(page, server.baseURL, server.token); const bytes = await image(page)
  for (let index = 0; index < 12; index++) {
   const name = `photo-${String(index).padStart(2, '0')}.png`
   await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name, mimeType: 'image/png', buffer: bytes })
   await expect(page.getByRole('button', { name, exact: true })).toBeVisible({ timeout: 30000 })
   await expect(page.locator('input[type="file"]:not([webkitdirectory])').first()).toBeEnabled()
  }
  const state = await root(page, server.baseURL), ids = new Set(state.entries.map(entry => entry.thumbnail!.objectId))
  expect(ids.size).toBe(12); await page.reload()
  let release!: () => void, started = 0; const pending = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/v1/objects/*', async route => {
   if (!ids.has(route.request().url().split('/').at(-1)!)) { await route.continue(); return }
   started++; await pending; await route.continue().catch(() => {})
  })
  await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
  await expect.poll(() => started).toBe(6); await page.waitForTimeout(150); expect(started).toBe(6)
  await page.getByRole('button', { name: '锁定云盘', exact: true }).click(); release()
  await expect(page.locator('img')).toHaveCount(0); await page.waitForTimeout(150); expect(started).toBe(6)
  await page.unroute('**/api/v1/objects/*'); await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
  await expect(page.locator('.entry-card img')).toHaveCount(12, { timeout: 30000 })
  await expect.poll(() => page.locator('.entry-card img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth === 256))).toBe(true)
 } finally { await server.close() }
})
