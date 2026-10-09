import { expect, test, type Page } from './legacy-list-test'
import { startIsolatedServer } from './isolated-server'
const password = 'correct horse battery'
async function setup(page: Page, baseURL: string, token: string) {
  await page.goto(`${baseURL}/setup#${token}`)
  await page.getByLabel('设置密码').fill(password)
  await page.getByLabel('再次输入密码').fill(password)
  await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
  await page.getByRole('button', { name: '创建加密云盘' }).click()
  await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
}

test('authentication error shows its real Go request ID and copy/manual fallback stays associated', async ({ page, context, browserName }) => {
  const server = await startIsolatedServer()
  try {
    await setup(page, server.baseURL, server.token)
    if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.baseURL })
    await page.getByRole('button', { name: '锁定云盘', exact: true }).click()
    await page.getByLabel('密码', { exact: true }).fill('incorrect password')
    const failed = page.waitForResponse(response => response.url().endsWith('/api/v1/auth/unlock') && response.status() === 401)
    await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
    const response = await failed, body = await response.json()
    const requestId = response.headers()['x-request-id']
    expect(requestId).toMatch(/^[0-9a-f]{32}$/u)
    expect(body.requestId).toBe(requestId)
    const alert = page.getByRole('alert')
    await expect(alert).toContainText('用户名或密码不正确。')
    await expect(alert).not.toContainText('invalid_credentials')
    await expect(alert.getByRole('textbox', { name: '请求编号' })).toHaveValue(requestId)
    const button = alert.getByRole('button', { name: '复制请求编号' })
    await button.focus(); await page.keyboard.press('Enter')
    await expect(alert.getByRole('status')).toHaveText(/请求编号已复制。|无法自动复制，请选中编号后手动复制。/u)
    if (browserName === 'chromium') {
      await expect(alert.getByRole('status')).toHaveText('请求编号已复制。')
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(requestId)
    } else if ((await alert.getByRole('status').textContent())!.includes('手动复制')) {
      await expect(alert.getByRole('textbox')).toBeFocused()
      expect(await alert.getByRole('textbox').evaluate((node: HTMLInputElement) => [node.selectionStart, node.selectionEnd])).toEqual([0, requestId.length])
    }
    const bounds = await button.boundingBox()
    expect(bounds!.height).toBeGreaterThanOrEqual(44); expect(bounds!.width).toBeGreaterThanOrEqual(44)
    await page.getByLabel('密码', { exact: true }).fill(password)
    await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
    await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
    await expect(page.getByRole('textbox', { name: '请求编号' })).toHaveCount(0)
  } finally { await server.close() }
})

test('storage refresh failures display the current response ID and replace it on retry', async ({ page }) => {
  const server = await startIsolatedServer()
  try {
    await setup(page, server.baseURL, server.token)
    // Revoke the real cookie on the server without replacing API responses.
    expect(await page.evaluate(async () => {
      const session = await fetch('/api/v1/auth/session')
      const csrf = session.headers.get('X-CSRF-Token')!
      return (await fetch('/api/v1/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrf, 'X-XDrive-Client-Protocol': '1' } })).status
    })).toBe(204)
    const first = page.waitForResponse(response => response.url().endsWith('/api/v1/storage/usage') && response.status() === 401)
    await page.getByRole('button', { name: '存储空间', exact: true }).click()
    const response = await first, firstId = response.headers()['x-request-id']
    expect((await response.json()).requestId).toBe(firstId)
    const alert = page.getByRole('alert')
    await expect(alert.getByRole('textbox', { name: '请求编号' })).toHaveValue(firstId)
    await expect(alert).toContainText('会话已失效')
    const retry = page.waitForResponse(next => next.url().endsWith('/api/v1/storage/usage') && next.status() === 401)
    await page.getByRole('button', { name: '刷新用量', exact: true }).click()
    const second = await retry, secondId = second.headers()['x-request-id']
    expect(secondId).not.toBe(firstId)
    await expect(alert.getByRole('textbox', { name: '请求编号' })).toHaveValue(secondId)
    await expect(alert).not.toContainText(firstId)
  } finally { await server.close() }
})
