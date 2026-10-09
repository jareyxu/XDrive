import { expect, test, type Download } from './legacy-list-test'
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js'
import { startIsolatedServer } from './isolated-server'
import { writeFileSync } from 'node:fs'

async function downloadedBytes(download: Download) {
  const stream = await download.createReadStream()
  if (!stream) throw new Error('download stream missing')
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  expect(await download.failure()).toBeNull()
  return Buffer.concat(chunks)
}

test('native SW attachment downloads decrypt exact files and ZIP without a Blob or key transfer', async ({ page, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'Production native relay is enabled only for validated desktop Chromium/Edge; native attachment completion remains unverified on other engines. Bounded fallback is tested separately.')
  test.setTimeout(120_000)
  const server = await startIsolatedServer()
  try {
    await page.addInitScript(() => Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined }))
    await page.goto(`${server.baseURL}/setup#${server.token}`)
    await page.getByLabel('设置密码').fill('correct horse battery')
    await page.getByLabel('再次输入密码').fill('correct horse battery')
    await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
    await page.getByRole('button', { name: '创建加密云盘' }).click()
    await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
    const source = Buffer.alloc(9 * 1024 ** 2 + 17)
    for (let index = 0; index < source.length; index += 1) source[index] = (index * 31 + 7) & 255
    for (const [name, buffer] of [['私密.bin', source], ['empty.bin', Buffer.alloc(0)]] as const) {
      await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name, mimeType: 'application/octet-stream', buffer })
      await expect(page.getByRole('button', { name, exact: true })).toBeVisible({ timeout: 30_000 })
    }
    await page.evaluate(() => {
      const probe = { blobs: [] as number[], maxWindow: 0, windows: 0, keys: false, registrations: 0 }
      Object.assign(window, { downloadProbe: probe })
      const create = URL.createObjectURL.bind(URL)
      URL.createObjectURL = (value) => { if (value instanceof Blob) probe.blobs.push(value.size); return create(value) }
      const post = ServiceWorker.prototype.postMessage
      ServiceWorker.prototype.postMessage = function (data, ...options) {
        if (data?.type === 'xdrive-download-register') {
          probe.registrations += 1
          probe.keys ||= Object.values(data).some((value) => value instanceof CryptoKey)
          if (Object.keys(data).some((key) => !['type', 'sessionId', 'length', 'filename'].includes(key))) probe.keys = true
        }
        return Reflect.apply(post, this, [data, ...options])
      }
      const portPost = MessagePort.prototype.postMessage
      MessagePort.prototype.postMessage = function (data, ...options) {
        if (data?.type === 'window' && data.bytes instanceof Uint8Array) { probe.windows += 1; probe.maxWindow = Math.max(probe.maxWindow, data.bytes.byteLength) }
        return Reflect.apply(portPost, this, [data, ...options])
      }
    })
    for (const name of ['私密.bin', 'empty.bin']) {
      const pending = page.waitForEvent('download')
      await page.getByRole('button', { name: `下载 ${name}`, exact: true }).click()
      const download = await pending
      expect(download.suggestedFilename()).toBe(name)
      if (await download.failure()) {
        await expect(page.getByRole('alert')).toBeVisible({ timeout: 5000 })
        throw new Error(await page.getByRole('alert').innerText())
      }
      expect(await downloadedBytes(download)).toEqual(name === '私密.bin' ? source : Buffer.alloc(0))
      await expect(page.getByRole('status')).toContainText('文件已传输到浏览器下载。')
    }
    const pending = page.waitForEvent('download')
    await page.getByRole('button', { name: '下载为 ZIP', exact: true }).click()
    const download = await pending
    expect(download.suggestedFilename()).toBe('XDrive.zip')
    const reader = new ZipReader(new Uint8ArrayReader(await downloadedBytes(download)))
    try {
      const entries = await reader.getEntries()
      expect(entries.map((entry) => entry.filename).sort()).toEqual(['empty.bin', '私密.bin'])
      for (const entry of entries) expect(Buffer.from(await entry.getData!(new Uint8ArrayWriter()))).toEqual(entry.filename === '私密.bin' ? source : Buffer.alloc(0))
    } finally { await reader.close() }
    await expect(page.getByRole('status')).toContainText('ZIP 已传输到浏览器下载。')
    const probe = await page.evaluate(() => (window as Window & { downloadProbe?: { blobs: number[]; maxWindow: number; windows: number; keys: boolean; registrations: number } }).downloadProbe!)
    expect(probe.blobs).toEqual([]); expect(probe.keys).toBe(false)
    expect(probe.maxWindow).toBeLessThanOrEqual(1024 ** 2)
    expect(probe.windows).toBeGreaterThan(20); expect(probe.registrations).toBe(3)
    await page.evaluate(() => {
      const state = { paused: false, decrypts: 0, window: undefined as Uint8Array | undefined, url: '' }
      Object.assign(window, { lockedDownloadProbe: state })
      const decrypt = crypto.subtle.decrypt.bind(crypto.subtle)
      crypto.subtle.decrypt = ((...args: Parameters<SubtleCrypto['decrypt']>) => { state.decrypts += 1; return decrypt(...args) }) as SubtleCrypto['decrypt']
      const post = ServiceWorker.prototype.postMessage
      ServiceWorker.prototype.postMessage = function (data, ...options) {
        if (data?.type === 'xdrive-download-register') state.url = `/__xdrive_download/${data.sessionId}`
        return Reflect.apply(post, this, [data, ...options])
      }
      const send = MessagePort.prototype.postMessage
      MessagePort.prototype.postMessage = function (data, ...options) {
        if (data?.type === 'window' && data.bytes instanceof Uint8Array && !state.paused) {
          state.window = data.bytes; state.paused = true
          return // Leave a real SW body pull awaiting the page's first window.
        }
        return Reflect.apply(send, this, [data, ...options])
      }
    })
    const stalled = page.waitForEvent('download')
    await page.getByRole('button', { name: '下载 私密.bin', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (window as Window & { lockedDownloadProbe: { paused: boolean } }).lockedDownloadProbe.paused)).toBe(true)
    const unfinished = await stalled
    await page.getByRole('button', { name: '锁定云盘', exact: true }).click()
    await expect(page.getByRole('heading', { name: '重新解锁云盘' })).toBeVisible()
    expect(await unfinished.failure()).not.toBeNull()
    const decryptCount = await page.evaluate(() => (window as Window & { lockedDownloadProbe: { decrypts: number } }).lockedDownloadProbe.decrypts)
    await page.waitForTimeout(500)
    expect(await page.evaluate(() => (window as Window & { lockedDownloadProbe: { decrypts: number } }).lockedDownloadProbe.decrypts)).toBe(decryptCount)
    expect(await page.evaluate(() => (window as Window & { lockedDownloadProbe: { window?: Uint8Array } }).lockedDownloadProbe.window?.every((byte) => byte === 0))).toBe(true)
    expect(await page.evaluate(async () => (await fetch((window as Window & { lockedDownloadProbe: { url: string } }).lockedDownloadProbe.url, { method: 'HEAD' })).status)).toBe(410)
    await expect(page.getByText('私密.bin', { exact: true })).toHaveCount(0)
    const reportPath = testInfo.outputPath('sw-download-report.json')
    writeFileSync(reportPath, JSON.stringify({ userAgent: await page.evaluate(() => navigator.userAgent), fileBytes: source.length, probe, lock: { unfinishedDownloadRejected: true, observationMs: 500, decryptCountStable: true, unsentWindowZeroed: true, tokenStatus: 410 } }, null, 2))
    await testInfo.attach('sw-download-report.json', { path: reportPath, contentType: 'application/json' })
  } finally { await server.close() }
})

test('unvalidated native-relay engines use bounded exact-byte fallback, revoke URLs and clear stale upload progress', async ({ page, browserName }, testInfo) => {
  test.skip(browserName === 'chromium', 'This checks the actual conservative non-Chromium capability policy without spoofing user agents or forcing native relay.')
  test.setTimeout(90_000)
  const server = await startIsolatedServer()
  try {
    await page.addInitScript(() => Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined }))
    await page.goto(`${server.baseURL}/setup#${server.token}`)
    await page.getByLabel('设置密码').fill('correct horse battery')
    await page.getByLabel('再次输入密码').fill('correct horse battery')
    await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
    await page.getByRole('button', { name: '创建加密云盘' }).click()
    await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 30_000 })
    const source = Buffer.alloc(9 * 1024 ** 2 + 17, 0x5a)
    for (const [name, buffer] of [['fallback.bin', source], ['zero.bin', Buffer.alloc(0)]] as const) {
      await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name, mimeType: 'application/octet-stream', buffer })
      await expect(page.getByRole('button', { name, exact: true })).toBeVisible({ timeout: 30_000 })
    }
    await page.evaluate(() => {
      const probe = { created: [] as { url: string; size: number }[], revoked: [] as string[], registrations: 0 }
      Object.assign(window, { fallbackProbe: probe })
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL)
      URL.createObjectURL = value => { const url = create(value); if (value instanceof Blob) probe.created.push({ url, size: value.size }); return url }
      URL.revokeObjectURL = url => { probe.revoked.push(url); revoke(url) }
      const post = ServiceWorker.prototype.postMessage
      ServiceWorker.prototype.postMessage = function (data, ...options) {
        if (data?.type === 'xdrive-download-register') probe.registrations += 1
        return Reflect.apply(post, this, [data, ...options])
      }
    })
    for (const [name, expected] of [['fallback.bin', source], ['zero.bin', Buffer.alloc(0)]] as const) {
      const pending = page.waitForEvent('download')
      await page.getByRole('button', { name: `下载 ${name}`, exact: true }).click()
      const download = await pending
      expect(download.suggestedFilename()).toBe(name)
      expect(await downloadedBytes(download)).toEqual(expected)
      await expect(page.getByRole('status')).toHaveText('下载已开始。')
    }
    const pending = page.waitForEvent('download')
    await page.getByRole('button', { name: '下载为 ZIP', exact: true }).click()
    const archive = await pending
    expect(archive.suggestedFilename()).toBe('XDrive.zip')
    const reader = new ZipReader(new Uint8ArrayReader(await downloadedBytes(archive)))
    try {
      const entries = await reader.getEntries()
      expect(entries.map(entry => entry.filename).sort()).toEqual(['fallback.bin', 'zero.bin'])
      for (const entry of entries) expect(Buffer.from(await entry.getData!(new Uint8ArrayWriter()))).toEqual(entry.filename === 'fallback.bin' ? source : Buffer.alloc(0))
    } finally { await reader.close() }
    await expect(page.getByRole('status')).toContainText('ZIP 文件已保存。')
    await expect.poll(() => page.evaluate(() => {
      const probe = (window as Window & { fallbackProbe: { created: { url: string; size: number }[]; revoked: string[] } }).fallbackProbe
      return probe.created.every(item => probe.revoked.includes(item.url))
    })).toBe(true)
    const probe = await page.evaluate(() => (window as Window & { fallbackProbe: { created: { url: string; size: number }[]; revoked: string[]; registrations: number } }).fallbackProbe)
    expect(probe.registrations).toBe(0)
    expect(probe.created).toHaveLength(3)
    expect(probe.created.map(item => item.size).slice(0, 2)).toEqual([source.length, 0])
    expect(probe.created.every(item => item.size <= 512 * 1024 ** 2)).toBe(true)
    await testInfo.attach('bounded-fallback', { body: JSON.stringify({ browserName, bytes: source.length, zeroBytes: true, zipExact: true, staleUploadProgressCleared: true, probe, nativeRelayVerified: false }, null, 2), contentType: 'application/json' })
  } finally { await server.close() }
})
