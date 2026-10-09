import { expect, test, type Page } from './legacy-list-test'
import { startIsolatedServer } from './isolated-server'

const password = 'correct horse battery'
const fileInput = (page: Page) => page.locator('input[type="file"]:not([webkitdirectory])').first()
const text = (name: string, content: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(content) })

async function setup(page: Page, baseURL: string, token: string) {
  await page.goto(`${baseURL}/setup#${token}`)
  await page.getByLabel('设置密码').fill(password)
  await page.getByLabel('再次输入密码').fill(password)
  await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
  await page.getByRole('button', { name: '创建加密云盘' }).click()
  await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 30_000 })
}

async function upload(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  await expect(page.getByRole('button', { name: '上传', exact: true })).toBeEnabled()
  await fileInput(page).setInputFiles(file)
  await expect(page.getByRole('status')).toContainText('上传完成。')
  await expect(page.getByRole('button', { name: '上传', exact: true })).toBeEnabled()
}

for (const stage of ['ciphertext', 'text-conversion'] as const) for (const destination of ['root', 'settings', 'new-preview', 'lock'] as const) {
  test(`a held real preview ${stage} is cancelled by ${destination} ownership changes`, async ({ page }) => {
    test.setTimeout(90_000)
    const server = await startIsolatedServer()
    let release = () => {}, reached = () => {}, completed = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const held = new Promise<void>(resolve => { reached = resolve })
    const settled = new Promise<void>(resolve => { completed = resolve })
    let heldOnce = false
    try {
      await setup(page, server.baseURL, server.token)
      await upload(page, text('current.txt', 'current preview positive control'))
      page.once('dialog', dialog => void dialog.accept('private-folder'))
      await page.getByRole('button', { name: '新建文件夹', exact: true }).click()
      await page.getByRole('button', { name: 'private-folder', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'private-folder', exact: true })).toBeVisible()
      await upload(page, text('private.txt', 'private old preview bytes\n'.repeat(4096)))
      if (destination === 'new-preview') await upload(page, text('new.txt', 'latest preview positive control'))
      await page.evaluate(() => {
        const probe = { abortedObjects: 0 }
        Object.assign(window, { previewOwnerProbe: probe })
        const original = window.fetch.bind(window)
        window.fetch = (input, init) => {
          const url = input instanceof Request ? input.url : String(input)
          const signal = init?.signal ?? (input instanceof Request ? input.signal : null)
          if (url.includes('/api/v1/objects/') && signal) signal.addEventListener('abort', () => { probe.abortedObjects += 1 }, { once: true })
          return original(input, init)
        }
      })
      if (stage === 'text-conversion') await page.evaluate(() => {
        const state = { reached: false, release: () => {} }
        const gate = new Promise<void>(resolve => { state.release = resolve })
        const original = Blob.prototype.text
        Blob.prototype.text = async function () {
          const result = await original.call(this)
          if (this.size > 64 * 1024) { state.reached = true; await gate }
          return result
        }
        Object.assign(window, { conversionProbe: state })
      })
      if (stage === 'ciphertext') await page.route('**/api/v1/objects/*', async route => {
        if (route.request().method() !== 'GET') { await route.continue(); return }
        const response = await route.fetch()
        if (!heldOnce && Number(response.headers()['content-length']) > 64 * 1024) {
          heldOnce = true
          reached()
          await gate
          try { await route.fulfill({ response }) } catch { /* The owner may cancel the browser request. */ }
          finally { completed() }
        } else await route.fulfill({ response })
      })
      await page.getByRole('button', { name: 'private.txt', exact: true }).click()
      if (stage === 'ciphertext') await held
      else await expect.poll(() => page.evaluate(() => (window as Window & { conversionProbe: { reached: boolean } }).conversionProbe.reached)).toBe(true)
      if (destination === 'new-preview') {
        await page.getByRole('button', { name: 'new.txt', exact: true }).click()
        await expect(page.getByRole('dialog', { name: '预览 new.txt', exact: true })).toContainText('latest preview positive control')
      } else if (destination === 'lock') {
        await page.getByRole('button', { name: '锁定云盘', exact: true }).click()
        await expect(page.getByRole('heading', { name: '重新解锁云盘', exact: true })).toBeVisible()
      } else {
        await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: destination === 'root' ? '我的文件' : '设置', exact: true }).click()
        await expect(page.getByRole('heading', { name: destination === 'root' ? '我的文件' : '设置', exact: true })).toBeVisible()
      }
      await expect.poll(() => page.evaluate(() => (window as Window & { previewOwnerProbe: { abortedObjects: number } }).previewOwnerProbe.abortedObjects)).toBeGreaterThan(0)
      release()
      if (stage === 'ciphertext') await settled
      else await page.evaluate(() => (window as Window & { conversionProbe: { release: () => void } }).conversionProbe.release())
      await page.waitForTimeout(200)
      await expect(page.getByRole('dialog', { name: '预览 private.txt', exact: true })).toHaveCount(0)
      if (destination === 'new-preview') {
        await expect(page.getByRole('dialog', { name: '预览 new.txt', exact: true })).toContainText('latest preview positive control')
        await page.getByRole('button', { name: '关闭预览', exact: true }).click()
      }
      if (destination === 'lock') {
        await expect(page.locator('body')).not.toContainText('private.txt')
        await page.getByLabel('密码', { exact: true }).fill(password)
        await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
      }
      await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的文件', exact: true }).click()
      await page.getByRole('button', { name: 'current.txt', exact: true }).click()
      await expect(page.getByRole('dialog', { name: '预览 current.txt', exact: true })).toContainText('current preview positive control')
    } finally {
      release()
      if (stage === 'text-conversion') await page.evaluate(() => (window as Window & { conversionProbe?: { release: () => void } }).conversionProbe?.release()).catch(() => undefined)
      await page.unrouteAll({ behavior: 'wait' })
      await server.close()
    }
  })
}
