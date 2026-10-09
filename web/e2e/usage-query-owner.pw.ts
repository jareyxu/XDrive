import { expect, test } from './legacy-list-test'
import { startIsolatedServer } from './isolated-server'

test('real shared usage refresh survives view navigation, aborts on lock, and unlock reads fresh counters', async ({ page }) => {
  const server = await startIsolatedServer(), password = 'correct horse battery'
  let release = () => {}
  try {
    await page.goto(`${server.baseURL}/setup#${server.token}`)
    await page.getByLabel('设置密码').fill(password); await page.getByLabel('再次输入密码').fill(password)
    await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
    await page.getByRole('button', { name: '创建加密云盘' }).click()
    await expect(page.getByRole('button', { name: '上传', exact: true })).toBeEnabled({ timeout: 30000 })
    const nav = page.getByRole('navigation', { name: '主导航' })
    await nav.getByRole('button', { name: '存储空间', exact: true }).click()
    const refresh = page.getByRole('button', { name: '刷新用量', exact: true })
    await expect(refresh).toBeEnabled()
    let reached = () => {}, failed = false, heldRequest: unknown
    const started = new Promise<void>(resolve => { reached = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    page.on('requestfailed', request => { if (request === heldRequest) failed = true })
    await page.route('**/api/v1/storage/usage', async route => {
      heldRequest = route.request()
      const response = await route.fetch()
      reached(); await gate
      await route.fulfill({ response }).catch(() => {})
    }, { times: 1 })
    await refresh.click(); await started
    await nav.getByRole('button', { name: '我的文件', exact: true }).click()
    await expect(page.getByRole('button', { name: '上传', exact: true })).toBeEnabled()
    // The sidebar remains an observer after storage unmount: do not cancel its read.
    expect(failed).toBe(false)
    await page.getByRole('button', { name: '锁定云盘', exact: true }).click()
    await expect(page.getByRole('heading', { name: '重新解锁云盘', exact: true })).toBeVisible()
    await expect.poll(() => failed).toBe(true)
    release()
    await expect(page.getByRole('meter', { name: '已用和预留容量' })).toHaveCount(0)
    await page.getByLabel('密码', { exact: true }).fill(password)
    const fresh = page.waitForResponse(response => response.url().endsWith('/api/v1/storage/usage') && response.status() === 200)
    await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
    const response = await fresh, counters = await response.json()
    expect(counters.usedBytes).toBeGreaterThan(0)
    await nav.getByRole('button', { name: '存储空间', exact: true }).click()
    await expect(refresh).toBeEnabled()
    await expect(page.getByRole('region', { name: '存储空间详情' }).getByRole('meter')).toHaveAttribute('aria-valuenow', String(counters.usedBytes + counters.reservedBytes))
  } finally { release(); await server.close() }
})

test('real upload quota recheck cancels an older held background read and both views use the new counters', async ({ page }) => {
  test.setTimeout(120000)
  const server = await startIsolatedServer()
  let release = () => {}
  try {
    await page.goto(`${server.baseURL}/setup#${server.token}`)
    await page.getByLabel('设置密码').fill('correct horse battery'); await page.getByLabel('再次输入密码').fill('correct horse battery')
    await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
    await page.getByRole('button', { name: '创建加密云盘' }).click()
    await expect(page.getByRole('button', { name: '上传', exact: true })).toBeEnabled({ timeout: 30000 })
    const nav = page.getByRole('navigation', { name: '主导航' })
    await nav.getByRole('button', { name: '存储空间', exact: true }).click()
    await expect(page.getByRole('button', { name: '刷新用量', exact: true })).toBeEnabled()
    let reached = () => {}, failed = false, heldRequest: unknown
    const started = new Promise<void>(resolve => { reached = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    page.on('requestfailed', request => { if (request === heldRequest) failed = true })
    await page.route('**/api/v1/storage/usage', async route => {
      heldRequest = route.request()
      const response = await route.fetch(); expect(response.status()).toBe(200)
      reached(); await gate; await route.fulfill({ response }).catch(() => {})
    }, { times: 1 })
    await page.getByRole('button', { name: '刷新用量', exact: true }).click(); await started
    await nav.getByRole('button', { name: '我的文件', exact: true }).click()
    await expect(page.getByRole('button', { name: '上传', exact: true })).toBeEnabled()
    await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'new-counts.txt', mimeType: 'text/plain', buffer: Buffer.alloc(32768, 65) })
    await expect.poll(() => failed).toBe(true)
    await expect(page.getByRole('status')).toContainText('上传完成。', { timeout: 30000 })
    const counters = await page.evaluate(async () => (await (await fetch('/api/v1/storage/usage')).json()))
    expect(counters.pendingBytes).toBe(0); expect(counters.uploadReservedBytes).toBe(0)
    release()
    await nav.getByRole('button', { name: '存储空间', exact: true }).click()
    await expect(page.getByRole('button', { name: '刷新用量', exact: true })).toBeEnabled()
    const region = page.getByRole('region', { name: '存储空间详情' })
    await expect(region.getByRole('meter')).toHaveAttribute('aria-valuenow', String(counters.usedBytes + counters.reservedBytes))
    await expect(page.getByRole('progressbar', { name: '已使用存储空间' })).toHaveAttribute('value', String(counters.usedBytes + counters.reservedBytes))
    await page.route('**/api/v1/storage/usage', route => route.abort('failed'), { times: 1 })
    await page.getByRole('button', { name: '刷新用量', exact: true }).click()
    await expect(region.getByRole('alert')).toContainText('下方为上次读取的用量')
    await expect(region.getByRole('meter')).toHaveAttribute('aria-valuenow', String(counters.usedBytes + counters.reservedBytes))
    await expect(page.getByRole('progressbar', { name: '已使用存储空间' })).toHaveCount(0)
    await page.getByRole('button', { name: '刷新用量', exact: true }).click()
    await expect(region.getByRole('alert')).toHaveCount(0)
    await expect(page.getByRole('progressbar', { name: '已使用存储空间' })).toHaveAttribute('value', String(counters.usedBytes + counters.reservedBytes))
  } finally { release(); await server.close() }
})
