import { expect, test, type Page } from './legacy-list-test'
import { createHash } from 'node:crypto'
import type {} from '../src/preferences/preferences'
import { startIsolatedServer } from './isolated-server'
const chunk = 8 * 1024 * 1024, password = 'correct horse battery'
async function setup(page: Page, url: string, token: string) {
 await page.goto(`${url}/setup#${token}`); await page.getByLabel('设置密码').fill(password); await page.getByLabel('再次输入密码').fill(password)
 await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check(); await page.getByRole('button', { name: '创建加密云盘' }).click()
 await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 30000 })
}
async function select(page: Page, size: number, resume = false) {
 if (!resume) await expect(page.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
 await page.locator('input[type="file"]:not([webkitdirectory])').nth(resume ? 1 : 0).evaluate((input, size) => {
  const bytes = new Uint8Array(size); for (let offset = 0; offset < size; offset++) bytes[offset] = Math.floor(offset / (8 * 1024 * 1024)) + 1
  const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'parallel.bin', { type: 'application/octet-stream', lastModified: 1700000000000 })); (input as HTMLInputElement).files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }))
 }, size)
}
for (const parallel of [2, 4] as const) test(`whole upload limits admission to ${parallel} chunk tasks and preserves out-of-order chunk content`, async ({ page }) => {
 test.setTimeout(120000); const server = await startIsolatedServer(), size = (parallel + 2) * chunk + 17
 const gates: (() => void)[] = []; let active = 0, peak = 0, total = 0
 try {
  await page.addInitScript(() => Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined }))
  await setup(page, server.baseURL, server.token)
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('上传分块并发', { exact: true }).selectOption(String(parallel))
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的文件', exact: true }).click()
  await page.route('**/api/v1/uploads/*/objects/*', async route => {
   if (route.request().method() !== 'PUT' || Number(route.request().headers()['x-xdrive-object-size']) < chunk) { await route.continue(); return }
   total++; peak = Math.max(peak, ++active)
   if (total <= parallel) await new Promise<void>(resolve => gates.push(resolve))
   try { const response = await route.fetch(); expect(response.status()).toBe(201); await route.fulfill({ response }) } finally { active-- }
  })
  await select(page, size)
  await expect.poll(() => gates.length, { timeout: 30000 }).toBe(parallel)
  await page.waitForTimeout(200); expect(total).toBe(parallel); expect(peak).toBe(parallel)
  const usage = await page.evaluate(async () => (await (await fetch('/api/v1/storage/usage')).json()))
  expect(usage.usedBytes + usage.reservedBytes).toBeLessThanOrEqual(usage.quotaBytes)
  // Release the last admitted task first; earlier chunks remain held while the
  // later chunk and the remaining work finish, so manifest order is tested.
  gates[parallel - 1]!(); await expect.poll(() => total, { timeout: 30000 }).toBe(parallel + 2)
  expect(peak).toBeLessThanOrEqual(parallel); gates.forEach(open => open())
  await expect(page.getByRole('button', { name: 'parallel.bin', exact: true })).toBeVisible({ timeout: 30000 })
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: '下载 parallel.bin', exact: true }).click()
  const stream = await (await download).createReadStream(); if (!stream) throw new Error('download stream missing')
  const digest = createHash('sha256'); let received = 0
  for await (const bytes of stream) { digest.update(bytes); received += bytes.length }
  const expected = createHash('sha256'); for (let i = 0; i < parallel + 2; i++) expected.update(Buffer.alloc(chunk, i + 1)); expected.update(Buffer.alloc(17, parallel + 3))
  expect(received).toBe(size); expect(digest.digest('hex')).toBe(expected.digest('hex'))
  const finished = await page.evaluate(async () => (await (await fetch('/api/v1/storage/usage')).json()))
  expect(finished.uploadReservedBytes).toBe(0); expect(finished.pendingBytes).toBe(0)
 } finally { gates.forEach(open => open()); await server.close() }
})

test('a failed concurrent PUT aborts siblings and resumes only missing chunks after refresh', async ({ page }) => {
 test.setTimeout(120000); const server = await startIsolatedServer(), size = 3 * chunk + 17
 let acknowledged = '', completed!: () => void; const first = new Promise<void>(resolve => { completed = resolve }); let puts = 0
 try {
  await page.addInitScript(() => Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined }))
  await setup(page, server.baseURL, server.token)
  await page.route('**/api/v1/uploads/*/objects/*', async route => {
   if (route.request().method() !== 'PUT') { await route.continue(); return }
   puts++
   if (puts === 1) { const response = await route.fetch(); expect(response.status()).toBe(201); acknowledged = route.request().url().split('/').at(-1)!; await route.fulfill({ response }); completed(); return }
   if (puts === 2) { await first; await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"test_interruption"}' }); return }
   await route.continue()
  })
  await select(page, size)
  await expect(page.getByRole('region', { name: '可恢复的上传任务' })).toContainText('parallel.bin', { timeout: 30000 }); expect(acknowledged).not.toBe('')
  await page.unrouteAll(); await page.reload(); await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
  await expect(page.getByRole('region', { name: '可恢复的上传任务' })).toContainText('parallel.bin')
  const resumed: string[] = []; page.on('request', r => { if (r.method() === 'PUT') resumed.push(r.url().split('/').at(-1)!) })
  await page.getByRole('button', { name: '重新选择原文件并续传', exact: true }).click(); await select(page, size, true)
  await expect(page.getByRole('button', { name: 'parallel.bin', exact: true })).toBeVisible({ timeout: 30000 }); expect(resumed).not.toContain(acknowledged)
  await expect(page.getByRole('region', { name: '可恢复的上传任务' })).toHaveCount(0)
  const done = await page.evaluate(async () => (await (await fetch('/api/v1/storage/usage')).json()))
  expect(done.pendingBytes).toBe(0); expect(done.uploadReservedBytes).toBe(0)
 } finally { completed(); await server.close() }
})

test('locking a four-chunk upload stops admission, clears plaintext UI and preserves encrypted recovery without pending objects', async ({ page }) => {
 test.setTimeout(120000); const server = await startIsolatedServer(), size = 5 * chunk + 17
 let release!: () => void; const held = new Promise<void>(resolve => { release = resolve }); let puts = 0
 try {
  await setup(page, server.baseURL, server.token)
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '设置', exact: true }).click(); await page.getByLabel('上传分块并发', { exact: true }).selectOption('4')
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的文件', exact: true }).click()
  await page.route('**/api/v1/uploads/*/objects/*', async route => { if (route.request().method() !== 'PUT') { await route.continue(); return }; puts++; await held; try { await route.continue() } catch { /* owner already cancelled */ } })
  await select(page, size); await expect.poll(() => puts, { timeout: 30000 }).toBe(4)
  await page.getByRole('button', { name: '锁定云盘', exact: true }).click(); await expect(page.getByRole('button', { name: '解锁云盘', exact: true })).toBeVisible()
  expect(await page.locator('body').innerText()).not.toContain('parallel.bin'); release(); await page.unrouteAll({ behavior: 'wait' }); expect(puts).toBe(4)
  const usage = await page.evaluate(async () => (await (await fetch('/api/v1/storage/usage')).json()))
  expect(usage.pendingBytes).toBe(0); expect(usage.uploadReservedBytes).toBeGreaterThan(0)
  await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
  await expect(page.getByRole('region', { name: '可恢复的上传任务' })).toContainText('parallel.bin')
  await page.getByRole('button', { name: '重新选择原文件并续传', exact: true }).click(); await select(page, size, true)
  await expect(page.getByRole('button', { name: 'parallel.bin', exact: true })).toBeVisible({ timeout: 30000 })
  const finished = await page.evaluate(async () => (await (await fetch('/api/v1/storage/usage')).json()))
  expect(finished.pendingBytes).toBe(0); expect(finished.uploadReservedBytes).toBe(0)
 } finally { release(); await server.close() }
})
