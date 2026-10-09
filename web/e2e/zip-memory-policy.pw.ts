import { expect, test } from '@playwright/test'
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js'
import { startIsolatedServer } from './isolated-server'

test('ZIP memory policy includes structure, fails closed before file reads and does not constrain streaming output', async ({ page }) => {
  test.setTimeout(120_000)
  const source = Buffer.from('original archive data')
  const budget = 128 + 256 + 2 * Buffer.byteLength('a.txt') + source.length
  const server = await startIsolatedServer({ zipMemoryFallbackLimit: budget })
  try {
    await page.addInitScript(() => {
      Reflect.deleteProperty(Navigator.prototype, 'serviceWorker')
      Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined })
    })
    await page.goto(`${server.baseURL}/setup#${server.token}`)
    await page.getByLabel('设置密码').fill('correct horse battery')
    await page.getByLabel('再次输入密码').fill('correct horse battery')
    await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
    await page.getByRole('button', { name: '创建加密云盘' }).click()
    await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 30_000 })
    await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'a.txt', mimeType: 'text/plain', buffer: source })
    await expect(page.getByRole('button', { name: 'a.txt', exact: true })).toBeVisible()
    const pending = page.waitForEvent('download')
    await page.getByRole('button', { name: '下载为 ZIP', exact: true }).click()
    const stream = await (await pending).createReadStream()
    if (!stream) throw new Error('Missing archive')
    const parts: Buffer[] = []
    for await (const part of stream) parts.push(Buffer.from(part))
    const archive = Buffer.concat(parts)
    expect(archive.length).toBeLessThanOrEqual(budget)
    const zip = new ZipReader(new Uint8ArrayReader(archive))
    try {
      const entries = await zip.getEntries()
      expect(entries.map(entry => entry.filename)).toEqual(['a.txt'])
      expect(Buffer.from(await entries[0].getData!(new Uint8ArrayWriter()))).toEqual(source)
    } finally { await zip.close() }
    const indexObjects = new Set<string>()
    await page.route('**/api/v1/metadata/*', async route => {
      const response = await route.fetch()
      indexObjects.add((await response.json()).objectId)
      await route.fulfill({ response })
    })
    let objectReads = 0, downloads = 0
    page.on('request', request => {
      const id = request.url().match(/\/api\/v1\/objects\/([^/?]+)/u)?.[1]
      if (request.method() === 'GET' && id && !indexObjects.has(id)) objectReads++
    })
    page.on('download', () => { downloads++ })
    for (const policy of [budget - 1, undefined, 0, -1, 1.5, 536870913, '512']) {
      await page.route('**/api/v1/system/info', route => route.fulfill({ status: 200, json: { zipMemoryFallbackLimit: policy } }))
      objectReads = 0
      await page.getByRole('button', { name: '下载为 ZIP', exact: true }).click()
      await expect(page.getByRole('alert').first()).toContainText(policy === budget - 1 ? `${budget - 1} bytes` : '无法读取有效的 ZIP 内存上限')
      expect(objectReads).toBe(0)
      expect(downloads).toBe(0)
      await page.unroute('**/api/v1/system/info')
    }
    await page.route('**/api/v1/system/info', route => route.fulfill({ status: 503, json: { error: 'unavailable' } }))
    objectReads = 0
    await page.getByRole('button', { name: '下载为 ZIP', exact: true }).click()
    await expect(page.getByRole('alert').first()).not.toContainText('无法读取有效的 ZIP 内存上限')
    expect(objectReads).toBe(0)
    expect(downloads).toBe(0)
    let streamingPolicyReads = 0
    page.on('request', request => { if (request.url().endsWith('/api/v1/system/info')) streamingPolicyReads++ })
    // A real Web Streams writer exercises the application streaming path, with policy still unavailable.
    await page.evaluate(() => {
      const state = window as Window & { streamed?: number[]; streamClosed?: boolean }
      state.streamed = []
      Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: async () => ({ createWritable: async () => new WritableStream<Uint8Array>({
        write(bytes) { state.streamed!.push(...bytes) }, close() { state.streamClosed = true },
      }) }) })
    })
    await page.getByRole('button', { name: '下载为 ZIP', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (window as Window & { streamClosed?: boolean }).streamClosed)).toBe(true)
    expect(streamingPolicyReads).toBe(0)
    const streamed = await page.evaluate(() => (window as Window & { streamed?: number[] }).streamed!)
    const streamedZip = new ZipReader(new Uint8ArrayReader(new Uint8Array(streamed)))
    try { expect(Buffer.from(await (await streamedZip.getEntries())[0].getData!(new Uint8ArrayWriter()))).toEqual(source) }
    finally { await streamedZip.close() }
  } finally { await server.close() }
})
