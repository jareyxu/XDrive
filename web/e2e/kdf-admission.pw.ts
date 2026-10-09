import { expect, test } from './legacy-list-test'
import { startIsolatedServer } from './isolated-server'

test('untrusted prelogin bounds reject before starting any Worker or authentication request', async ({ page }) => {
  const server = await startIsolatedServer()
  const password = 'correct horse battery'
  try {
    await page.goto(`${server.baseURL}/setup#${server.token}`)
    await page.getByLabel('设置密码').fill(password)
    await page.getByLabel('再次输入密码').fill(password)
    await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
    await page.getByRole('button', { name: '创建加密云盘' }).click()
    await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await expect(page.getByRole('heading', { name: '欢迎回来', exact: true })).toBeVisible()
    let startedWorkers = 0, authenticationRequests = 0
    page.on('worker', () => startedWorkers++)
    page.on('request', request => { if (request.url().endsWith('/auth/login')) authenticationRequests++ })
    for (const override of [{ salt: 'A'.repeat(92) }, { m: 131073 }]) {
      await page.route('**/api/v1/auth/prelogin', async route => {
        const response = await route.fetch()
        expect(response.status()).toBe(200)
        const data = await response.json()
        await route.fulfill({ response, json: { ...data, kdf: { ...data.kdf, ...override } } })
      })
      await page.getByLabel('管理员用户名').fill('admin')
      await page.getByLabel('密码', { exact: true }).fill(password)
      await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
      await expect(page.getByRole('alert')).toContainText('无法解锁云盘')
      await expect(page.getByRole('button', { name: '解锁云盘', exact: true })).toBeEnabled()
      expect(startedWorkers).toBe(0)
      expect(authenticationRequests).toBe(0)
      expect(page.workers()).toHaveLength(0)
      await page.unroute('**/api/v1/auth/prelogin')
    }
    await page.getByLabel('密码', { exact: true }).fill(password)
    await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
    await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
    expect(startedWorkers).toBe(1)
    expect(authenticationRequests).toBe(1)
  } finally { await server.close() }
})
