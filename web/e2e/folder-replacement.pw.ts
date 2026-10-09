import { testUsesHTTPS } from './tls-proxy.mjs'
import { selectListPreference } from './legacy-list-test'
import { expect, test, type Page } from './legacy-list-test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureKEK } from './encrypted-directory-fixture'
import { deriveVaultKey, unwrapVaultKey, type VaultConfigV1 } from '../src/crypto/keys'
import { localStateAAD } from '../src/crypto/aad'
import { decodeBase64Strict, encodeBase64, utf8Strict } from '../src/crypto/encoding'
import { decryptObject, encryptObject } from '../src/crypto/envelope'
import { startIsolatedServer } from './isolated-server'
const password = 'correct horse battery'
const picker = (page: Page) => page.locator('input[type="file"]:not([webkitdirectory])').first()
const source = (name: string, content = `plain:${name}`) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(content) })
async function setup(page: Page, url: string, token: string) {
  await page.goto(`${url}/setup#${token}`)
  await page.getByLabel('设置密码').fill(password)
  await page.getByLabel('再次输入密码').fill(password)
  await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
  await page.getByRole('button', { name: '创建加密云盘' }).click()
  await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 30_000 })
}
async function folder(page: Page, name: string) {
  page.once('dialog', (dialog) => void dialog.accept(name))
  await page.getByRole('button', { name: '新建文件夹', exact: true }).click()
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
}
async function enter(page: Page, name: string) {
  await page.getByRole('button', { name, exact: true }).click()
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
}
async function upload(page: Page, name: string) {
  await expect(page.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
  await picker(page).setInputFiles(source(name))
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
  await expect(page.getByRole('status')).toContainText('上传完成。')
}
async function preview(page: Page, name: string, text: string) {
  await page.getByRole('button', { name, exact: true }).click()
  await expect(page.getByRole('dialog', { name: `预览 ${name}` })).toContainText(text)
  await page.getByRole('button', { name: '关闭预览' }).click()
}
async function seed(page: Page) {
  await folder(page, 'target.txt'); await enter(page, 'target.txt')
  await upload(page, 'old.txt')
  await folder(page, 'nested'); await enter(page, 'nested')
  await upload(page, 'deep.txt')
  await page.locator('.breadcrumbs').getByRole('button', { name: '我的文件', exact: true }).click()
  await expect(page.getByRole('button', { name: '上传', exact: true })).toBeEnabled()
}
async function overwrite(page: Page) {
  await expect(page.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
  await picker(page).setInputFiles(source('target.txt', 'replacement file'))
  const dialog = page.getByRole('dialog', { name: '同名文件冲突' })
  await expect(dialog).toContainText('文件夹及全部后代')
  await dialog.getByRole('button', { name: '覆盖并移入回收站', exact: true }).click()
}

test('file versus folder supports batch skip and keep-both, atomic subtree replacement and conflict-safe restore', async ({ page }) => {
  test.setTimeout(90_000)
  const server = await startIsolatedServer()
  try {
    await setup(page, server.baseURL, server.token); await seed(page)
    await expect(page.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
    await picker(page).setInputFiles([source('target.txt'), source('unrelated.txt')])
    const dialog = page.getByRole('dialog', { name: '文件上传冲突', exact: true })
    await expect(dialog).toContainText('现有文件夹（含全部后代）')
    await dialog.getByLabel('处理 target.txt', { exact: true }).selectOption('skip')
    await dialog.getByRole('button', { name: '确认处理并上传' }).click()
    await expect(page.getByRole('status')).toContainText('批量上传完成，共 1 个文件，跳过 1 个。')
    await expect(page.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
    await picker(page).setInputFiles([source('target.txt'), source('another.txt')])
    await dialog.getByRole('button', { name: '全部保留两者' }).click()
    await dialog.getByRole('button', { name: '确认处理并上传' }).click()
    await expect(page.getByRole('status')).toContainText('批量上传完成，共 2 个文件。')
    await preview(page, 'target (1).txt', 'plain:target.txt')
    await overwrite(page)
    await expect(page.getByRole('status')).toContainText('上传完成。')
    await preview(page, 'target.txt', 'replacement file')
    expect(await page.evaluate(async () => (await (await fetch('/api/v1/storage/usage')).json()).uploadReservedBytes)).toBe(0)
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '回收站', exact: true }).click()
    await enter(page, 'target.txt')
    await preview(page, 'old.txt', 'plain:old.txt')
    await enter(page, 'nested')
    await preview(page, 'deep.txt', 'plain:deep.txt')
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '回收站', exact: true }).click()
    await page.getByRole('button', { name: '恢复 target.txt', exact: true }).click()
    await page.getByRole('dialog', { name: '恢复名称冲突' }).getByRole('button', { name: '保留两者并恢复' }).click()
    await expect(page.getByRole('status')).toContainText('项目已恢复。')
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的文件', exact: true }).click()
    await preview(page, 'target.txt', 'replacement file')
    await enter(page, 'target (2).txt')
    await preview(page, 'old.txt', 'plain:old.txt')
    await enter(page, 'nested'); await preview(page, 'deep.txt', 'plain:deep.txt')
  } finally { await server.close() }
})

test('legacy or mismatched overwrite identity cannot resume, but the original encrypted v4 record can', async ({ page }) => {
  test.setTimeout(120_000)
  const server = await startIsolatedServer(), root = mkdtempSync(join(tmpdir(), 'xdrive-folder-identity-')), path = join(root, 'target.txt')
  writeFileSync(path, 'resumed replacement file')
  try {
    await setup(page, server.baseURL, server.token); await seed(page)
    let failed = false
    await page.route('**/api/v1/uploads/*/objects/*', async (route) => {
      if (!failed && route.request().method() === 'PUT') { failed = true; await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"test_interruption"}' }) }
      else await route.continue()
    })
    await expect(page.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
    await picker(page).setInputFiles(path)
    await page.getByRole('dialog', { name: '同名文件冲突' }).getByRole('button', { name: '覆盖并移入回收站' }).click()
    await expect(page.getByRole('region', { name: '可恢复的上传任务' })).toContainText('target.txt')
    const rows = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('xdrive-local-v1', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
      try { return await new Promise<{ id: string; encrypted: string }[]>((resolve, reject) => { const request = db.transaction('encrypted-records').objectStore('encrypted-records').getAll(); request.onsuccess = () => resolve(request.result.filter((row: { id?: string }) => row.id !== '!xdrive-upload-recovery-limits-v1')); request.onerror = () => reject(request.error) }) }
      finally { db.close() }
    })
    expect(rows).toHaveLength(1)
    const configuration = await page.evaluate(async () => {
      const response = await fetch('/api/v1/vault/config')
      if (!response.ok) throw new Error(`Configuration request failed: ${response.status}`)
      return response.json()
    }) as VaultConfigV1
    // Test-only migration fixtures use the known test password and the exact
    // production AEAD. Neither app state nor server authentication is bypassed.
    const vaultKey = await unwrapVaultKey(await fixtureKEK(password, configuration.slots[0]!.kdf), configuration)
    const localKey = await deriveVaultKey(vaultKey, 'xdrive/v1/local'), aad = localStateAAD('upload-resume', rows[0]!.id)
    const plaintext = await decryptObject(localKey, decodeBase64Strict(rows[0]!.encrypted), aad)
    const original = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>
    plaintext.fill(0)
    expect(original.version).toBe(4)
    expect(original.replacementFingerprint).toMatch(/^[0-9a-f]{64}$/u)
    for (const mode of ['legacy', 'mismatch', 'original'] as const) {
      const record = { ...original, ...(mode === 'legacy' ? { version: 1 } : {}), ...(mode === 'mismatch' ? { replacementFingerprint: '0'.repeat(64) } : {}) }
      if (mode === 'legacy') { delete record.replacementFingerprint; delete record.thumbnail; delete record.fileCryptoVersion }
      const bytes = utf8Strict(JSON.stringify(record)), encrypted = await encryptObject(localKey, bytes, aad)
      bytes.fill(0)
      await page.evaluate(async (row) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('xdrive-local-v1', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
        try { await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('encrypted-records', 'readwrite'), store = tx.objectStore('encrypted-records')
          store.put(row)
          const limitsRequest = store.get('!xdrive-upload-recovery-limits-v1')
          limitsRequest.onsuccess = () => {
            const limits = limitsRequest.result as { id: string; count: number; encodedCharacters: number } | undefined
            if (limits) store.put({ ...limits, count: 1, encodedCharacters: row.encrypted.length })
          }
          tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
        }) }
        finally { db.close() }
      }, { id: rows[0]!.id, encrypted: encodeBase64(encrypted) })
      encrypted.fill(0)
      await page.reload()
      await page.getByLabel('密码', { exact: true }).fill(password)
      await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
      await expect(page.getByRole('region', { name: '可恢复的上传任务' })).toContainText('target.txt')
      const writes: string[] = []
      const observe = (request: { method(): string; url(): string }) => { if (['POST', 'PUT', 'DELETE'].includes(request.method())) writes.push(new URL(request.url()).pathname) }
      page.on('request', observe)
      const choose = page.waitForEvent('filechooser')
      await page.getByRole('button', { name: '重新选择原文件并续传', exact: true }).click()
      await (await choose).setFiles(path)
      if (mode !== 'original') {
        await expect(page.getByRole('alert')).toContainText('原覆盖目标已变化，或旧版任务缺少目标身份')
        expect(writes).toEqual([])
        await enter(page, 'target.txt'); await preview(page, 'old.txt', 'plain:old.txt')
      } else {
        await expect(page.getByRole('status')).toContainText('续传完成。')
        await preview(page, 'target.txt', 'resumed replacement file')
        await expect(page.getByRole('region', { name: '可恢复的上传任务' })).toHaveCount(0)
        expect(await page.evaluate(async () => (await (await fetch('/api/v1/storage/usage')).json()).uploadReservedBytes)).toBe(0)
      }
      page.off('request', observe)
      await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的文件', exact: true }).click()
      await expect(page.getByRole('button', { name: '上传', exact: true })).toBeEnabled()
    }
    aad.fill(0)
  } finally { await server.close(); rmSync(root, { recursive: true, force: true }) }
})

test('folder replacement rebuilds membership after a remote descendant write and exhausts four real conflicts without partial deletion', async ({ page, browser }) => {
  test.setTimeout(120_000)
  const server = await startIsolatedServer(), context = await browser.newContext({ ignoreHTTPSErrors: testUsesHTTPS() })
  await selectListPreference(context)
  try {
    await setup(page, server.baseURL, server.token); await seed(page)
    await context.addCookies(await page.context().cookies())
    const other = await context.newPage()
    await other.goto(`${server.baseURL}/drive`)
    await other.getByLabel('密码', { exact: true }).fill(password)
    await other.getByRole('button', { name: '解锁云盘', exact: true }).click()
    await enter(other, 'target.txt')
    let mode: 'once' | 'always' | 'off' = 'once'
    const finalized: string[] = [], cancelled: string[] = [], puts: string[] = []
    const memberships = new Map<string, number>()
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (request.method() === 'PUT') puts.push(path)
      if (path.endsWith('/members')) memberships.set(path.split('/').at(-2)!, (request.postDataJSON() as { members: unknown[] }).members.length)
    })
    page.on('response', (response) => { if (response.request().method() === 'DELETE' && response.url().includes('/tombstone-builds/') && response.ok()) cancelled.push(response.url().split('/').at(-1)!) })
    await page.route('**/api/v1/metadata/transactions', async (route) => {
      const body = route.request().postDataJSON() as { finalizeTombstoneBuildId?: string }
      if (body.finalizeTombstoneBuildId) {
        finalized.push(body.finalizeTombstoneBuildId)
        if (mode === 'once' && finalized.length === 1) await upload(other, 'concurrent.txt')
        if (mode === 'always') await folder(other, `contention-${finalized.length}`)
      }
      await route.continue()
    })
    await overwrite(page)
    await expect(page.getByRole('status')).toContainText('上传完成。', { timeout: 30_000 })
    expect(finalized).toHaveLength(2)
    expect(new Set(finalized).size).toBe(2)
    expect(memberships.get(finalized[1]!)).toBe(memberships.get(finalized[0]!)! + 2)
    await expect.poll(() => cancelled.length).toBe(1)
    expect(puts).toHaveLength(7)
    expect(new Set(puts).size).toBe(7)
    await preview(page, 'target.txt', 'replacement file')
    other.once('dialog', (dialog) => void dialog.accept('stale-write'))
    const staleFailure = other.waitForResponse(response => response.url().endsWith('/api/v1/metadata/transactions') && response.status() === 409)
    await other.getByRole('button', { name: '新建文件夹', exact: true }).click()
    const staleResponse = await staleFailure
    expect((await staleResponse.json()).error).toBe('metadata_tombstoned')
    await expect(other.getByRole('alert')).toContainText('此目录已移入回收站。请返回活动目录后重试。')
    await expect(other.getByRole('alert').getByRole('textbox', { name: '请求编号' })).toHaveValue(staleResponse.headers()['x-request-id']!)
    await expect(other.getByRole('button', { name: 'stale-write', exact: true })).toHaveCount(0)
    expect(await page.evaluate(async () => (await (await fetch('/api/v1/storage/usage')).json()).uploadReservedBytes)).toBe(0)
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '回收站', exact: true }).click()
    await enter(page, 'target.txt'); await preview(page, 'concurrent.txt', 'plain:concurrent.txt')
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的文件', exact: true }).click()
    await folder(page, 'contended.txt')
    await other.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的文件', exact: true }).click()
    await other.reload(); await other.getByLabel('密码', { exact: true }).fill(password)
    await other.getByRole('button', { name: '解锁云盘', exact: true }).click()
    await enter(other, 'contended.txt')
    mode = 'always'
    await expect(page.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
    await picker(page).setInputFiles(source('contended.txt'))
    await page.getByRole('dialog', { name: '同名文件冲突' }).getByRole('button', { name: '覆盖并移入回收站' }).click()
    await expect(page.getByRole('alert')).toContainText('持续修改云盘', { timeout: 30_000 })
    expect(finalized).toHaveLength(6)
    await expect.poll(() => cancelled.length).toBe(5)
    await expect(page.getByRole('button', { name: 'contended.txt', exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: '可恢复的上传任务' })).toContainText('contended.txt')
    await page.getByRole('button', { name: '放弃', exact: true }).click()
    await expect(page.getByRole('region', { name: '可恢复的上传任务' })).toHaveCount(0)
    expect(await page.evaluate(async () => (await (await fetch('/api/v1/storage/usage')).json()).uploadReservedBytes)).toBe(0)
    await enter(page, 'contended.txt')
    for (let index = 3; index <= 6; index += 1) await expect(page.getByRole('button', { name: `contention-${index}`, exact: true })).toBeVisible()
    mode = 'off'
  } finally { await context.close(); await server.close() }
})

test('a prepared descendant transaction rejected after subtree replacement releases its pending quota', async ({ page, browser }) => {
  test.setTimeout(90_000)
  const server = await startIsolatedServer(), context = await browser.newContext({ ignoreHTTPSErrors: testUsesHTTPS() })
  await selectListPreference(context)
  try {
    await setup(page, server.baseURL, server.token); await seed(page)
    await context.addCookies(await page.context().cookies())
    const other = await context.newPage()
    await other.goto(`${server.baseURL}/drive`)
    await other.getByLabel('密码', { exact: true }).fill(password)
    await other.getByRole('button', { name: '解锁云盘', exact: true }).click()
    await enter(other, 'target.txt')
    let competed = false, failedUploadId = ''
    await other.route('**/api/v1/metadata/transactions', async (route) => {
      if (!competed) {
        competed = true
        failedUploadId = (route.request().postDataJSON() as { uploadId: string }).uploadId
        await overwrite(page)
        await expect(page.getByRole('status')).toContainText('上传完成。')
      }
      await route.continue()
    })
    other.once('dialog', (dialog) => void dialog.accept('prepared-write'))
    const preparedFailure = other.waitForResponse(response => response.url().endsWith('/api/v1/metadata/transactions') && response.status() === 409)
    await other.getByRole('button', { name: '新建文件夹', exact: true }).click()
    const preparedResponse = await preparedFailure
    expect((await preparedResponse.json()).error).toBe('vault_mutation_conflict')
    await expect(other.getByRole('alert')).toContainText('云盘已发生变化，请刷新后重试。')
    await expect(other.getByRole('alert').getByRole('textbox', { name: '请求编号' })).toHaveValue(preparedResponse.headers()['x-request-id']!)
    expect(competed).toBe(true)
    const usage = await page.evaluate(async () => (await (await fetch('/api/v1/storage/usage')).json()))
    expect(usage.uploadReservedBytes).toBe(0)
    const failedSession = await other.evaluate(async (id) => (await (await fetch(`/api/v1/uploads/${id}`)).json()), failedUploadId)
    expect(failedSession.state).toBe('aborted')
    expect(failedSession.objects).toEqual([])
    expect(failedSession.claims).toEqual([])
    await preview(page, 'target.txt', 'replacement file')
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '回收站', exact: true }).click()
    await enter(page, 'target.txt')
    await expect(page.getByRole('button', { name: 'prepared-write', exact: true })).toHaveCount(0)
    await preview(page, 'old.txt', 'plain:old.txt')
  } finally { await context.close(); await server.close() }
})
