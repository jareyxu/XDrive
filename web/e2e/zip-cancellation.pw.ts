import { expect, test } from './legacy-list-test'
import { writeFileSync } from 'node:fs'
import { startIsolatedServer } from './isolated-server'

test('ZIP cancellation and file/ZIP locks stop producers while a browser sink is stalled', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  const server = await startIsolatedServer()
  try {
    await page.goto(`${server.baseURL}/setup#${server.token}`)
    await page.getByLabel('管理员用户名').fill('admin')
    await page.getByLabel('设置密码').fill('correct horse battery')
    await page.getByLabel('再次输入密码').fill('correct horse battery')
    await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
    await page.getByRole('button', { name: '创建加密云盘' }).click()
    await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
    await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'cancel-private.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(24 * 1024 * 1024, 23) })
    await expect(page.getByRole('button', { name: 'cancel-private.bin', exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('status')).toContainText('上传完成。')
    let objectReads = 0
    const evidence: unknown[] = []
    page.on('request', (request) => { if (request.method() === 'GET' && request.url().includes('/api/v1/objects/')) objectReads += 1 })
    for (const action of ['cancel', 'lock', 'file-lock'] as const) {
      const readsAtStart = objectReads
      if (action === 'file-lock') {
        await page.getByLabel('密码').fill('correct horse battery')
        await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
        await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
      }
      await page.evaluate(() => {
        const state = { writes: 0, bytes: 0, aborted: 0, closed: 0, paused: false, decrypts: 0, released: false }
        let release: (() => void) | undefined
        const target = window as Window & { zipProbe?: typeof state; releaseZipSink?: () => void }
        target.zipProbe = state
        const decrypt = crypto.subtle.decrypt.bind(crypto.subtle)
        crypto.subtle.decrypt = ((...args: Parameters<SubtleCrypto['decrypt']>) => { state.decrypts += 1; return decrypt(...args) }) as SubtleCrypto['decrypt']
        target.releaseZipSink = () => { state.released = true; release?.() }
        Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: async () => ({
          createWritable: async () => new WritableStream<Uint8Array>({
            write(bytes) {
              state.writes += 1; state.bytes += bytes.byteLength
              if (bytes.byteLength >= 64 * 1024 && !state.released) {
                state.paused = true
                return new Promise<void>((resolve) => { release = resolve })
              }
            },
            abort() { state.aborted += 1 },
            close() { state.closed += 1 },
          }),
        }) })
      })
      await page.getByRole('button', { name: action === 'file-lock' ? '下载 cancel-private.bin' : '下载为 ZIP', exact: true }).click()
      await expect.poll(() => page.evaluate(() => (window as Window & { zipProbe?: { paused: boolean } }).zipProbe?.paused)).toBe(true)
      if (action === 'cancel') {
        await page.getByRole('button', { name: '取消 ZIP 下载', exact: true }).click()
        await expect(page.getByRole('button', { name: '取消 ZIP 下载', exact: true })).toHaveCount(0, { timeout: 5000 })
        await expect(page.getByRole('status')).toContainText('ZIP 已取消。')
      } else {
        await page.getByRole('button', { name: '锁定云盘' }).click()
        await expect(page.getByRole('heading', { name: '重新解锁云盘' })).toBeVisible()
        await expect(page.getByText('cancel-private.bin', { exact: true })).toHaveCount(0)
      }
      const readCount = objectReads
      const before = await page.evaluate(() => ({ ...(window as Window & { zipProbe?: object }).zipProbe }))
      // The observation interval checks that cancellation does not resume work;
      // it deliberately leaves the external sink unresolved until after checks.
      await page.waitForTimeout(500)
      expect(objectReads).toBe(readCount)
      expect(await page.evaluate(() => ({ ...(window as Window & { zipProbe?: object }).zipProbe }))).toEqual(before)
      await page.evaluate(() => (window as Window & { releaseZipSink?: () => void }).releaseZipSink?.())
      await expect.poll(() => page.evaluate(() => (window as Window & { zipProbe?: { aborted: number } }).zipProbe?.aborted)).toBe(1)
      expect(await page.evaluate(() => (window as Window & { zipProbe?: { closed: number } }).zipProbe?.closed)).toBe(0)
      evidence.push({ action, fileBytes: 24 * 1024 * 1024, objectRequests: objectReads - readsAtStart, observationMs: 500, state: await page.evaluate(() => ({ ...(window as Window & { zipProbe?: object }).zipProbe })) })
    }
    const reportPath = testInfo.outputPath('stalled-download-cancellation.json')
    writeFileSync(reportPath, JSON.stringify({ userAgent: await page.evaluate(() => navigator.userAgent), evidence }, null, 2))
    await testInfo.attach('stalled-download-cancellation.json', { path: reportPath, contentType: 'application/json' })
  } finally { await server.close() }
})
