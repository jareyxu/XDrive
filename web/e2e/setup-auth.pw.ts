import { selectListPreference } from './legacy-list-test'
import { expect, test, type BrowserContext } from './legacy-list-test'
import { accessSync, constants as fsConstants, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { createHash } from 'node:crypto'
import { Uint8ArrayReader, ZipReader } from '@zip.js/zip.js'
import { EncryptedDirectoryFixture, fixtureKEK } from './encrypted-directory-fixture'
import { createMinimalPDF } from './media-fixtures'
import { indexAAD } from '../src/crypto/aad'
import { decryptObject } from '../src/crypto/envelope'
import { deriveIndexId, deriveVaultKey, unwrapVaultKey, unwrapVaultKeyBytes, wrapVaultKey } from '../src/crypto/keys'
import type { VaultConfigV1 } from '../src/crypto/keys'
import { startIsolatedServer } from './isolated-server'
import { startTLSProxy, testUsesHTTPS } from './tls-proxy.mjs'

const resumePlaintextMarker = 'XDRIVE_RESUME_PRIVATE_CONTENT_SENTINEL_2026'

test('initial setup, local unlock, lock, and logout use the live encrypted API', async ({ page, baseURL }) => {
  if (!baseURL) throw new Error('E2E base URL missing')
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined })
  })
  const setupToken = process.env.XDRIVE_E2E_SETUP_TOKEN
  if (!setupToken) throw new Error('setup token missing from Playwright setup')
  const statusResponse = await page.request.get('/api/v1/status')
  const serverStatus = await statusResponse.json() as { accountState: string }
  expect(serverStatus.accountState).toBe('pending_setup')
  const offOriginRequests: string[] = []
  let setupStatus = 0
  let submittedSetupToken = ''
  let submittedAuthKey = ''
  let submittedSetupPayload: Record<string, unknown> | undefined
  const authPayloads: Record<'login' | 'unlock', Array<Record<string, unknown>>> = { login: [], unlock: [] }
  page.on('request', (request) => {
    if (request.url().endsWith('/api/v1/setup')) {
      submittedSetupPayload = request.postDataJSON() as Record<string, unknown>
      submittedSetupToken = typeof submittedSetupPayload.token === 'string' ? submittedSetupPayload.token : ''
      submittedAuthKey = typeof submittedSetupPayload.authKey === 'string' ? submittedSetupPayload.authKey : ''
    }
    const authPath = new URL(request.url()).pathname
    if (request.method() === 'POST' && (authPath === '/api/v1/auth/login' || authPath === '/api/v1/auth/unlock')) {
      const route = authPath.endsWith('/login') ? 'login' : 'unlock'
      authPayloads[route].push(request.postDataJSON() as Record<string, unknown>)
    }
  })
  page.on('response', (response) => {
    if (response.url().endsWith('/api/v1/setup')) setupStatus = response.status()
  })
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== new URL(baseURL).origin) offOriginRequests.push(request.url())
  })

  await page.goto(`/setup#${setupToken}`)
  await expect(page.getByRole('heading', { name: '建立你的私有云盘' })).toBeVisible()
  await expect(page).toHaveURL(/\/setup$/u)
  await page.getByLabel('管理员用户名').fill('admin')
  await page.getByLabel('设置密码').fill('correct horse battery')
  await page.getByLabel('再次输入密码').fill('correct horse battery')
  await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
  await page.getByRole('button', { name: '创建加密云盘' }).click()

  await expect.poll(() => submittedSetupToken.length, { timeout: 30_000 }).toBeGreaterThan(0)
  expect(submittedSetupToken === setupToken).toBe(true)
  await expect.poll(() => setupStatus, { timeout: 30_000 }).toBe(201)
  expect(submittedSetupPayload).toBeDefined()
  const setupPayload = submittedSetupPayload!
  expect(Object.keys(setupPayload).sort()).toEqual(['authKey', 'rootIndex', 'token', 'trashIndex', 'vaultConfig'])
  expect(Buffer.from(submittedAuthKey, 'base64').length).toBe(32)
  expect(Buffer.from(submittedAuthKey, 'base64').toString('base64')).toBe(submittedAuthKey)
  expect(JSON.stringify(setupPayload)).not.toContain('correct horse battery')
  const setupConfig = setupPayload.vaultConfig as Record<string, unknown>
  expect(Object.keys(setupConfig).sort()).toEqual(['formatVersion', 'revision', 'slots'])
  expect(setupConfig.formatVersion).toBe(2)
  const keySlots = setupConfig.slots as Array<Record<string, unknown>>
  expect(keySlots).toHaveLength(1)
  expect(Object.keys(keySlots[0]!).sort()).toEqual(['kdf', 'slotId', 'type', 'wrapped'])
  expect(keySlots[0]?.type).toBe('password')
  expect(Object.keys(keySlots[0]?.kdf as Record<string, unknown>).sort()).toEqual(['alg', 'm', 'p', 'salt', 't'])
  expect(Object.keys(keySlots[0]?.wrapped as Record<string, unknown>).sort()).toEqual(['ciphertext', 'nonce'])
  expect(Object.keys(setupPayload.rootIndex as Record<string, unknown>).sort()).toEqual(['encryptedObject', 'metadataId', 'objectId', 'revision'])
  expect(Object.keys(setupPayload.trashIndex as Record<string, unknown>).sort()).toEqual(['encryptedObject', 'metadataId', 'objectId', 'revision'])
  await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
  expect(authPayloads.login).toHaveLength(1)
  expect(Object.keys(authPayloads.login[0]!).sort()).toEqual(['authKey', 'username'])
  expect(authPayloads.login[0]?.username).toBe('admin')
  expect(authPayloads.login[0]?.authKey).toBe(submittedAuthKey)
  expect(JSON.stringify(authPayloads.login[0])).not.toContain('correct horse battery')
  const loginCookie = (await page.context().cookies()).find((cookie) => cookie.name === 'xdrive_session')
  expect(loginCookie).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Strict' })
  expect(await page.evaluate(async () => (await fetch('/api/v1/storage/usage', { credentials: 'same-origin' })).status)).toBe(200)
  await expect(page.getByText('这里还没有文件')).toBeVisible()
  page.once('dialog', (dialog) => void dialog.accept('项目资料'))
  await page.getByRole('button', { name: '新建文件夹' }).click()
  await expect(page.getByRole('button', { name: '项目资料', exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: '项目资料', exact: true }).click()
  await expect(page.getByRole('heading', { name: '项目资料' })).toBeVisible()
  await expect(page.getByRole('button', { name: '上传', exact: true })).toBeEnabled()
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'private-note.txt', mimeType: 'text/plain', buffer: Buffer.from('local plaintext fixture') })
  await expect(page.getByRole('button', { name: 'private-note.txt', exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'private-note.txt', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '预览 private-note.txt' })).toContainText('local plaintext fixture')
  await page.getByRole('button', { name: '关闭预览' }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载 private-note.txt' }).click()
  const download = await downloadPromise
  const stream = await download.createReadStream()
  if (!stream) throw new Error('download stream missing')
  let downloadedText = ''
  for await (const chunk of stream) downloadedText += chunk.toString()
  expect(downloadedText).toBe('local plaintext fixture')
  await page.evaluate(() => {
    const target = window as Window & { xdriveSaveResult?: { name: string; text: string; chunks: number[][] } }
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async ({ suggestedName }: { suggestedName: string }) => ({
        createWritable: async () => new WritableStream<Uint8Array>({
          write(chunk) {
            if (target.xdriveSaveResult?.name !== suggestedName) target.xdriveSaveResult = { name: suggestedName, text: '', chunks: [] }
            const saved = target.xdriveSaveResult
            if (!saved) throw new Error('save fixture not initialized')
            saved.chunks.push(Array.from(chunk))
            if (!suggestedName.endsWith('.zip')) saved.text += new TextDecoder().decode(chunk)
          },
        }),
      }),
    })
  })
  await page.getByRole('button', { name: '下载 private-note.txt' }).click()
  await expect(page.getByRole('status')).toContainText('文件已保存。')
  const streamedSave = await page.evaluate(() => (window as Window & { xdriveSaveResult?: { name: string; text: string } }).xdriveSaveResult)
  expect(streamedSave).toMatchObject({ name: 'private-note.txt', text: 'local plaintext fixture' })
  page.once('dialog', (dialog) => void dialog.accept('renamed-note.txt'))
  await page.getByRole('button', { name: '重命名 private-note.txt' }).click()
  await expect(page.getByRole('button', { name: 'renamed-note.txt', exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: '移动到上一级 renamed-note.txt' }).click()
  await expect(page.getByText('这里还没有文件')).toBeVisible({ timeout: 30_000 })
  await page.locator('.breadcrumbs').getByRole('button', { name: '我的文件' }).click()
  await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'renamed-note.txt', exact: true })).toBeVisible()
  const storagePath = process.env.XDRIVE_E2E_STORAGE_PATH
  if (!storagePath) throw new Error('temporary object storage path missing')
  const testRoot = process.env.XDRIVE_E2E_TEST_ROOT
  if (!testRoot) throw new Error('temporary server data path missing')
  const objectFiles = listFiles(storagePath)
  expect(objectFiles.length).toBeGreaterThan(0)
  const persistedFiles = [
    ...objectFiles,
    ...['drive.db', 'drive.db-wal', 'drive.db-shm', 'server.secret']
      .map((name) => join(testRoot, name))
      .filter((path) => {
        try {
          return statSync(path).isFile()
        } catch {
          return false
        }
      }),
  ]
  const privateMarkers = [
    'private-note.txt',
    'renamed-note.txt',
    'local plaintext fixture',
    '项目资料',
    'text/plain',
    'correct horse battery',
    setupToken,
    loginCookie?.value ?? '',
    submittedAuthKey,
  ].map((marker) => Buffer.from(marker, 'utf8')).filter((marker) => marker.length > 0)
  const authKeyBytes = Buffer.from(submittedAuthKey, 'base64')
  privateMarkers.push(authKeyBytes)
  const leakedPaths = persistedFiles.filter((path) => {
    const bytes = readFileSync(path)
    return privateMarkers.some((marker) => bytes.includes(marker))
  })
  expect(leakedPaths, 'object files, SQLite files, and the server secret must not contain client-only names, MIME, or content').toEqual([])
  authKeyBytes.fill(0)
  await page.getByRole('button', { name: '锁定云盘' }).click()
  await expect(page.getByRole('heading', { name: '重新解锁云盘' })).toBeVisible()
  await page.getByLabel('密码').fill('correct horse battery')
  await page.getByRole('button', { name: '解锁云盘' }).click()
  await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
  expect(authPayloads.unlock).toHaveLength(1)
  expect(Object.keys(authPayloads.unlock[0]!).sort()).toEqual(['authKey'])
  expect(authPayloads.unlock[0]?.authKey).toBe(submittedAuthKey)
  expect(JSON.stringify(authPayloads.unlock[0])).not.toContain('correct horse battery')
  await expect(page.getByRole('button', { name: '项目资料', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'renamed-note.txt', exact: true })).toBeVisible()
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: '移到回收站 renamed-note.txt' }).click()
  await expect(page.getByRole('button', { name: 'renamed-note.txt', exact: true })).toHaveCount(0, { timeout: 30_000 })
  await page.getByRole('button', { name: '回收站', exact: true }).click()
  await expect(page.getByRole('heading', { name: '回收站' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'renamed-note.txt', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '恢复 renamed-note.txt' }).click()
  await expect(page.getByText('项目已恢复。')).toBeVisible()
  await page.getByRole('button', { name: '我的文件', exact: true }).click()
  await expect(page.getByRole('button', { name: 'renamed-note.txt', exact: true })).toBeVisible()
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: '移到回收站 renamed-note.txt' }).click()
  await expect(page.getByRole('button', { name: 'renamed-note.txt', exact: true })).toHaveCount(0, { timeout: 30_000 })
  await page.getByRole('button', { name: '回收站', exact: true }).click()
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: '永久删除 renamed-note.txt' }).click()
  await expect(page.getByText('回收站为空')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: '我的文件', exact: true }).click()
  await page.getByRole('button', { name: '项目资料', exact: true }).click()
  await expect(page.getByRole('heading', { name: '项目资料' })).toBeVisible()
  await expect(page.getByRole('button', { name: '上传', exact: true })).toBeEnabled()
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'nested-secret.txt', mimeType: 'text/plain', buffer: Buffer.from('nested trashed plaintext') })
  await expect(page.getByRole('button', { name: 'nested-secret.txt', exact: true })).toBeVisible({ timeout: 30_000 })
  await page.locator('.breadcrumbs').getByRole('button', { name: '我的文件' }).click()
  await page.getByRole('button', { name: '项目资料', exact: true }).click()
  await expect(page.getByRole('button', { name: 'nested-secret.txt', exact: true })).toBeVisible()
  await page.locator('.breadcrumbs').getByRole('button', { name: '我的文件' }).click()
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: '移到回收站 项目资料' }).click()
  await expect(page.getByRole('button', { name: '项目资料', exact: true })).toHaveCount(0, { timeout: 30_000 })
  await page.getByRole('button', { name: '回收站', exact: true }).click()
  await page.getByRole('button', { name: '项目资料', exact: true }).click()
  await expect(page.getByRole('heading', { name: '项目资料' })).toBeVisible()
  await page.getByRole('button', { name: 'nested-secret.txt', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '预览 nested-secret.txt' })).toContainText('nested trashed plaintext')
  await page.getByRole('button', { name: '关闭预览' }).click()
  await page.locator('.breadcrumbs').getByRole('button', { name: '回收站', exact: true }).click()
  await page.getByRole('button', { name: '恢复 项目资料' }).click()
  await expect(page.getByText('项目已恢复。')).toBeVisible()
  await page.getByRole('button', { name: '我的文件', exact: true }).click()
  await page.getByRole('button', { name: '项目资料', exact: true }).click()
  await expect(page.getByRole('button', { name: 'nested-secret.txt', exact: true })).toBeVisible()
  await page.locator('.breadcrumbs').getByRole('button', { name: '我的文件', exact: true }).click()
  await expect(page.getByRole('button', { name: '上传', exact: true })).toBeEnabled()
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'sample.pdf', mimeType: 'application/pdf', buffer: createMinimalPDF() })
  await expect(page.getByRole('button', { name: 'sample.pdf', exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'sample.pdf', exact: true }).click()
  await expect(page.getByRole('region', { name: 'PDF 预览' })).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => page.locator('.pdf-page canvas').evaluate((canvas) => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(0)
  await expect(page.getByRole('button', { name: '下一页' })).toBeDisabled()
  await page.getByRole('button', { name: '关闭预览' }).click()
  await expect(page.getByRole('dialog', { name: '预览 sample.pdf' })).toHaveCount(0)
  const folderFixture = mkdtempSync(join(tmpdir(), 'xdrive-folder-upload-'))
  mkdirSync(join(folderFixture, 'nested'))
  writeFileSync(join(folderFixture, 'top.txt'), 'top level')
  writeFileSync(join(folderFixture, 'nested', 'inside.txt'), 'nested level')
  await page.getByRole('button', { name: '上传文件夹' }).click()
  await page.locator('input[webkitdirectory]').setInputFiles(folderFixture)
  await expect(page.getByRole('button', { name: basename(folderFixture), exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: basename(folderFixture), exact: true }).click()
  await expect(page.getByRole('button', { name: 'top.txt', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'nested', exact: true }).click()
  await expect(page.getByRole('button', { name: 'inside.txt', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '移动 inside.txt' }).click()
  await expect(page.getByRole('dialog', { name: '移动 inside.txt' })).toBeVisible()
  await page.getByRole('button', { name: '移动到此文件夹' }).click()
  await expect(page.getByText('项目已移动。')).toBeVisible()
  await page.locator('.breadcrumbs').getByRole('button', { name: '我的文件', exact: true }).click()
  await expect(page.getByRole('button', { name: 'inside.txt', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '锁定云盘' }).click()
  await expect(page.getByRole('heading', { name: '重新解锁云盘' })).toBeVisible()
  await page.getByLabel('密码').fill('correct horse battery')
  await page.getByRole('button', { name: '解锁云盘' }).click()
  await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: basename(folderFixture), exact: true }).click()
  await expect(page.getByRole('heading', { name: basename(folderFixture) })).toBeVisible()
  await expect(page.getByRole('button', { name: 'top.txt', exact: true })).toBeVisible()
  await page.locator('.breadcrumbs').getByRole('button', { name: '我的文件', exact: true }).click()
  await page.getByRole('button', { name: '下载为 ZIP' }).click()
  await expect(page.getByRole('status')).toContainText('ZIP 文件已保存。', { timeout: 30_000 })
  const zipBytes = await page.evaluate(() => {
    const saved = (window as Window & { xdriveSaveResult?: { name: string; chunks: number[][] } }).xdriveSaveResult
    if (!saved || !saved.name.endsWith('.zip')) throw new Error('ZIP save stream missing')
    return saved.chunks.flat()
  })
  const zipReader = new ZipReader(new Uint8ArrayReader(new Uint8Array(zipBytes)))
  try {
    const zipEntries = await zipReader.getEntries()
    const zipNames = zipEntries.map((entry) => entry.filename)
    expect(zipNames).toContain('sample.pdf')
    expect(zipNames).toContain(`${basename(folderFixture)}/top.txt`)
    expect(zipNames).toContain('inside.txt')
    const archivedPdf = zipEntries.find((entry) => entry.filename === 'sample.pdf')
    expect(archivedPdf).toBeDefined()
    if (!archivedPdf || archivedPdf.directory) throw new Error('PDF archive entry is not a file')
    expect(Buffer.from(await archivedPdf.arrayBuffer())).toEqual(createMinimalPDF())
    const movedFile = zipEntries.find((entry) => entry.filename === 'inside.txt')
    expect(movedFile).toBeDefined()
    if (!movedFile || movedFile.directory) throw new Error('moved archive entry is not a file')
    expect(Buffer.from(await movedFile.arrayBuffer()).toString()).toBe('nested level')
  } finally {
    await zipReader.close()
  }
  await page.evaluate(() => Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined }))
  const fallbackDownloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载为 ZIP' }).click()
  const fallbackDownload = await fallbackDownloadPromise
  const fallbackStream = await fallbackDownload.createReadStream()
  if (!fallbackStream) throw new Error('ZIP fallback download stream missing')
  const fallbackChunks: Buffer[] = []
  for await (const chunk of fallbackStream) fallbackChunks.push(Buffer.from(chunk))
  const fallbackZipReader = new ZipReader(new Uint8ArrayReader(new Uint8Array(Buffer.concat(fallbackChunks))))
  try {
    const fallbackNames = (await fallbackZipReader.getEntries()).map((entry) => entry.filename)
    expect(fallbackNames).toContain('sample.pdf')
    expect(fallbackNames).toContain(`${basename(folderFixture)}/top.txt`)
    expect(fallbackNames).toContain('inside.txt')
  } finally {
    await fallbackZipReader.close()
  }
  rmSync(folderFixture, { recursive: true, force: true })
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible()
  expect(offOriginRequests).toEqual([])
})

test('an interrupted encrypted upload resumes after a fresh page load without re-uploading its completed chunk', async ({ page }) => {
  test.setTimeout(120_000)
  await page.addInitScript(() => Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined }))
  await page.goto('/drive')
  await page.getByLabel('管理员用户名').fill('admin')
  await page.getByLabel('密码').fill('correct horse battery')
  await page.getByRole('button', { name: '解锁云盘' }).click()
  await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
  const putObjects: string[] = []
  let aborted = false
  let firstAcknowledged!: () => void
  const firstCompleted = new Promise<void>(resolve => { firstAcknowledged = resolve })
  await page.route('**/api/v1/uploads/*/objects/*', async (route) => {
    if (route.request().method() !== 'PUT') { await route.continue(); return }
    const objectId = route.request().url().split('/').at(-1)!
    putObjects.push(objectId)
    if (putObjects.length === 1) { const response = await route.fetch(); expect(response.status()).toBe(201); await route.fulfill({ response }); firstAcknowledged(); return }
    if (putObjects.length === 2 && !aborted) { await firstCompleted; aborted = true; await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"test_interruption"}' }); return }
    await route.continue()
  })
  await chooseResumeFixture(page, 'input[type="file"]:not([webkitdirectory])')
  await expect(page.getByRole('region', { name: '可恢复的上传任务' })).toContainText('resumable.bin', { timeout: 30_000 })
  expect(aborted).toBe(true)
  const recoveryRows = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('xdrive-local-v1', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<unknown[]>((resolve, reject) => {
        const request = database.transaction('encrypted-records', 'readonly').objectStore('encrypted-records').getAll()
        request.onsuccess = () => resolve(request.result.filter((row: { id?: string }) => row.id !== '!xdrive-upload-recovery-limits-v1'))
        request.onerror = () => reject(request.error)
      })
    } finally { database.close() }
  })
  expect(recoveryRows).toHaveLength(1)
  expect(Object.keys(recoveryRows[0] as object).sort()).toEqual(['encrypted', 'id'])
  expect(JSON.stringify(recoveryRows)).not.toContain('resumable.bin')
  expect(JSON.stringify(recoveryRows)).not.toContain(resumePlaintextMarker)
  const storedRecord = recoveryRows[0] as { id: string; encrypted: string }
  const encryptedRecord = Buffer.from(storedRecord.encrypted, 'base64')
  expect(encryptedRecord.toString('base64')).toBe(storedRecord.encrypted)
  expect(encryptedRecord.subarray(0, 4).toString('ascii')).toBe('XDRV')
  expect(encryptedRecord.includes(Buffer.from(resumePlaintextMarker, 'utf8'))).toBe(false)
  const firstObject = putObjects[0]
  await page.unrouteAll()
  await page.reload()
  await expect(page.getByRole('heading', { name: '重新解锁云盘' })).toBeVisible()
  await page.getByLabel('密码').fill('correct horse battery')
  await page.getByRole('button', { name: '解锁云盘' }).click()
  await expect(page.getByRole('region', { name: '可恢复的上传任务' })).toContainText('resumable.bin', { timeout: 30_000 })
  await page.getByRole('button', { name: '重新选择原文件并续传' }).click()
  await page.locator('input[type="file"]:not([webkitdirectory])').last().evaluate((input) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['wrong bytes'], 'resumable.bin', { type: 'application/octet-stream', lastModified: 1_700_000_000_000 }))
    ;(input as HTMLInputElement).files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await expect(page.getByRole('alert')).toContainText('所选文件与原上传文件不一致')
  await expect(page.getByRole('region', { name: '可恢复的上传任务' })).toContainText('resumable.bin')
  const retryObjects: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().includes('/api/v1/uploads/')) retryObjects.push(request.url().split('/').at(-1)!)
  })
  await chooseResumeFixture(page, 'input[type="file"]:not([webkitdirectory])', true)
  await expect(page.getByRole('button', { name: 'resumable.bin', exact: true })).toBeVisible({ timeout: 30_000 })
  expect(retryObjects).not.toContain(firstObject)
  await expect(page.getByRole('region', { name: '可恢复的上传任务' })).toHaveCount(0)
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载 resumable.bin' }).click()
  const downloaded = await downloadPromise
  const stream = await downloaded.createReadStream()
  if (!stream) throw new Error('resumed download stream missing')
  let total = 0
  const expected = Buffer.alloc(8 * 1024 * 1024 + 17)
  for (let index = 0; index < expected.length; index += 1) expected[index] = index % 251
  expected.write(resumePlaintextMarker, 0, 'utf8')
  for await (const chunk of stream) {
    expect(Buffer.from(chunk as Buffer).equals(expected.subarray(total, total + (chunk as Buffer).byteLength))).toBe(true)
    total += (chunk as Buffer).byteLength
  }
  expect(total).toBe(8 * 1024 * 1024 + 17)
})

test('a lost metadata commit response is reconciled without a duplicate file or leftover recovery task', async ({ page }) => {
  await page.goto('/drive')
  await page.getByLabel('管理员用户名').fill('admin')
  await page.getByLabel('密码').fill('correct horse battery')
  await page.getByRole('button', { name: '解锁云盘' }).click()
  await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
  let commitAttempts = 0
  await page.route('**/api/v1/metadata/transactions', async (route) => {
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    commitAttempts += 1
    await route.abort('failed')
  })
  await expect(page.getByRole('button', { name: '上传', exact: true })).toBeEnabled()
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({
    name: 'response-lost.txt', mimeType: 'text/plain', buffer: Buffer.from('committed despite lost response'),
  })
  await expect.poll(() => commitAttempts, { timeout: 30_000 }).toBeGreaterThanOrEqual(3)
  await expect(page.getByRole('button', { name: 'response-lost.txt', exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('region', { name: '可恢复的上传任务' })).toHaveCount(0)
  await page.unrouteAll()
  await page.reload()
  await page.getByLabel('密码').fill('correct horse battery')
  await page.getByRole('button', { name: '解锁云盘' }).click()
  await expect(page.getByRole('button', { name: 'response-lost.txt', exact: true })).toHaveCount(1, { timeout: 30_000 })
})

test('encrypted upload recovery survives an actual selected-browser process restart', async ({ playwright, browserName, baseURL }) => {
  test.setTimeout(120_000)
  const profile = mkdtempSync(join(tmpdir(), 'xdrive-restart-profile-'))
  let context: BrowserContext | undefined
  try {
    context = await playwright[browserName].launchPersistentContext(profile, { headless: true, baseURL, ignoreHTTPSErrors: testUsesHTTPS() })
    await selectListPreference(context)
    let page = context.pages()[0] ?? await context.newPage()
    await page.goto('/drive')
    await page.getByLabel('管理员用户名').fill('admin')
    await page.getByLabel('密码').fill('correct horse battery')
    await page.getByRole('button', { name: '解锁云盘' }).click()
    await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
    const firstObjectIds: string[] = []
    await page.route('**/api/v1/uploads/*/objects/*', async (route) => {
      if (route.request().method() !== 'PUT') { await route.continue(); return }
      firstObjectIds.push(route.request().url().split('/').at(-1)!)
      if (firstObjectIds.length === 2) { await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"test_interruption"}' }); return }
      await route.continue()
    })
    await page.locator('input[type="file"]:not([webkitdirectory])').first().evaluate((input) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File([new Uint8Array([1, 2, 3, 4, 5])], 'browser-restart.bin', { lastModified: 1_700_000_000_001 }))
      ;(input as HTMLInputElement).files = transfer.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await expect(page.getByRole('region', { name: '可恢复的上传任务' })).toContainText('browser-restart.bin', { timeout: 30_000 })
    expect(firstObjectIds).toHaveLength(2)
    await context.close()
    context = undefined

    context = await playwright[browserName].launchPersistentContext(profile, { headless: true, baseURL, ignoreHTTPSErrors: testUsesHTTPS() })
    await selectListPreference(context)
    page = context.pages()[0] ?? await context.newPage()
    await page.goto('/drive')
    await expect(page.getByLabel('密码')).toBeVisible({ timeout: 30_000 })
    const username = page.getByLabel('管理员用户名')
    if (await username.isVisible()) await username.fill('admin')
    await page.getByLabel('密码').fill('correct horse battery')
    await page.getByRole('button', { name: '解锁云盘' }).click()
    await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('region', { name: '可恢复的上传任务' })).toContainText('browser-restart.bin', { timeout: 30_000 })
    const resumedPuts: string[] = []
    page.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().includes('/api/v1/uploads/')) resumedPuts.push(request.url().split('/').at(-1)!)
    })
    await page.getByRole('button', { name: '重新选择原文件并续传' }).click()
    await page.locator('input[type="file"]:not([webkitdirectory])').last().evaluate((input) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File([new Uint8Array([1, 2, 3, 4, 5])], 'browser-restart.bin', { lastModified: 1_700_000_000_001 }))
      ;(input as HTMLInputElement).files = transfer.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await expect(page.getByRole('button', { name: 'browser-restart.bin', exact: true })).toBeVisible({ timeout: 30_000 })
    expect(resumedPuts).not.toContain(firstObjectIds[0])
  } finally {
    await context?.close()
    rmSync(profile, { recursive: true, force: true })
  }
})

test('changing the password keeps encrypted files readable and revokes other sessions', async ({ page, browser, baseURL }) => {
  const otherContext = await browser.newContext({ baseURL, ignoreHTTPSErrors: testUsesHTTPS() })
  await selectListPreference(otherContext)
  const authRequests: Record<'login' | 'unlock' | 'changePassword', Array<Record<string, unknown>>> = { login: [], unlock: [], changePassword: [] }
  page.on('request', (request) => {
    if (request.method() !== 'POST') return
    const pathname = new URL(request.url()).pathname
    const route = pathname === '/api/v1/auth/login' ? 'login'
      : pathname === '/api/v1/auth/unlock' ? 'unlock'
        : pathname === '/api/v1/auth/change-password' ? 'changePassword' : undefined
    if (route) authRequests[route].push(request.postDataJSON() as Record<string, unknown>)
  })
  try {
    const otherPage = await otherContext.newPage()
    for (const candidate of [page, otherPage]) {
      await candidate.goto('/drive')
      await candidate.getByLabel('管理员用户名').fill('admin')
      await candidate.getByLabel('密码').fill('correct horse battery')
      await candidate.getByRole('button', { name: '解锁云盘' }).click()
      await expect(candidate.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
    }
    await page.getByRole('button', { name: '修改密码' }).click()
    const dialog = page.getByRole('dialog', { name: '修改密码' })
    await dialog.getByLabel('当前密码').fill('incorrect old password')
    await dialog.getByLabel('新密码', { exact: true }).fill('new correct horse battery')
    await dialog.getByLabel('确认新密码').fill('new correct horse battery')
    await dialog.getByRole('button', { name: '确认修改密码' }).click()
    await expect(dialog.getByRole('alert')).toContainText('当前密码不正确')
    await dialog.getByLabel('当前密码').fill('correct horse battery')
    await dialog.getByLabel('新密码', { exact: true }).fill('new correct horse battery')
    await dialog.getByLabel('确认新密码').fill('new correct horse battery')
    await dialog.getByRole('button', { name: '确认修改密码' }).click()
    await expect(dialog).toHaveCount(0, { timeout: 30_000 })
    expect(authRequests.login.length).toBeGreaterThan(0)
    expect(Object.keys(authRequests.login[0]!).sort()).toEqual(['authKey', 'username'])
    expect(Object.keys(authRequests.unlock.at(-1)!).sort()).toEqual(['authKey'])
    expect(authRequests.changePassword).toHaveLength(1)
    const changePayload = authRequests.changePassword[0]!
    expect(Object.keys(changePayload).sort()).toEqual(['currentAuthKey', 'expectedConfigRevision', 'newAuthKey', 'newVaultConfig'])
    const currentAuthKey = changePayload.currentAuthKey as string
    const newAuthKey = changePayload.newAuthKey as string
    expect(currentAuthKey).toBe(authRequests.login[0]?.authKey)
    expect(authRequests.unlock.at(-1)?.authKey).toBe(currentAuthKey)
    expect(Buffer.from(currentAuthKey, 'base64').length).toBe(32)
    expect(Buffer.from(newAuthKey, 'base64').length).toBe(32)
    expect(Buffer.from(currentAuthKey, 'base64').toString('base64')).toBe(currentAuthKey)
    expect(Buffer.from(newAuthKey, 'base64').toString('base64')).toBe(newAuthKey)
    expect(newAuthKey).not.toBe(currentAuthKey)
    expect(JSON.stringify(changePayload)).not.toContain('correct horse battery')
    expect(JSON.stringify(changePayload)).not.toContain('new correct horse battery')
    const changedConfig = changePayload.newVaultConfig as Record<string, unknown>
    expect(Object.keys(changedConfig).sort()).toEqual(['formatVersion', 'revision', 'slots'])
    expect(changedConfig.formatVersion).toBe(2)
    const changedSlots = changedConfig.slots as Array<Record<string, unknown>>
    expect(changedSlots).toHaveLength(1)
    expect(Object.keys(changedSlots[0]!).sort()).toEqual(['kdf', 'slotId', 'type', 'wrapped'])
    expect(Object.keys(changedSlots[0]?.wrapped as Record<string, unknown>).sort()).toEqual(['ciphertext', 'nonce'])
    const liveRoot = process.env.XDRIVE_E2E_TEST_ROOT
    const storagePath = process.env.XDRIVE_E2E_STORAGE_PATH
    if (!liveRoot || !storagePath) throw new Error('live server data paths are unavailable')
    const persistedPaths = [
      ...listFiles(storagePath),
      ...['drive.db', 'drive.db-wal', 'drive.db-shm', 'server.secret'].map(name => join(liveRoot, name)).filter(path => {
        try { return statSync(path).isFile() } catch { return false }
      }),
    ]
    const keyMarkers = [currentAuthKey, newAuthKey, 'correct horse battery', 'new correct horse battery'].map(value => Buffer.from(value, 'utf8'))
    keyMarkers.push(Buffer.from(currentAuthKey, 'base64'), Buffer.from(newAuthKey, 'base64'))
    const leakedPaths = persistedPaths.filter(path => {
      const bytes = readFileSync(path)
      return keyMarkers.some(marker => bytes.includes(marker))
    })
    expect(leakedPaths, 'password-change authentication keys must not be persisted in objects, SQLite files, or server secret').toEqual([])
    for (const marker of keyMarkers) marker.fill(0)
    await expect(page.getByRole('status')).toContainText('其他设备上的登录已失效')
    const otherSession = await (await otherPage.request.get('/api/v1/auth/session')).json() as { authenticated: boolean }
    expect(otherSession.authenticated).toBe(false)
    await page.getByRole('button', { name: '退出登录' }).click()
    await page.getByLabel('管理员用户名').fill('admin')
    await page.getByLabel('密码').fill('correct horse battery')
    await page.getByRole('button', { name: '解锁云盘' }).click()
    await expect(page.getByRole('alert')).toContainText('密码', { timeout: 30_000 })
    await page.getByLabel('密码').fill('new correct horse battery')
    await page.getByRole('button', { name: '解锁云盘' }).click()
    await expect(page.getByRole('button', { name: 'response-lost.txt', exact: true })).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: 'response-lost.txt', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '预览 response-lost.txt' })).toContainText('committed despite lost response')
  } finally { await otherContext.close() }
})

test('CLI backup and restore preserve legacy manifest schemas and mixed V1/V2 encrypted files', async ({ browser }) => {
  test.setTimeout(180_000)
  const backupDir = mkdtempSync(join(tmpdir(), 'xdrive-backup-e2e-'))
  const projectRoot = join(import.meta.dirname, '..', '..')
  const restoredRoot = join(backupDir, 'restored-data')
  const cliBinaryOverride = process.env.XDRIVE_E2E_CLI_BINARY
  const binary = cliBinaryOverride ? resolve(cliBinaryOverride) : join(backupDir, 'xdrive-test-binary')
  const initialPassword = 'correct horse battery'
  const legacyPassword = 'legacy v1 backup battery'
  const changedPassword = 'new correct horse battery'
  const legacyBytes = Buffer.from('legacy file encrypted with V1 file keys')
  const currentBytes = Buffer.from('current file encrypted with V2 file keys')
  const manifestV1Bytes = Buffer.from('historical manifest payload schema one')
  const manifestV2Bytes = Buffer.from('historical manifest payload schema two')
  let server: Awaited<ReturnType<typeof startIsolatedServer>> | undefined
  let setupContext: BrowserContext | undefined
  let previousContext: BrowserContext | undefined
  let restoredServer: ReturnType<typeof spawn> | undefined
  let restoredTLS: Awaited<ReturnType<typeof startTLSProxy>> | undefined
  try {
    server = await startIsolatedServer()
    const baseEnvironment = {
      ...process.env,
      XDRIVE_DATABASE_PATH: join(server.dataRoot, 'drive.db'),
      XDRIVE_STORAGE_PATH: join(server.dataRoot, 'objects'),
      XDRIVE_SECRET_PATH: join(server.dataRoot, 'server.secret'),
      XDRIVE_USERNAME: 'admin',
      XDRIVE_DISK_SAFETY_BYTES: '0',
    }
    setupContext = await browser.newContext({ baseURL: server.baseURL, ignoreHTTPSErrors: testUsesHTTPS() })
    await selectListPreference(setupContext)
    const setupPage = await setupContext.newPage()
    await setupPage.goto(`/setup#${server.token}`)
    await setupPage.getByLabel('管理员用户名').fill('admin')
    await setupPage.getByLabel('设置密码').fill(initialPassword)
    await setupPage.getByLabel('再次输入密码').fill(initialPassword)
    await setupPage.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
    await setupPage.getByRole('button', { name: '创建加密云盘' }).click()
    await expect(setupPage.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })

    // Exercise a mixed-format vault: write a file while its key slot and file
    // crypto are V1, then upgrade the slot and write a V2 file before backup.
    await setupPage.route('**/api/v1/auth/change-password', async (route) => {
      const body = route.request().postDataJSON() as { newVaultConfig: VaultConfigV1; [key: string]: unknown }
      const v2Config = body.newVaultConfig
      if (v2Config.formatVersion !== 2 || !v2Config.slots[0]) throw new Error('expected the password flow to submit a V2 key slot')
      const kek = await fixtureKEK(legacyPassword, v2Config.slots[0].kdf)
      const rawVaultKey = await unwrapVaultKeyBytes(kek, v2Config)
      try {
        const v1Slot = await wrapVaultKey(kek, rawVaultKey, 'backup-migration-v1-slot', v2Config.slots[0].kdf, v2Config.revision, 1)
        const v1Config: VaultConfigV1 = { ...v2Config, formatVersion: 1, slots: [v1Slot] }
        await route.continue({ postData: JSON.stringify({ ...body, newVaultConfig: v1Config }) })
      } finally { rawVaultKey.fill(0) }
    })
    await setupPage.getByRole('button', { name: '修改密码' }).click()
    const legacyChangeDialog = setupPage.getByRole('dialog', { name: '修改密码' })
    await legacyChangeDialog.getByLabel('当前密码').fill(initialPassword)
    await legacyChangeDialog.getByLabel('新密码', { exact: true }).fill(legacyPassword)
    await legacyChangeDialog.getByLabel('确认新密码').fill(legacyPassword)
    await legacyChangeDialog.getByRole('button', { name: '确认修改密码' }).click()
    await expect(legacyChangeDialog).toHaveCount(0, { timeout: 30_000 })
    await setupPage.unroute('**/api/v1/auth/change-password')
    await setupPage.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({
      name: 'legacy-backup-note.txt', mimeType: 'text/plain', buffer: legacyBytes,
    })
    await expect(setupPage.getByRole('button', { name: 'legacy-backup-note.txt', exact: true })).toBeVisible({ timeout: 30_000 })

    await setupPage.getByRole('button', { name: '修改密码' }).click()
    const changeDialog = setupPage.getByRole('dialog', { name: '修改密码' })
    await changeDialog.getByLabel('当前密码').fill(legacyPassword)
    await changeDialog.getByLabel('新密码', { exact: true }).fill(changedPassword)
    await changeDialog.getByLabel('确认新密码').fill(changedPassword)
    await changeDialog.getByRole('button', { name: '确认修改密码' }).click()
    await expect(changeDialog).toHaveCount(0, { timeout: 30_000 })
    await setupPage.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({
      name: 'current-backup-note.txt', mimeType: 'text/plain', buffer: currentBytes,
    })
    await expect(setupPage.getByRole('button', { name: 'current-backup-note.txt', exact: true })).toBeVisible({ timeout: 30_000 })
    const fixtureSession = (await setupContext.cookies()).find((entry) => entry.name === 'xdrive_session')
    if (!fixtureSession) throw new Error('authenticated session cookie missing before legacy manifest fixture')
    const encryptedFixture = await EncryptedDirectoryFixture.open(
      setupContext.request,
      server.baseURL,
      changedPassword,
      `${fixtureSession.name}=${fixtureSession.value}`,
      true,
    )
    await encryptedFixture.addLegacyManifestFile('manifest-schema-1.txt', manifestV1Bytes, 1)
    await encryptedFixture.addLegacyManifestFile('manifest-schema-2.txt', manifestV2Bytes, 2)
    await setupContext.close()
    setupContext = undefined

    previousContext = await browser.newContext({ baseURL: server.baseURL, ignoreHTTPSErrors: testUsesHTTPS() })
    await selectListPreference(previousContext)
    const previousPage = await previousContext.newPage()
    await previousPage.goto('/drive')
    await previousPage.getByLabel('管理员用户名').fill('admin')
    await previousPage.getByLabel('密码').fill(changedPassword)
    await previousPage.getByRole('button', { name: '解锁云盘' }).click()
    await expect(previousPage.getByRole('button', { name: 'legacy-backup-note.txt', exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(previousPage.getByRole('button', { name: 'current-backup-note.txt', exact: true })).toBeVisible({ timeout: 30_000 })
    const previousCookie = (await previousContext.cookies()).find((entry) => entry.name === 'xdrive_session')
    if (!previousCookie) throw new Error('live session cookie missing')

    if (cliBinaryOverride) {
      accessSync(binary, fsConstants.X_OK)
      const expectedVersion = process.env.XDRIVE_E2E_CLI_VERSION
      if (expectedVersion) {
        const actualVersion = execFileSync(binary, ['version'], { cwd: projectRoot, env: baseEnvironment, encoding: 'utf8' }).trim()
        if (!actualVersion.includes(expectedVersion)) throw new Error(`E2E CLI binary version mismatch: expected ${expectedVersion}, received ${actualVersion}`)
      }
    } else {
      execFileSync('go', ['build', '-o', binary, './cmd/xdrive'], { cwd: projectRoot, env: baseEnvironment })
    }
    execFileSync(binary, ['backup', '--verify', backupDir], { cwd: projectRoot, env: baseEnvironment })
    execFileSync(binary, ['verify-backup', backupDir], { cwd: projectRoot, env: baseEnvironment })
    const port = await availablePort()
    const restoredEnvironment = {
      ...baseEnvironment,
      XDRIVE_DATABASE_PATH: join(restoredRoot, 'drive.db'),
      XDRIVE_STORAGE_PATH: join(restoredRoot, 'objects'),
      XDRIVE_SECRET_PATH: join(restoredRoot, 'server.secret'),
      XDRIVE_LISTEN_ADDR: `127.0.0.1:${port}`,
    }
    execFileSync(binary, ['restore', backupDir], { cwd: projectRoot, env: restoredEnvironment })
    restoredServer = spawn(binary, ['serve'], { cwd: projectRoot, env: restoredEnvironment, stdio: 'pipe' })
    const upstreamURL = `http://127.0.0.1:${port}`
    await expect.poll(async () => {
      try { return (await fetch(`${upstreamURL}/readyz`)).status } catch { return 0 }
    }, { timeout: 30_000 }).toBe(200)
    if (testUsesHTTPS()) restoredTLS = await startTLSProxy(upstreamURL)
    const baseURL = restoredTLS?.baseURL ?? upstreamURL
    const oldSessionContext = await browser.newContext({ baseURL, ignoreHTTPSErrors: testUsesHTTPS() })
    await selectListPreference(oldSessionContext)
    try {
      const session = await oldSessionContext.request.get('/api/v1/auth/session', { headers: { Cookie: `${previousCookie.name}=${previousCookie.value}` } })
      expect(await session.json()).toMatchObject({ authenticated: false })
    } finally { await oldSessionContext.close() }
    const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: testUsesHTTPS() })
    await selectListPreference(context)
    try {
      const page = await context.newPage()
      await page.addInitScript(() => {
        const target = window as Window & { xdriveSavedBytes?: { name: string; chunks: number[][] } }
        Object.defineProperty(window, 'showSaveFilePicker', {
          configurable: true,
          value: async ({ suggestedName }: { suggestedName: string }) => ({
            createWritable: async () => new WritableStream<Uint8Array>({
              write(chunk) {
                if (target.xdriveSavedBytes?.name !== suggestedName) target.xdriveSavedBytes = { name: suggestedName, chunks: [] }
                target.xdriveSavedBytes.chunks.push(Array.from(chunk))
              },
            }),
          }),
        })
      })
      await page.goto('/drive')
      await page.getByLabel('管理员用户名').fill('admin')
      await page.getByLabel('密码').fill(changedPassword)
      await page.getByRole('button', { name: '解锁云盘' }).click()
      await expect(page.getByRole('button', { name: 'legacy-backup-note.txt', exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(page.getByRole('button', { name: 'current-backup-note.txt', exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(page.getByRole('button', { name: 'manifest-schema-1.txt', exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(page.getByRole('button', { name: 'manifest-schema-2.txt', exact: true })).toBeVisible({ timeout: 30_000 })
      await page.getByRole('button', { name: 'legacy-backup-note.txt', exact: true }).click()
      await expect(page.getByRole('dialog', { name: '预览 legacy-backup-note.txt' })).toContainText(legacyBytes.toString())
      await page.getByRole('button', { name: '关闭预览' }).click()
      await page.getByRole('button', { name: 'current-backup-note.txt', exact: true }).click()
      await expect(page.getByRole('dialog', { name: '预览 current-backup-note.txt' })).toContainText(currentBytes.toString())
      await page.getByRole('button', { name: '关闭预览' }).click()
      await page.getByRole('button', { name: 'manifest-schema-1.txt', exact: true }).click()
      await expect(page.getByRole('dialog', { name: '预览 manifest-schema-1.txt' })).toContainText(manifestV1Bytes.toString())
      await page.getByRole('button', { name: '关闭预览' }).click()
      await page.getByRole('button', { name: '下载 manifest-schema-1.txt' }).click()
      await expect(page.getByRole('status')).toContainText('文件已保存。')
      const schemaOneSaved = await page.evaluate(() => (window as Window & { xdriveSavedBytes?: { name: string; chunks: number[][] } }).xdriveSavedBytes)
      expect(schemaOneSaved?.name).toBe('manifest-schema-1.txt')
      expect(Buffer.from(schemaOneSaved?.chunks.flat() ?? [])).toEqual(manifestV1Bytes)
      await page.getByRole('button', { name: 'manifest-schema-2.txt', exact: true }).click()
      await expect(page.getByRole('dialog', { name: '预览 manifest-schema-2.txt' })).toContainText(manifestV2Bytes.toString())
      await page.getByRole('button', { name: '关闭预览' }).click()
      await page.getByRole('button', { name: '下载 manifest-schema-2.txt' }).click()
      await expect(page.getByRole('status')).toContainText('文件已保存。')
      const schemaTwoSaved = await page.evaluate(() => (window as Window & { xdriveSavedBytes?: { name: string; chunks: number[][] } }).xdriveSavedBytes)
      expect(schemaTwoSaved?.name).toBe('manifest-schema-2.txt')
      expect(Buffer.from(schemaTwoSaved?.chunks.flat() ?? [])).toEqual(manifestV2Bytes)
    } finally { await context.close() }
  } finally {
    await setupContext?.close()
    await previousContext?.close()
    await restoredTLS?.close()
    if (restoredServer && restoredServer.exitCode === null && restoredServer.signalCode === null) {
      restoredServer.kill('SIGTERM')
      await once(restoredServer, 'exit').catch(() => undefined)
    }
    rmSync(backupDir, { recursive: true, force: true })
    await server?.close()
  }
})

test('encrypted front and tail moov MP4 previews use bounded browser paths and preserve exact source bytes', async ({ page, browserName }) => {
  test.setTimeout(120_000)
  const server = await startIsolatedServer()
  try {
    await page.addInitScript(() => {
      const probe = { mediaBlobDigests: [] as string[], revokedBlobURLs: [] as string[] }
      Object.assign(window, { mediaBlobProbe: probe })
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL)
      URL.createObjectURL = value => {
        if (value instanceof Blob && value.type === 'video/mp4') {
          void value.arrayBuffer().then(bytes => crypto.subtle.digest('SHA-256', bytes)).then(digest => {
            probe.mediaBlobDigests.push(Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''))
          })
        }
        return create(value)
      }
      URL.revokeObjectURL = url => { probe.revokedBlobURLs.push(url); revoke(url) }
    })
    await page.goto(`${server.baseURL}/setup#${server.token}`)
    await page.getByLabel('设置密码').fill('correct horse battery')
    await page.getByLabel('再次输入密码').fill('correct horse battery')
    await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
    await page.getByRole('button', { name: '创建加密云盘' }).click()
    await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
    for (const filename of ['front-moov.mp4', 'tail-moov.mp4']) {
      const bytes = readFileSync(join(import.meta.dirname, '..', '..', 'tests', 'testdata', 'media', filename))
      await expect(page.getByRole('button', { name: '上传', exact: true })).toBeEnabled()
      await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: filename, mimeType: 'video/mp4', buffer: bytes })
      const openButton = page.getByRole('button', { name: filename, exact: true })
      await expect(openButton).toBeVisible({ timeout: 30_000 })
      await openButton.click()
      const dialog = page.getByRole('dialog', { name: `预览 ${filename}` })
      const video = dialog.locator('video')
      await expect(video).toHaveAttribute('src', browserName === 'firefox' ? /^blob:/u : /^\/__xdrive_media\/[A-Za-z0-9_-]{32}$/u, { timeout: 30_000 })
      const url = await video.getAttribute('src')
      if (!url) throw new Error('virtual media URL missing')
      if (browserName === 'firefox') {
        await expect.poll(() => page.evaluate(() => (window as Window & { mediaBlobProbe: { mediaBlobDigests: string[] } }).mediaBlobProbe.mediaBlobDigests))
          .toContain(createHash('sha256').update(bytes).digest('hex'))
      } else {
        const decryptedRanges = await page.evaluate(async (mediaURL) => {
          const front = await fetch(mediaURL, { headers: { Range: 'bytes=0-127' } })
          const tail = await fetch(mediaURL, { headers: { Range: 'bytes=-128' } })
          return { frontStatus: front.status, front: [...new Uint8Array(await front.arrayBuffer())], tailStatus: tail.status, tail: [...new Uint8Array(await tail.arrayBuffer())] }
        }, url)
        expect(decryptedRanges.frontStatus).toBe(206)
        expect(decryptedRanges.tailStatus).toBe(206)
        expect(Buffer.from(decryptedRanges.front)).toEqual(bytes.subarray(0, 128))
        expect(Buffer.from(decryptedRanges.tail)).toEqual(bytes.subarray(bytes.length - 128))
      }
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState), { timeout: 15000 }).toBeGreaterThanOrEqual(1)
      await video.evaluate((element: HTMLVideoElement) => { element.currentTime = 2 })
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 15000 }).toBeGreaterThan(1)
      await dialog.getByRole('button', { name: '关闭预览' }).click()
      if (browserName === 'firefox') {
        await expect.poll(() => page.evaluate((blobURL) => (window as Window & { mediaBlobProbe: { revokedBlobURLs: string[] } }).mediaBlobProbe.revokedBlobURLs.includes(blobURL!), url)).toBe(true)
      } else {
        await expect.poll(() => page.evaluate(async (mediaURL) => (await fetch(mediaURL, { method: 'HEAD' })).status, url)).toBe(410)
      }
    }
    await page.getByRole('button', { name: '锁定云盘' }).click()
    await expect(page.getByRole('heading', { name: '重新解锁云盘' })).toBeVisible()
  } finally { await server.close() }
})

test('batch move commits two encrypted directory indexes as one transaction', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('管理员用户名').fill('admin')
  await page.getByLabel('密码').fill('new correct horse battery')
  await page.getByRole('button', { name: '解锁云盘' }).click()
  await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
  page.once('dialog', (dialog) => void dialog.accept('batch-target'))
  await page.getByRole('button', { name: '新建文件夹' }).click()
  await expect(page.getByRole('button', { name: 'batch-target', exact: true })).toBeVisible({ timeout: 30_000 })
  for (const name of ['batch-one.txt', 'batch-two.txt']) {
    await expect(page.getByRole('button', { name: '上传', exact: true })).toBeEnabled()
    await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(`content:${name}`) })
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible({ timeout: 30_000 })
  }
  await page.getByRole('checkbox', { name: '选择 batch-one.txt' }).check()
  await page.getByRole('checkbox', { name: '选择 batch-two.txt' }).check()
  await expect(page.getByRole('toolbar', { name: '批量操作' })).toContainText('已选 2 项')
  await page.getByRole('button', { name: '批量移动' }).click()
  const dialog = page.getByRole('dialog', { name: '移动 2 个项目' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'batch-target' }).click()
  await dialog.getByRole('button', { name: '移动到此文件夹' }).click()
  await expect(dialog).toHaveCount(0, { timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'batch-one.txt', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'batch-two.txt', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'batch-target', exact: true }).click()
  await expect(page.getByRole('button', { name: 'batch-one.txt', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'batch-two.txt', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'batch-one.txt', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '预览 batch-one.txt' })).toContainText('content:batch-one.txt')
  await page.getByRole('button', { name: '关闭预览' }).click()
  await page.locator('.breadcrumbs').getByRole('button', { name: '我的文件' }).click()
  for (const name of ['batch-one.txt', 'batch-three.txt']) {
    await expect(page.getByRole('button', { name: '上传', exact: true })).toBeEnabled()
    await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(`new:${name}`) })
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible({ timeout: 30_000 })
  }
  await page.getByRole('checkbox', { name: '选择 batch-one.txt' }).check()
  await page.getByRole('checkbox', { name: '选择 batch-three.txt' }).check()
  await page.getByRole('button', { name: '批量移动' }).click()
  const conflictingMove = page.getByRole('dialog', { name: '移动 2 个项目' })
  await conflictingMove.getByRole('button', { name: 'batch-target' }).click()
  await conflictingMove.getByRole('button', { name: '移动到此文件夹' }).click()
  await expect(page.getByText('目标文件夹已有同名项目“batch-one.txt”。')).toBeVisible()
  await expect(page.getByRole('button', { name: 'batch-one.txt', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'batch-three.txt', exact: true })).toBeVisible()
})

test('upload conflict choices skip, keep both, and atomically move replaced bytes to trash', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('管理员用户名').fill('admin')
  await page.getByLabel('密码').fill('new correct horse battery')
  await page.getByRole('button', { name: '解锁云盘' }).click()
  await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
  const fileInput = page.locator('input[type="file"]:not([webkitdirectory])').first()
  await fileInput.setInputFiles({ name: 'overwrite-test.txt', mimeType: 'text/plain', buffer: Buffer.from('original bytes') })
  await expect(page.getByRole('button', { name: 'overwrite-test.txt', exact: true })).toBeVisible({ timeout: 30_000 })
  await fileInput.setInputFiles({ name: 'overwrite-test.txt', mimeType: 'text/plain', buffer: Buffer.from('skipped bytes') })
  const conflict = page.getByRole('dialog', { name: '同名文件冲突' })
  await expect(conflict).toBeVisible()
  await conflict.getByRole('button', { name: '跳过' }).click()
  await page.getByRole('button', { name: 'overwrite-test.txt', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '预览 overwrite-test.txt' })).toContainText('original bytes')
  await page.getByRole('button', { name: '关闭预览' }).click()
  await fileInput.setInputFiles({ name: 'overwrite-test.txt', mimeType: 'text/plain', buffer: Buffer.from('renamed bytes') })
  await conflict.getByRole('button', { name: '保留两者' }).click()
  await expect(page.getByRole('button', { name: 'overwrite-test (1).txt', exact: true })).toBeVisible({ timeout: 30_000 })
  await fileInput.setInputFiles({ name: 'overwrite-test.txt', mimeType: 'text/plain', buffer: Buffer.from('replacement bytes') })
  const overwriteCommit = page.waitForResponse((response) => response.url().endsWith('/api/v1/metadata/transactions') && response.status() === 200)
  await conflict.getByRole('button', { name: '覆盖并移入回收站' }).click()
  await expect(conflict).toHaveCount(0)
  await overwriteCommit
  await expect(page.getByText('上传完成。')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'overwrite-test.txt', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '预览 overwrite-test.txt' })).toContainText('replacement bytes')
  await page.getByRole('button', { name: '关闭预览' }).click()
  await page.getByRole('button', { name: '回收站', exact: true }).click()
  await page.getByRole('button', { name: 'overwrite-test.txt', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '预览 overwrite-test.txt' })).toContainText('original bytes')
})

test('an interrupted overwrite resumes with its old file still available until commit', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/login')
  await page.getByLabel('管理员用户名').fill('admin')
  await page.getByLabel('密码').fill('new correct horse battery')
  await page.getByRole('button', { name: '解锁云盘' }).click()
  await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
  const input = page.locator('input[type="file"]:not([webkitdirectory])').first()
  await input.setInputFiles({ name: 'resume-overwrite.txt', mimeType: 'text/plain', buffer: Buffer.from('old overwrite content') })
  await expect(page.getByRole('button', { name: 'resume-overwrite.txt', exact: true })).toBeVisible({ timeout: 30_000 })
  let aborted = false
  await page.route('**/api/v1/uploads/*/objects/*', async (route) => {
    if (route.request().method() === 'PUT' && !aborted) { aborted = true; await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"test_interruption"}' }); return }
    await route.continue()
  })
  await chooseOverwriteFixture(page, false)
  await page.getByRole('dialog', { name: '同名文件冲突' }).getByRole('button', { name: '覆盖并移入回收站' }).click()
  await expect(page.getByRole('region', { name: '可恢复的上传任务' })).toContainText('resume-overwrite.txt', { timeout: 30_000 })
  expect(aborted).toBe(true)
  await page.getByRole('button', { name: 'resume-overwrite.txt', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '预览 resume-overwrite.txt' })).toContainText('old overwrite content')
  await page.getByRole('button', { name: '关闭预览' }).click()
  await page.unrouteAll()
  await page.reload()
  await expect(page.getByRole('heading', { name: '重新解锁云盘' })).toBeVisible()
  await page.getByLabel('密码').fill('new correct horse battery')
  await page.getByRole('button', { name: '解锁云盘' }).click()
  await expect(page.getByRole('region', { name: '可恢复的上传任务' })).toContainText('resume-overwrite.txt', { timeout: 30_000 })
  await page.getByRole('button', { name: '重新选择原文件并续传' }).click()
  await chooseOverwriteFixture(page, true)
  await expect(page.getByRole('region', { name: '可恢复的上传任务' })).toHaveCount(0, { timeout: 30_000 })
  await page.getByRole('button', { name: 'resume-overwrite.txt', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '预览 resume-overwrite.txt' })).toContainText('new overwrite content')
  await page.getByRole('button', { name: '关闭预览' }).click()
  await page.getByRole('button', { name: '回收站', exact: true }).click()
  await page.getByRole('button', { name: 'resume-overwrite.txt', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '预览 resume-overwrite.txt' })).toContainText('old overwrite content')
})

test('restoring a nested item recreates missing parents and resolves a later folder-name conflict', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('管理员用户名').fill('admin')
  await page.getByLabel('密码').fill('new correct horse battery')
  await page.getByRole('button', { name: '解锁云盘' }).click()
  await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
  page.once('dialog', (dialog) => void dialog.accept('restore-parent'))
  await page.getByRole('button', { name: '新建文件夹' }).click()
  await page.getByRole('button', { name: 'restore-parent', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'restore-parent' })).toBeVisible()
  await expect(page.getByRole('button', { name: '上传', exact: true })).toBeEnabled()
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'restore-child.txt', mimeType: 'text/plain', buffer: Buffer.from('nested restore bytes') })
  await expect(page.getByRole('button', { name: 'restore-child.txt', exact: true })).toBeVisible({ timeout: 30_000 })
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: '移到回收站 restore-child.txt' }).click()
  await expect(page.getByRole('button', { name: 'restore-child.txt', exact: true })).toHaveCount(0)
  await page.locator('.breadcrumbs').getByRole('button', { name: '我的文件' }).click()
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: '移到回收站 restore-parent' }).click()
  await expect(page.getByRole('button', { name: 'restore-parent', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '回收站', exact: true }).click()
  await page.getByRole('button', { name: '恢复 restore-child.txt' }).click()
  await expect(page.getByText('项目已恢复。')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: '我的文件', exact: true }).click()
  await page.getByRole('button', { name: 'restore-parent', exact: true }).click()
  await page.getByRole('button', { name: 'restore-child.txt', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '预览 restore-child.txt' })).toContainText('nested restore bytes')
  await page.getByRole('button', { name: '关闭预览' }).click()
  await page.getByRole('button', { name: '回收站', exact: true }).click()
  await page.getByRole('button', { name: '恢复 restore-parent' }).click()
  await expect(page.getByRole('dialog', { name: '恢复名称冲突' })).toBeVisible()
  await page.getByRole('dialog', { name: '恢复名称冲突' }).getByRole('button', { name: '保留两者并恢复' }).click()
  await expect(page.getByText('项目已恢复。')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: '我的文件', exact: true }).click()
  await expect(page.getByRole('button', { name: 'restore-parent', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'restore-parent (1)', exact: true })).toBeVisible()
  page.once('dialog', (dialog) => void dialog.accept('blocked-parent'))
  await page.getByRole('button', { name: '新建文件夹' }).click()
  await page.getByRole('button', { name: 'blocked-parent', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'blocked-parent' })).toBeVisible()
  await expect(page.getByRole('button', { name: '上传', exact: true })).toBeEnabled()
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'blocked-child.txt', mimeType: 'text/plain', buffer: Buffer.from('path conflict bytes') })
  await expect(page.getByRole('button', { name: 'blocked-child.txt', exact: true })).toBeVisible({ timeout: 30_000 })
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: '移到回收站 blocked-child.txt' }).click()
  await expect(page.getByRole('button', { name: 'blocked-child.txt', exact: true })).toHaveCount(0)
  await page.locator('.breadcrumbs').getByRole('button', { name: '我的文件' }).click()
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: '移到回收站 blocked-parent' }).click()
  await expect(page.getByRole('button', { name: 'blocked-parent', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '上传', exact: true })).toBeEnabled()
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'blocked-parent', mimeType: 'text/plain', buffer: Buffer.from('blocking file stays') })
  await expect(page.getByRole('button', { name: 'blocked-parent', exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: '回收站', exact: true }).click()
  await page.getByRole('button', { name: '恢复 blocked-child.txt' }).click()
  await expect(page.getByRole('dialog', { name: '恢复名称冲突' })).toBeVisible()
  await page.getByRole('dialog', { name: '恢复名称冲突' }).getByRole('button', { name: '保留两者并恢复' }).click()
  await expect(page.getByText('项目已恢复。')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: '我的文件', exact: true }).click()
  await expect(page.getByRole('button', { name: 'blocked-parent', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'blocked-parent (1)', exact: true }).click()
  await expect(page.getByRole('button', { name: 'blocked-child.txt', exact: true })).toBeVisible()
})

test('upgrading a V1 key slot to V2 preserves V1 files and writes new files with V2 keys', async ({ page }) => {
  test.setTimeout(120_000)
  const server = await startIsolatedServer()
  const originalPassword = 'correct horse battery'
  const legacyPassword = 'legacy v1 migration battery'
  const upgradedPassword = 'upgraded v2 migration battery'
  try {
  await page.goto(`${server.baseURL}/setup#${server.token}`)
  await page.getByLabel('管理员用户名').fill('admin')
  await page.getByLabel('设置密码').fill(originalPassword)
  await page.getByLabel('再次输入密码').fill(originalPassword)
  await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
  await page.getByRole('button', { name: '创建加密云盘' }).click()
  await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })

  await page.route('**/api/v1/auth/change-password', async (route) => {
    const body = route.request().postDataJSON() as { newVaultConfig: VaultConfigV1; [key: string]: unknown }
    const v2Config = body.newVaultConfig
    if (v2Config.formatVersion !== 2 || !v2Config.slots[0]) throw new Error('expected the production password flow to submit a V2 key slot')
    const kek = await fixtureKEK(legacyPassword, v2Config.slots[0].kdf)
    const rawVaultKey = await unwrapVaultKeyBytes(kek, v2Config)
    try {
      const v1Slot = await wrapVaultKey(kek, rawVaultKey, 'migration-v1-slot', v2Config.slots[0].kdf, v2Config.revision, 1)
      const v1Config: VaultConfigV1 = { ...v2Config, formatVersion: 1, slots: [v1Slot] }
      await route.continue({ postData: JSON.stringify({ ...body, newVaultConfig: v1Config }) })
    } finally { rawVaultKey.fill(0) }
  })
  const changePassword = async (current: string, next: string) => {
    await page.getByRole('button', { name: '修改密码' }).click()
    const dialog = page.getByRole('dialog', { name: '修改密码' })
    await dialog.getByLabel('当前密码').fill(current)
    await dialog.getByLabel('新密码', { exact: true }).fill(next)
    await dialog.getByLabel('确认新密码').fill(next)
    await dialog.getByRole('button', { name: '确认修改密码' }).click()
    await expect(dialog).toHaveCount(0, { timeout: 30_000 })
  }
  await changePassword(originalPassword, legacyPassword)
  await page.unroute('**/api/v1/auth/change-password')
  const readConfig = async () => await page.evaluate(async () => await (await fetch('/api/v1/vault/config')).json()) as VaultConfigV1
  expect((await readConfig()).formatVersion).toBe(1)

  const legacyBytes = Buffer.from('file encrypted while its key slot is V1')
  await expect(page.getByRole('button', { name: '上传', exact: true })).toBeEnabled()
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'legacy-v1.txt', mimeType: 'text/plain', buffer: legacyBytes })
  await expect(page.getByRole('button', { name: 'legacy-v1.txt', exact: true })).toBeVisible({ timeout: 30_000 })
  await changePassword(legacyPassword, upgradedPassword)
  expect((await readConfig()).formatVersion).toBe(2)

  const currentBytes = Buffer.from('file encrypted after the V2 key hierarchy upgrade')
  await expect(page.getByRole('button', { name: '上传', exact: true })).toBeEnabled()
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'current-v2.txt', mimeType: 'text/plain', buffer: currentBytes })
  await expect(page.getByRole('button', { name: 'current-v2.txt', exact: true })).toBeVisible({ timeout: 30_000 })

  const cookie = (await page.context().cookies()).find((item) => item.name === 'xdrive_session')
  if (!cookie) throw new Error('unlocked V2 session cookie missing')
  const get = (path: string) => page.request.get(`${server.baseURL}/api/v1${path}`, { headers: { Cookie: `${cookie.name}=${cookie.value}` } })
  const configuration = await readConfig()
  const vaultKey = await unwrapVaultKey(await fixtureKEK(upgradedPassword, configuration.slots[0]!.kdf), configuration)
  const rootId = await deriveIndexId(vaultKey, 'root')
  const metadataKey = await deriveVaultKey(vaultKey, 'xdrive/v1/meta')
  const pointer = await (await get(`/metadata/${rootId}`)).json() as { revision: number; objectId: string }
  const encrypted = new Uint8Array(await (await get(`/objects/${pointer.objectId}`)).body())
  const plaintext = await decryptObject(metadataKey, encrypted, indexAAD(rootId, pointer.revision))
  let entries: { name: string; fileCryptoVersion?: number }[]
  try { entries = (JSON.parse(new TextDecoder().decode(plaintext)) as { entries: { name: string; fileCryptoVersion?: number }[] }).entries }
  finally { plaintext.fill(0); encrypted.fill(0) }
  expect(entries.find((entry) => entry.name === 'legacy-v1.txt')?.fileCryptoVersion).toBe(1)
  expect(entries.find((entry) => entry.name === 'current-v2.txt')?.fileCryptoVersion).toBe(2)

  await page.reload()
  await page.getByLabel('密码').fill(upgradedPassword)
  await page.getByRole('button', { name: '解锁云盘' }).click()
  await expect(page.getByRole('button', { name: 'legacy-v1.txt', exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'current-v2.txt', exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'legacy-v1.txt', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '预览 legacy-v1.txt' })).toContainText(legacyBytes.toString())
  await page.getByRole('button', { name: '关闭预览' }).click()
  await page.getByRole('button', { name: 'current-v2.txt', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '预览 current-v2.txt' })).toContainText(currentBytes.toString())
  } finally { await server.close() }
})

async function chooseOverwriteFixture(page: import('@playwright/test').Page, resume: boolean): Promise<void> {
  await page.locator('input[type="file"]:not([webkitdirectory])').nth(resume ? 1 : 0).evaluate((element) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['new overwrite content'], 'resume-overwrite.txt', { type: 'text/plain', lastModified: 1_700_000_000_000 }))
    ;(element as HTMLInputElement).files = transfer.files
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function availablePort(): Promise<number> {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const address = probe.address()
  if (!address || typeof address === 'string') throw new Error('no local TCP port available')
  const port = address.port
  probe.close()
  await once(probe, 'close')
  return port
}

async function chooseResumeFixture(page: import('@playwright/test').Page, selector: string, resume = false): Promise<void> {
  if (resume) await page.getByRole('button', { name: '重新选择原文件并续传' }).click()
  await (resume ? page.locator(selector).last() : page.locator(selector).first()).evaluate((input, marker) => {
    const bytes = new Uint8Array(8 * 1024 * 1024 + 17)
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251
    bytes.set(new TextEncoder().encode(marker))
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], 'resumable.bin', { type: 'application/octet-stream', lastModified: 1_700_000_000_000 }))
    ;(input as HTMLInputElement).files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, resumePlaintextMarker)
}

function listFiles(path: string): string[] {
  return readdirSync(path).flatMap((name) => {
    const child = join(path, name)
    return statSync(child).isDirectory() ? listFiles(child) : [child]
  })
}
