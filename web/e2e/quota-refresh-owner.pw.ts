import { expect, test, type Page, type Request } from './legacy-list-test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startIsolatedServer } from './isolated-server'

const password = 'correct horse battery'
async function setup(page: Page, url: string, token: string) {
  await page.goto(`${url}/setup#${token}`)
  await page.getByLabel('设置密码').fill(password)
  await page.getByLabel('再次输入密码').fill(password)
  await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
  await page.getByRole('button', { name: '创建加密云盘' }).click()
  await expect(page.getByRole('button', { name: '上传', exact: true })).toBeEnabled()
  await expect(page.locator('.storage-meter')).toBeVisible()
  // Freeze polling after the initial genuine counters arrive. The held GET
  // must belong to the quota-error producer, not the background Query timer.
  const time = new Date()
  await page.clock.install({ time })
  await page.clock.pauseAt(new Date(time.getTime() + 60_000))
}

for (const mode of ['single', 'files', 'folder'] as const) {
  for (const ending of ['lock', 'logout', 'release'] as const) {
    test(`${mode} quota follow-up ${ending}: actual reservation rejection and owned usage response`, async ({ page }) => {
      const server = await startIsolatedServer({ quotaBytes: 100 * 1024, maintenanceReserveBytes: 16 * 1024 })
      const fixture = mkdtempSync(join(tmpdir(), 'xdrive-quota-owner-'))
      let release = () => {}, reached = () => {}, armed = false, held = false, aborted = false, delivered = false
      let heldRequest: Request | undefined
      const gate = new Promise<void>(resolve => { release = resolve })
      const waiting = new Promise<void>(resolve => { reached = resolve })
      try {
        await setup(page, server.baseURL, server.token)
        await page.route('**/api/v1/uploads/*/reserve', async route => {
          const response = await route.fetch()
          if (!response.ok()) {
            expect((await response.json()).error).toBe('quota_exceeded')
            armed = true
          }
          await route.fulfill({ response })
        })
        page.on('requestfailed', request => { if (request === heldRequest) aborted = true })
        await page.route('**/api/v1/storage/usage', async route => {
          if (!armed || held) { await route.continue(); return }
          held = true; heldRequest = route.request()
          const response = await route.fetch()
          expect(response.status()).toBe(200)
          const usage = await response.json()
          expect(usage.usedBytes + usage.reservedBytes).toBeLessThanOrEqual(usage.quotaBytes)
          reached(); await gate
          await route.fulfill({ response }).catch(() => {})
          delivered = true
        })
        const file = { name: 'quota-private.txt', mimeType: 'text/plain', buffer: Buffer.alloc(200 * 1024, 81) }
        if (mode === 'folder') {
          writeFileSync(join(fixture, file.name), file.buffer)
          await page.locator('input[webkitdirectory]').setInputFiles(fixture)
        } else {
          await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles(mode === 'files' ? [file, { ...file, name: 'second-private.txt' }] : file)
        }
        await waiting
        if (ending === 'release') {
          release(); await expect.poll(() => delivered).toBe(true)
          await expect(page.getByRole('alert')).toContainText('请先清理其他内容')
          await expect(page.getByRole('alert')).toContainText('旧文件保持原位')
          await expect(page.getByRole('button', { name: file.name, exact: true })).toHaveCount(0)
          expect(aborted).toBe(false)
          return
        }
        await page.getByRole('button', { name: ending === 'lock' ? '锁定云盘' : '退出登录', exact: true }).click()
        await expect(page.getByRole('heading', { name: ending === 'lock' ? '重新解锁云盘' : '欢迎回来', exact: true })).toBeVisible()
        // Require transport cancellation while the real response is still held.
        // Releasing the gate must not be the reason the request ends.
        await expect.poll(() => aborted).toBe(true)
        await expect(page.getByTestId('transfer-panel')).toHaveCount(0)
        await expect(page.locator('body')).not.toContainText(file.name)
        if (ending === 'logout') await page.getByLabel('管理员用户名', { exact: true }).fill('admin')
        await page.getByLabel('密码', { exact: true }).fill(password)
        await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
        await expect(page.getByRole('button', { name: '上传', exact: true })).toBeEnabled()
        await expect(page.locator('.storage-meter')).toBeVisible()
        release(); await expect.poll(() => delivered).toBe(true)
        await expect(page.getByTestId('transfer-panel')).toHaveCount(0)
        await expect(page.getByRole('alert')).toHaveCount(0)
        await expect(page.getByRole('button', { name: file.name, exact: true })).toHaveCount(0)
      } finally { release(); await server.close(); rmSync(fixture, { recursive: true, force: true }) }
    })
  }
}
