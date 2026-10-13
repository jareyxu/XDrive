import { test, expect } from './legacy-list-test'
import { startIsolatedServer } from './isolated-server'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import type {} from '../src/preferences/preferences'

test('two files share a bounded upload pipeline and parallel downloads retain exact bytes', async ({ page }, testInfo) => {
 test.setTimeout(90000)
 const server = await startIsolatedServer()
 const chunk = 8 * 1024 * 1024
 const buffers = [Buffer.alloc(chunk + 17, 42), Buffer.alloc(chunk + 19, 73)]
 const releases: (() => void)[] = []
 try {
  await page.addInitScript(() => { Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined }) })
  await page.goto(`${server.baseURL}/setup#${server.token}`)
  await page.getByLabel('设置密码').fill('correct horse battery')
  await page.getByLabel('再次输入密码').fill('correct horse battery')
  await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
  await page.getByRole('button', { name: '创建加密云盘' }).click()
  await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 30000 })
  await page.evaluate(() => window.xdrivePreferences.set({ uploadConcurrency: 2, downloadConcurrency: 4, downloadMemoryMiB: 128, autoTransfer: false }))
  const sessions = new Set<string>()
  let active = 0, peak = 0, puts = 0
  await page.route('**/api/v1/uploads/*/objects/*', async route => {
   const request = route.request()
   if (request.method() !== 'PUT') { await route.continue(); return }
   const size = Number(request.headers()['x-xdrive-object-size'])
   if (size < chunk) { await route.continue(); return }
   sessions.add(request.url().split('/').at(-3)!)
   peak = Math.max(peak, ++active); puts++
   if (puts <= 2) await new Promise<void>(resolve => releases.push(resolve))
   try { await route.fulfill({ response: await route.fetch() }) } finally { active-- }
  })
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles(buffers.map((buffer, index) => ({ name: `pipeline-${index}.bin`, mimeType: 'application/octet-stream', buffer })))
  await expect.poll(() => releases.length, { timeout: 30000 }).toBe(2)
  expect(sessions.size).toBe(2)
  expect(peak).toBe(2)
  releases.reverse().forEach(release => release())
  for (const index of [0, 1]) await expect(page.getByRole('button', { name: `pipeline-${index}.bin`, exact: true })).toBeVisible({ timeout: 30000 })
  await page.unrouteAll({ behavior: 'wait' })
  for (const index of [0, 1]) {
   await page.getByRole('button', { name: `更多操作 pipeline-${index}.bin`, exact: true }).click()
   const downloaded = page.waitForEvent('download')
   await page.getByRole('button', { name: `下载 pipeline-${index}.bin`, exact: true }).click()
   const stream = await (await downloaded).createReadStream()
   if (!stream) throw new Error('missing stream')
   const digest = createHash('sha256')
   for await (const bytes of stream) digest.update(bytes)
   expect(digest.digest('hex')).toBe(createHash('sha256').update(buffers[index]!).digest('hex'))
  }
  const zipDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载为 ZIP', exact: true }).click()
  const archivePath = testInfo.outputPath('pipeline.zip')
  await (await zipDownload).saveAs(archivePath)
  for (const index of [0, 1]) {
    const extracted = execFileSync('unzip', ['-p', archivePath, `pipeline-${index}.bin`], { maxBuffer: 32 * 1024 * 1024 })
    expect(createHash('sha256').update(extracted).digest('hex')).toBe(createHash('sha256').update(buffers[index]!).digest('hex'))
  }
  const usage = await page.evaluate(async () => (await (await fetch('/api/v1/storage/usage')).json()))
  expect(usage.pendingBytes).toBe(0)
  expect(usage.uploadReservedBytes).toBe(0)
 } finally { releases.forEach(release => release()); await server.close() }
})
