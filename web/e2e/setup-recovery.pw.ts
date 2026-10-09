import { expect, test } from './legacy-list-test'
import { startIsolatedServer } from './isolated-server'

const password = 'correct horse battery'
for (const failure of ['automatic login', 'setup response', 'setup and status responses'] as const) {
  test(`committed setup survives a lost ${failure} without repeating initialization`, async ({ page }) => {
    const server = await startIsolatedServer()
    let setupRequests = 0
    let setupSent = false
    page.on('request', request => { if (request.url().endsWith('/api/v1/setup')) { setupRequests++; setupSent = true } })
    const faultURL = failure === 'automatic login' ? '**/api/v1/auth/login' : '**/api/v1/setup'
    try {
      await page.route(faultURL, async route => {
        if (failure !== 'automatic login') {
          const response = await route.fetch()
          expect(response.status()).toBe(201)
        }
        await route.abort('failed')
      })
      if (failure === 'setup and status responses') {
        await page.route('**/api/v1/status', route => setupSent ? route.abort('failed') : route.continue())
      }
      await page.goto(`${server.baseURL}/setup#${server.token}`)
      await page.getByLabel('设置密码').fill(password)
      await page.getByLabel('再次输入密码').fill(password)
      await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
      await page.getByRole('button', { name: '创建加密云盘' }).click()
      if (failure === 'setup and status responses') {
        await expect(page.getByRole('alert')).toContainText('暂时无法确认初始化结果')
        await expect(page.getByRole('button', { name: '创建加密云盘' })).toHaveCount(0)
        await page.unroute('**/api/v1/status')
        await page.unroute(faultURL)
        await page.getByRole('button', { name: '重新连接' }).click()
      }
      await expect(page.getByRole('heading', { name: '欢迎回来', exact: true })).toBeVisible()
      if (failure !== 'setup and status responses') await expect(page.getByRole('alert')).toContainText('设置已完成')
      await expect(page.getByLabel('设置密码')).toHaveCount(0)
      expect(await page.evaluate(async () => (await (await fetch('/api/v1/status')).json()).accountState)).toBe('active')
      expect(page.workers()).toHaveLength(0)
      expect(setupRequests).toBe(1)
      await page.unroute(faultURL)
      await page.getByLabel('管理员用户名').fill('admin')
      await page.getByLabel('密码', { exact: true }).fill(password)
      await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
      await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
      await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'setup-recovered.txt', mimeType: 'text/plain', buffer: Buffer.from('real encrypted setup recovery') })
      await expect(page.getByRole('status')).toContainText('上传完成。')
      await expect(page.getByRole('button', { name: 'setup-recovered.txt', exact: true })).toBeVisible()
      expect(setupRequests).toBe(1)
    } finally { await server.close() }
  })
}
