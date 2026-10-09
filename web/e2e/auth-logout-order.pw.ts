import { expect, test } from './legacy-list-test'
import { startIsolatedServer } from './isolated-server'

const password = 'correct horse battery'
for (const outcome of ['success', 'network failure'] as const) {
  test(`logout blocks new authentication until ${outcome} settles, then permits a real login and upload`, async ({ page }) => {
    const server = await startIsolatedServer()
    let release!: () => void, reached!: () => void, handled!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const waiting = new Promise<void>(resolve => { reached = resolve })
    const finished = new Promise<void>(resolve => { handled = resolve })
    try {
      await page.goto(`${server.baseURL}/setup#${server.token}`)
      await page.getByLabel('设置密码').fill(password)
      await page.getByLabel('再次输入密码').fill(password)
      await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
      await page.getByRole('button', { name: '创建加密云盘' }).click()
      await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
      await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'logout-private.txt', mimeType: 'text/plain', buffer: Buffer.from('actual encrypted private fixture') })
      await expect(page.getByRole('status')).toContainText('上传完成。')
      await page.route('**/api/v1/auth/logout', async route => {
        const response = outcome === 'success' ? await route.fetch() : undefined
        if (response) {
          expect(response.status()).toBe(204)
          expect(response.headers()['set-cookie']).toContain('Max-Age=0')
        }
        reached()
        await gate
        if (response) await route.fulfill({ response })
        else await route.abort('failed')
        handled()
      })
      let authentications = 0
      page.on('request', request => {
        if (/\/auth\/(prelogin|login|unlock)$/.test(request.url())) authentications++
      })
      await page.getByRole('button', { name: '退出登录', exact: true }).click()
      await waiting
      await expect(page.getByRole('heading', { name: '欢迎回来', exact: true })).toBeVisible()
      await expect(page.getByRole('status')).toHaveText('正在退出登录…')
      await expect(page.locator('body')).not.toContainText('logout-private.txt')
      await expect.poll(() => page.workers().length).toBe(0)
      await expect(page.getByLabel('管理员用户名')).toBeDisabled()
      await expect(page.getByLabel('密码', { exact: true })).toBeDisabled()
      await expect(page.getByRole('button', { name: '解锁云盘', exact: true })).toBeDisabled()
      await expect(page.locator('form')).toHaveAttribute('aria-busy', 'true')
      // Disabled controls alone cannot guard programmatic form submission.
      await page.locator('form').evaluate(form => (form as HTMLFormElement).requestSubmit())
      expect(authentications).toBe(0)
      expect(page.workers()).toHaveLength(0)
      release()
      await finished
      await expect(page.getByRole('button', { name: '解锁云盘', exact: true })).toBeEnabled()
      await expect(page.getByRole('status')).toHaveCount(0)
      if (outcome === 'network failure') await expect(page.getByRole('alert')).toContainText('本地云盘已锁定')
      expect(await page.evaluate(async () => (await (await fetch('/api/v1/auth/session')).json()).authenticated)).toBe(outcome === 'network failure')
      await page.unroute('**/api/v1/auth/logout')
      await page.getByLabel('管理员用户名').fill('admin')
      await page.getByLabel('密码', { exact: true }).fill(password)
      await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
      await expect(page.getByRole('button', { name: 'logout-private.txt', exact: true })).toBeVisible()
      expect(await page.evaluate(async () => (await (await fetch('/api/v1/auth/session')).json()).authenticated)).toBe(true)
      await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'after-logout.txt', mimeType: 'text/plain', buffer: Buffer.from('new authenticated CSRF-protected write') })
      await expect(page.getByRole('status')).toContainText('上传完成。')
      await expect(page.getByRole('button', { name: 'after-logout.txt', exact: true })).toBeVisible()
      await page.reload()
      await expect(page.getByRole('heading', { name: '重新解锁云盘', exact: true })).toBeVisible()
      await page.getByLabel('密码', { exact: true }).fill(password)
      await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
      await expect(page.getByRole('button', { name: 'after-logout.txt', exact: true })).toBeVisible()
    } finally { release(); await server.close() }
  })
}
