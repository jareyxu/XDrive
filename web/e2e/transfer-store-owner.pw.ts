import { expect, test, type Page } from './legacy-list-test'
import { startIsolatedServer } from './isolated-server'
const password = 'correct horse battery'
async function setup(page: Page, baseURL: string, token: string) {
  await page.goto(`${baseURL}/setup#${token}`)
  await page.getByLabel('设置密码').fill(password); await page.getByLabel('再次输入密码').fill(password)
  await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
  await page.getByRole('button', { name: '创建加密云盘' }).click()
  await expect(page.getByRole('button', { name: '上传', exact: true })).toBeEnabled({ timeout: 30000 })
}

test('real completed transfer expires after eight seconds without removing its committed file', async ({ page }) => {
  const server = await startIsolatedServer(), name = 'retained-transfer.txt'
  try {
    await setup(page, server.baseURL, server.token)
    await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('actual encrypted transfer') })
    const panel = page.getByTestId('transfer-panel')
    await expect(panel).toBeVisible()
    await panel.getByRole('button', { name: /项传输|传输已完成/u }).click()
    await expect(page.getByRole('region', { name: '上传和下载任务' })).toContainText(name)
    await expect(page.getByRole('region', { name: '上传和下载任务' })).toContainText('已完成')
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
    await expect(panel).toHaveCount(0, { timeout: 11000 })
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
  } finally { await server.close() }
})

test('lock drops a committed-but-unacknowledged task; late response cannot refill a freshly unlocked store', async ({ page }) => {
  const server = await startIsolatedServer(), name = 'private-late-transfer.txt'
  let release = () => {}
  try {
    await setup(page, server.baseURL, server.token)
    let reached = () => {}, released = false, failed = false, heldRequest: unknown
    const started = new Promise<void>(resolve => { reached = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    page.on('requestfailed', request => { if (request === heldRequest) failed = true })
    await page.route('**/api/v1/metadata/transactions', async route => {
      heldRequest = route.request()
      const response = await route.fetch()
      expect(response.status()).toBe(200)
      reached(); await gate
      await route.fulfill({ response }).catch(() => {})
      released = true
    }, { times: 1 })
    await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('committed before old owner closes') })
    await started
    const panel = page.getByTestId('transfer-panel')
    await panel.getByRole('button', { name: /1 项传输/u }).click()
    await expect(page.getByRole('region', { name: '上传和下载任务' })).toContainText(name)
    await expect(page.getByRole('region', { name: '上传和下载任务' })).toContainText('正在提交')
    await page.getByRole('button', { name: '锁定云盘', exact: true }).click()
    await expect(page.getByRole('heading', { name: '重新解锁云盘', exact: true })).toBeVisible()
    await expect.poll(() => failed).toBe(true)
    await expect(panel).toHaveCount(0)
    await expect(page.locator('body')).not.toContainText(name)
    // New authentication reads the genuinely committed file before releasing
    // the old routed response. This distinguishes store isolation from data loss.
    await page.getByLabel('密码', { exact: true }).fill(password)
    await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
    await expect(panel).toHaveCount(0)
    release(); await expect.poll(() => released).toBe(true)
    await expect(panel).toHaveCount(0)
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
  } finally { release(); await server.close() }
})
