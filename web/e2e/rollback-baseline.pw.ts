import { startTLSProxy, testUsesHTTPS } from './tls-proxy.mjs'
import { selectListPreference } from './legacy-list-test'
import { expect, test } from './legacy-list-test'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('a lower seen vault revision enters read-only mode until explicit reauthentication resets the baseline', async ({ browser }) => {
  test.setTimeout(120_000)
  const root = mkdtempSync(join(tmpdir(), 'xdrive-rollback-e2e-'))
  const liveRoot = join(root, 'live')
  const backupDir = join(root, 'backup')
  mkdirSync(backupDir)
  const projectRoot = join(import.meta.dirname, '..', '..')
  const binary = join(root, 'xdrive-rollback-test')
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const address = probe.address()
  if (!address || typeof address === 'string') throw new Error('test port unavailable')
  const port = address.port
  probe.close()
  await once(probe, 'close')
  const environment = {
    ...process.env,
    XDRIVE_DATABASE_PATH: join(liveRoot, 'drive.db'),
    XDRIVE_STORAGE_PATH: join(liveRoot, 'objects'),
    XDRIVE_SECRET_PATH: join(liveRoot, 'server.secret'),
    XDRIVE_USERNAME: 'admin',
    XDRIVE_DISK_SAFETY_BYTES: '0',
    XDRIVE_LISTEN_ADDR: `127.0.0.1:${port}`,
  }
  let server: ReturnType<typeof spawn> | undefined
  let tlsProxy: Awaited<ReturnType<typeof startTLSProxy>> | undefined
  try {
    execFileSync('go', ['build', '-o', binary, './cmd/xdrive'], { cwd: projectRoot, env: environment })
    const initOutput = execFileSync(binary, ['init'], { cwd: projectRoot, env: environment, encoding: 'utf8' })
    const token = initOutput.match(/\/setup#([A-Za-z0-9_-]+)/u)?.[1]
    if (!token) throw new Error('setup token missing')
    server = spawn(binary, ['serve'], { cwd: projectRoot, env: environment, stdio: 'pipe' })
    const upstreamURL = `http://127.0.0.1:${port}`
    await expect.poll(async () => { try { return (await fetch(`${upstreamURL}/readyz`)).status } catch { return 0 } }, { timeout: 30_000 }).toBe(200)
    if (testUsesHTTPS()) tlsProxy = await startTLSProxy(upstreamURL)
    const baseURL = tlsProxy?.baseURL ?? upstreamURL
    const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: testUsesHTTPS() })
    await selectListPreference(context)
    try {
      const page = await context.newPage()
      await page.goto(`/setup#${token}`)
      await page.getByLabel('管理员用户名').fill('admin')
      await page.getByLabel('设置密码').fill('correct horse battery')
      await page.getByLabel('再次输入密码').fill('correct horse battery')
      await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
      await page.getByRole('button', { name: '创建加密云盘' }).click()
      await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
      execFileSync(binary, ['backup', '--verify', backupDir], { cwd: projectRoot, env: environment })
      page.once('dialog', (dialog) => void dialog.accept('rollback-fixture'))
      await page.getByRole('button', { name: '新建文件夹' }).click()
      await expect(page.getByRole('button', { name: 'rollback-fixture', exact: true })).toBeVisible()
      const maximum = await savedVaultRevision(page)
      expect(maximum).toBeGreaterThan(1)
      server.kill('SIGTERM')
      await once(server, 'exit')
      server = undefined
      rmSync(liveRoot, { recursive: true, force: true })
      execFileSync(binary, ['restore', backupDir], { cwd: projectRoot, env: environment })
      server = spawn(binary, ['serve'], { cwd: projectRoot, env: environment, stdio: 'pipe' })
      await expect.poll(async () => { try { return (await fetch(`${upstreamURL}/readyz`)).status } catch { return 0 } }, { timeout: 30_000 }).toBe(200)
      await page.reload()
      await page.getByLabel('管理员用户名').fill('admin')
      await page.getByLabel('密码').fill('correct horse battery')
      await page.getByRole('button', { name: '解锁云盘' }).click()
      await expect(page.getByRole('heading', { name: '检测到服务器数据可能发生回退' })).toBeVisible({ timeout: 30_000 })
      await expect(page.getByRole('button', { name: '新建文件夹' })).toHaveCount(0)
      await expect(page.getByRole('alert')).toContainText(`本设备曾见版本 ${maximum}`)
      expect(await savedVaultRevision(page)).toBe(maximum)
      await page.getByRole('checkbox', { name: /我刚刚从备份恢复了 XDrive/u }).check()
      await page.getByLabel('重新输入密码').fill('wrong password')
      const rejectedAuthentication = page.waitForResponse(response => response.url().endsWith('/api/v1/auth/unlock') && response.status() === 401)
      await page.getByRole('button', { name: '确认恢复并重新建立基线' }).click()
      const rejectedResponse = await rejectedAuthentication
      expect((await rejectedResponse.json()).error).toBe('invalid_credentials')
      await expect(page.getByRole('alert').last()).toContainText('用户名或密码不正确。')
      await expect(page.getByRole('alert').last().getByRole('textbox', { name: '请求编号' })).toHaveValue(rejectedResponse.headers()['x-request-id']!)
      await expect(page.getByRole('heading', { name: '检测到服务器数据可能发生回退' })).toBeVisible()
      expect(await savedVaultRevision(page)).toBe(maximum)
      await page.getByLabel('重新输入密码').fill('correct horse battery')
      await page.getByRole('button', { name: '确认恢复并重新建立基线' }).click()
      await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
      expect(await savedVaultRevision(page)).toBe(maximum - 1)
      await expect(page.getByRole('button', { name: 'rollback-fixture', exact: true })).toHaveCount(0)
      const metadataMaximum = await bumpSavedRevision(page, 'metadata')
      await page.getByRole('button', { name: '锁定云盘' }).click()
      await page.getByLabel('密码').fill('correct horse battery')
      await page.getByRole('button', { name: '解锁云盘' }).click()
      await expect(page.getByRole('heading', { name: '检测到服务器数据可能发生回退' })).toBeVisible({ timeout: 30_000 })
      await expect(page.getByRole('alert')).toContainText(`本设备曾见版本 ${metadataMaximum}`)
      await expect(page.getByRole('alert')).toContainText('目录索引')
      await page.getByRole('checkbox', { name: /我刚刚从备份恢复了 XDrive/u }).check()
      await page.getByLabel('重新输入密码').fill('correct horse battery')
      await page.getByRole('button', { name: '确认恢复并重新建立基线' }).click()
      await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
      const configMaximum = await bumpSavedRevision(page, 'config')
      await page.getByRole('button', { name: '锁定云盘' }).click()
      await page.getByLabel('密码').fill('correct horse battery')
      await page.getByRole('button', { name: '解锁云盘' }).click()
      await expect(page.getByRole('heading', { name: '检测到服务器数据可能发生回退' })).toBeVisible({ timeout: 30_000 })
      await expect(page.getByRole('alert')).toContainText(`本设备曾见版本 ${configMaximum}`)
      await expect(page.getByRole('alert')).toContainText('Vault 配置')
      await page.getByRole('checkbox', { name: /我刚刚从备份恢复了 XDrive/u }).check()
      await page.getByLabel('重新输入密码').fill('correct horse battery')
      await page.getByRole('button', { name: '确认恢复并重新建立基线' }).click()
      await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
      page.once('dialog', (dialog) => void dialog.accept('descendant-fixture'))
      await page.getByRole('button', { name: '新建文件夹' }).click()
      // The mutation coordinator refreshes the root before creating the child.
      // Wait for the committed row so this listener cannot mistake that root
      // refresh for the subsequently opened child's metadata pointer.
      await expect(page.getByRole('button', { name: 'descendant-fixture', exact: true })).toBeVisible()
      const childResponse = page.waitForResponse((response) => response.request().method() === 'GET' && /^\/drive\/[A-Za-z0-9_-]{16,64}$/u.test(new URL(page.url()).pathname) && new URL(response.url()).pathname === `/api/v1/metadata/${new URL(page.url()).pathname.split('/').at(-1)!}`)
      await page.getByRole('button', { name: 'descendant-fixture', exact: true }).click()
      const childId = new URL((await childResponse).url()).pathname.split('/').at(-1)!
      await expect(page.getByRole('heading', { name: 'descendant-fixture', exact: true })).toBeVisible()
      await bumpSavedRevision(page, 'metadata', childId)
      await page.locator('.breadcrumbs').getByRole('button', { name: '我的文件', exact: true }).click()
      await page.getByRole('button', { name: 'descendant-fixture', exact: true }).click()
      await expect(page.getByRole('heading', { name: '检测到服务器数据可能发生回退' })).toBeVisible()
      await expect(page.getByRole('alert')).toContainText(childId)
      // Only reset uses getAllKeys. Root/trash reauthentication must not clear
      // the descendant warning if the subsequent local reset cannot commit.
      await page.evaluate(() => {
        const original = IDBObjectStore.prototype.getAllKeys
        Object.assign(window, { restoreBaselineTestStorage: () => { IDBObjectStore.prototype.getAllKeys = original } })
        IDBObjectStore.prototype.getAllKeys = () => { throw new DOMException('Baseline reset unavailable', 'QuotaExceededError') }
      })
      await page.getByRole('checkbox', { name: /我刚刚从备份恢复了 XDrive/u }).check()
      await page.getByLabel('重新输入密码').fill('correct horse battery')
      await page.getByRole('button', { name: '确认恢复并重新建立基线' }).click()
      await expect(page.getByRole('alert').last()).toContainText('Baseline reset unavailable')
      await expect(page.getByRole('heading', { name: '检测到服务器数据可能发生回退' })).toBeVisible()
      await expect(page.getByRole('button', { name: '新建文件夹' })).toHaveCount(0)
      await page.evaluate(() => (window as unknown as { restoreBaselineTestStorage: () => void }).restoreBaselineTestStorage())
      await page.getByLabel('重新输入密码').fill('correct horse battery')
      await page.getByRole('button', { name: '确认恢复并重新建立基线' }).click()
      await expect(page).toHaveURL(`${baseURL}/drive/${childId}`)
      await expect(page.getByRole('heading', { name: 'descendant-fixture', exact: true })).toBeVisible({ timeout: 30_000 })
      await page.getByRole('navigation', { name: '\u4e3b\u5bfc\u822a' }).getByRole('button', { name: '\u6211\u7684\u6587\u4ef6', exact: true }).click()
      await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
      await page.addInitScript(() => {
        const original = IDBFactory.prototype.open
        IDBFactory.prototype.open = function (name, version) {
          if (name === 'xdrive-revisions-v1') throw new DOMException('Baseline storage unavailable', 'SecurityError')
          return version === undefined ? original.call(this, name) : original.call(this, name, version)
        }
      })
      await page.reload()
      await page.getByLabel('密码').fill('correct horse battery')
      await page.getByRole('button', { name: '解锁云盘' }).click()
      await expect(page.getByRole('heading', { name: '检测到服务器数据可能发生回退' })).toBeVisible({ timeout: 30_000 })
      await expect(page.getByRole('alert')).toContainText('无法读取或保存本设备的版本基线')
      await expect(page.getByRole('button', { name: '新建文件夹' })).toHaveCount(0)
    } finally { await context.close() }
  } finally {
    await tlsProxy?.close()
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM')
      await once(server, 'exit').catch(() => undefined)
    }
    rmSync(root, { recursive: true, force: true })
  }
})

async function savedVaultRevision(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('xdrive-revisions-v1', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<number>((resolve, reject) => {
        const request = database.transaction('maxima', 'readonly').objectStore('maxima').getAll()
        request.onsuccess = () => resolve((request.result as { key: string; revision: number }[]).find((row) => row.key.endsWith(':vault'))?.revision ?? -1)
        request.onerror = () => reject(request.error)
      })
    } finally { database.close() }
  })
}

async function bumpSavedRevision(page: import('@playwright/test').Page, kind: 'metadata' | 'config', metadataId?: string): Promise<number> {
  return page.evaluate(async ({ selectedKind, selectedId }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('xdrive-revisions-v1', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<number>((resolve, reject) => {
        const transaction = database.transaction('maxima', 'readwrite')
        const store = transaction.objectStore('maxima')
        const request = store.getAll()
        let nextRevision = -1
        request.onsuccess = () => {
          const rows = request.result as { key: string; revision: number }[]
          const vaultKey = rows.find((row) => row.key.endsWith(':vault'))?.key
          if (!vaultKey) { transaction.abort(); return }
          const vaultId = vaultKey.slice(0, -':vault'.length)
          const key = selectedKind === 'config' ? `${vaultId}:config` : `${vaultId}:metadata:${selectedId ?? vaultId}`
          const prior = rows.find((row) => row.key === key)
          if (!prior) { transaction.abort(); return }
          nextRevision = prior.revision + 1
          store.put({ key, revision: nextRevision })
        }
        transaction.oncomplete = () => resolve(nextRevision)
        transaction.onabort = () => reject(transaction.error ?? new Error('missing baseline row'))
        transaction.onerror = () => reject(transaction.error ?? new Error('baseline update failed'))
      })
    } finally { database.close() }
  }, { selectedKind: kind, selectedId: metadataId })
}
