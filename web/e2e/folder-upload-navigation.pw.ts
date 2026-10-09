import { expect, test } from './legacy-list-test'
import { startIsolatedServer } from './isolated-server'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

for (const mode of ['single', 'files', 'folder'] as const) {
test(`${mode} upload committed after navigation updates its destination without replacing the current route`, async ({ page }) => {
  const server = await startIsolatedServer()
  const fixture = mkdtempSync(join(tmpdir(), 'xdrive-route-upload-'))
  let release = () => {}, reached!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const waiting = new Promise<void>(resolve => { reached = resolve })
  try {
    await page.goto(`${server.baseURL}/setup#${server.token}`)
    await page.getByLabel('设置密码').fill('correct horse battery')
    await page.getByLabel('再次输入密码').fill('correct horse battery')
    await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
    await page.getByRole('button', { name: '创建加密云盘' }).click()
    await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
    page.once('dialog', dialog => void dialog.accept('upload-destination'))
    await page.getByRole('button', { name: '新建文件夹', exact: true }).click()
    await page.getByRole('button', { name: 'upload-destination', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'upload-destination', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '上传', exact: true })).toBeEnabled()
    const destination = page.url()
    await page.route('**/api/v1/metadata/transactions', async route => {
      const response = await route.fetch()
      expect(response.status()).toBe(200)
      reached(); await gate
      await route.fulfill({ response }).catch(() => undefined)
    })
    const file = { name: 'late-upload.txt', mimeType: 'text/plain', buffer: Buffer.from('actual late encrypted commit') }
    if (mode === 'folder') {
      writeFileSync(join(fixture, file.name), file.buffer)
      await page.locator('input[webkitdirectory]').setInputFiles(fixture)
    } else await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles(mode === 'files' ? [file, { ...file, name: 'second.txt' }] : file)
    await waiting
    await page.locator('.breadcrumbs').getByRole('button', { name: '我的文件', exact: true }).click()
    await expect(page).toHaveURL(`${server.baseURL}/drive`)
    await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
    release()
    await expect(page.getByRole('status')).toContainText(mode === 'single' ? '上传完成。' : mode === 'files' ? '批量上传完成' : '文件夹上传完成')
    await expect(page).toHaveURL(`${server.baseURL}/drive`)
    await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'late-upload.txt', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'upload-destination', exact: true }).click()
    await expect(page).toHaveURL(destination)
    if (mode === 'folder') {
      await page.getByRole('button', { name: fixture.split('/').at(-1)!, exact: true }).click()
    }
    await expect(page.getByRole('button', { name: 'late-upload.txt', exact: true })).toBeVisible()
    if (mode === 'files') await expect(page.getByRole('button', { name: 'second.txt', exact: true })).toBeVisible()
  } finally { release(); await server.close(); rmSync(fixture, { recursive: true, force: true }) }
})
}

for (const action of ['lock', 'logout'] as const) {
test(`a committed upload awaiting its response cannot decrypt recovery state after ${action}`, async ({ page }) => {
  const server = await startIsolatedServer()
  let release = () => {}, reached!: () => void, handled!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const waiting = new Promise<void>(resolve => { reached = resolve })
  const finished = new Promise<void>(resolve => { handled = resolve })
  try {
    await page.goto(`${server.baseURL}/setup#${server.token}`)
    await page.getByLabel('设置密码').fill('correct horse battery')
    await page.getByLabel('再次输入密码').fill('correct horse battery')
    await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
    await page.getByRole('button', { name: '创建加密云盘' }).click()
    await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
    await page.route('**/api/v1/metadata/transactions', async route => {
      const response = await route.fetch()
      expect(response.status()).toBe(200)
      reached(); await gate
      await route.fulfill({ response }).catch(() => undefined)
      handled()
    })
    await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'committed-private.txt', mimeType: 'text/plain', buffer: Buffer.from('actual committed ciphertext before lock') })
    await waiting
    await page.evaluate(() => {
      const audit = { decrypts: 0, resumeReads: 0 }
      ;(window as Window & { xdriveUploadAudit?: typeof audit }).xdriveUploadAudit = audit
      const decrypt = crypto.subtle.decrypt.bind(crypto.subtle)
      crypto.subtle.decrypt = (...args: Parameters<SubtleCrypto['decrypt']>) => { audit.decrypts++; return decrypt(...args) }
      const transaction = IDBDatabase.prototype.transaction
      IDBDatabase.prototype.transaction = function(this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
        if (this.name === 'xdrive-local-v1' && args[1] === 'readonly') audit.resumeReads++
        return transaction.apply(this, args)
      }
    })
    const cancelled = page.waitForEvent('requestfailed', { predicate: request => request.url().endsWith('/metadata/transactions') })
    await page.getByRole('button', { name: action === 'lock' ? '锁定云盘' : '退出登录', exact: true }).click()
    await cancelled
    release(); await finished
    await expect(page.getByRole('heading', { name: action === 'lock' ? '重新解锁云盘' : '欢迎回来', exact: true })).toBeVisible()
    expect(await page.evaluate(() => (window as Window & { xdriveUploadAudit?: { decrypts: number; resumeReads: number } }).xdriveUploadAudit)).toEqual({ decrypts: 0, resumeReads: 0 })
    await expect(page.locator('body')).not.toContainText('committed-private.txt')
    expect(page.workers()).toHaveLength(0)
    await page.unroute('**/api/v1/metadata/transactions')
    if (action === 'logout') await page.getByLabel('管理员用户名').fill('admin')
    await page.getByLabel('密码', { exact: true }).fill('correct horse battery')
    await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
    await expect(page.getByRole('button', { name: 'committed-private.txt', exact: true })).toBeVisible()
    // Positive controls prove the instrumentation still observes real operations.
    await expect.poll(() => page.evaluate(() => (window as Window & { xdriveUploadAudit?: { resumeReads: number } }).xdriveUploadAudit?.resumeReads ?? 0)).toBeGreaterThan(0)
    expect(await page.evaluate(() => (window as Window & { xdriveUploadAudit?: { decrypts: number } }).xdriveUploadAudit?.decrypts ?? 0)).toBeGreaterThan(0)
  } finally { release(); await server.close() }
})
}
