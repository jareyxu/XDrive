import { selectListPreference } from './legacy-list-test'
import { expect, test, type BrowserContext } from './legacy-list-test'
import { createHash } from 'node:crypto'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir, platform, arch } from 'node:os'
import { join } from 'node:path'
import { startIsolatedServer } from './isolated-server'
import { testUsesHTTPS } from './tls-proxy.mjs'

test.use({ trace: 'off' })

for (const output of ['OPFS', 'Service Worker'] as const) {
  test(`a real encrypted file larger than 4 GiB exports ZIP64 via ${output} with independent streaming hash verification`, async ({ playwright, browserName }, testInfo) => {
    test.skip(process.env.XDRIVE_LARGE_E2E !== '1', 'Opt-in release gate: creates >12 GiB of temporary data.')
    test.skip(output === 'Service Worker' && browserName !== 'chromium', 'The Service Worker download relay is enabled only on the validated desktop Chromium/Edge path; other engines use the bounded fallback.')
    test.setTimeout(20 * 60_000)
    const temporary = mkdtempSync(join(tmpdir(), 'xdrive-zip64-'))
    const profile = join(temporary, 'profile')
    const input = join(temporary, 'large.bin')
    const fileBytes = 4 * 1024 ** 3 + 1024 ** 2 + 17
    const fixtureDigest = createHash('sha256')
    const block = Buffer.alloc(8 * 1024 ** 2)
    for (let index = 0; index < block.length; index += 1) block[index] = (index * 73 + 19) & 255
    let server: Awaited<ReturnType<typeof startIsolatedServer>> | undefined
    let context: BrowserContext | undefined
    try {
      const fd = openSync(input, 'wx')
      try {
        for (let offset = 0; offset < fileBytes; offset += block.length) {
          block.writeBigUInt64LE(BigInt(offset / block.length))
          const bytes = block.subarray(0, Math.min(block.length, fileBytes - offset))
          let written = 0
          while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written)
          fixtureDigest.update(bytes)
        }
      } finally { closeSync(fd) }
      const sha256 = fixtureDigest.digest('hex')
      server = await startIsolatedServer()
      context = await playwright[browserName].launchPersistentContext(profile, { headless: true, baseURL: server.baseURL, ignoreHTTPSErrors: testUsesHTTPS(), acceptDownloads: true, downloadsPath: join(temporary, 'downloads') })
      await selectListPreference(context)
      const page = context.pages()[0] ?? await context.newPage()
      await page.goto(`/setup#${server.token}`)
      await page.getByLabel('设置密码').fill('correct horse battery')
      await page.getByLabel('再次输入密码').fill('correct horse battery')
      await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
      await page.getByRole('button', { name: '创建加密云盘' }).click()
      await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
      let completedPuts = 0
      page.on('requestfinished', (request) => {
        if (request.method() === 'PUT' && request.url().includes('/objects/')) {
          completedPuts += 1
          if (completedPuts % 64 === 0) console.log(`ZIP64 fixture upload: ${completedPuts} encrypted objects persisted`)
        }
      })
      const uploadStarted = Date.now()
      await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles(input)
      await expect(page.getByRole('button', { name: 'large.bin', exact: true })).toBeVisible({ timeout: 12 * 60_000 })
      const uploadMs = Date.now() - uploadStarted
      console.log(`ZIP64 fixture upload finished in ${uploadMs} ms`)
      await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: '尾部.txt', mimeType: 'text/plain', buffer: Buffer.from('ZIP64 tail content') })
      await expect(page.getByRole('button', { name: '尾部.txt', exact: true })).toBeVisible()
      page.once('dialog', (dialog) => void dialog.accept('empty'))
      await page.getByRole('button', { name: '新建文件夹' }).click()
      await expect(page.getByRole('button', { name: 'empty', exact: true })).toBeVisible()
      const memoryLimit = await page.evaluate(async () => {
        const response = await fetch('/api/v1/system/info')
        if (!response.ok) throw new Error('ZIP fallback policy unavailable')
        return (await response.json()).zipMemoryFallbackLimit as number
      })
      expect(memoryLimit).toBe(512 * 1024 ** 2)
      const originalUserAgent = await page.evaluate(() => navigator.userAgent)
      await page.evaluate(() => {
        Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined })
        Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'XDrive unverified test browser' })
      })
      await page.getByRole('button', { name: '下载为 ZIP', exact: true }).click()
      await expect(page.getByRole('alert')).toContainText(`ZIP 预计超过 ${memoryLimit.toLocaleString('zh-CN')} bytes 内存上限`, { timeout: 30_000 })
      await page.evaluate((userAgent) => Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent }), originalUserAgent)
      await page.evaluate((output) => {
        const probe = { outputBytes: 0, maxWriteBytes: 0, writes: 0, closes: 0, aborts: 0, keysTransferred: false, blobs: [] as number[] }
        Object.assign(window, { largeZipProbe: probe })
        const create = URL.createObjectURL.bind(URL)
        URL.createObjectURL = (blob) => { if (blob instanceof Blob) probe.blobs.push(blob.size); return create(blob) }
        if (output === 'Service Worker') {
          const post = MessagePort.prototype.postMessage
          MessagePort.prototype.postMessage = function (message: unknown, transfer: Transferable[] = []) {
            const data = message as { type?: string; bytes?: Uint8Array; done?: boolean }
            if (data?.type === 'window' && data.bytes instanceof Uint8Array) {
              probe.writes += 1; probe.outputBytes += data.bytes.byteLength; probe.maxWriteBytes = Math.max(probe.maxWriteBytes, data.bytes.byteLength)
            }
            if (data?.type === 'window' && data.done) probe.closes += 1
            if (message instanceof CryptoKey || Object.values(message ?? {}).some((value) => value instanceof CryptoKey)) probe.keysTransferred = true
            return post.call(this, message, transfer)
          }
          return
        }
        Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: async () => {
          // Actual native File System Access writable, in origin-private storage.
          // Only picker selection is substituted; archive bytes never cross CDP.
          const root = await navigator.storage.getDirectory()
          const handle = await root.getFileHandle('verified.zip', { create: true })
          return { createWritable: async () => {
            const native = await handle.createWritable()
            const writer = native.getWriter()
            return new WritableStream<Uint8Array>({
              async write(bytes) { probe.writes += 1; probe.outputBytes += bytes.byteLength; probe.maxWriteBytes = Math.max(probe.maxWriteBytes, bytes.byteLength); await writer.write(bytes) },
              async close() { await writer.close(); writer.releaseLock(); probe.closes += 1 },
              async abort(reason) { await writer.abort(reason); writer.releaseLock(); probe.aborts += 1 },
            })
          } }
        } })
      }, output)
      const exportStarted = Date.now()
      const downloadPromise = output === 'Service Worker' ? page.waitForEvent('download', { timeout: 12 * 60_000 }) : undefined
      await page.getByRole('button', { name: '下载为 ZIP', exact: true }).click()
      const download = await downloadPromise
      if (download) expect(await download.failure()).toBeNull()
      await expect(page.getByRole('status')).toContainText(output === 'OPFS' ? 'ZIP 文件已保存。' : 'ZIP 已传输到浏览器下载。', { timeout: 12 * 60_000 })
      const exportMs = Date.now() - exportStarted
      console.log(`ZIP64 native-stream export finished in ${exportMs} ms`)
      const probe = await page.evaluate(() => (window as Window & { largeZipProbe?: { outputBytes: number; maxWriteBytes: number; closes: number; aborts: number; keysTransferred: boolean; blobs: number[] } }).largeZipProbe!)
      expect(probe.outputBytes).toBeGreaterThan(0xFFFFFFFF)
      expect(probe.maxWriteBytes).toBeLessThanOrEqual((output === 'OPFS' ? 8 : 1) * 1024 ** 2)
      expect(probe.closes).toBe(1); expect(probe.aborts).toBe(0); expect(probe.blobs).toEqual([]); expect(probe.keysTransferred).toBe(false)
      const userAgent = await page.evaluate(() => navigator.userAgent)
      let archivePath: string
      let verificationCopy: { method: string; fileBytes: number; milliseconds: number } | undefined
      if (download) {
        // Playwright exposes the native download's disk path; no archive bytes
        // are sent through CDP or aggregated in this Node/browser process.
        archivePath = (await download.path())!
        expect(statSync(archivePath).size).toBe(probe.outputBytes)
      } else {
        // Inspect via public APIs, never assume private browser backing layouts.
        // The native File is disk-backed: no full arrayBuffer, new Blob or CDP
        // archive payload. This verification copy happens after product probes.
        const copyingStarted = Date.now()
        const copied = page.waitForEvent('download', { timeout: 120_000 })
        const fileBytes = await page.evaluate(async () => {
          const root = await navigator.storage.getDirectory()
          const file = await (await root.getFileHandle('verified.zip')).getFile()
          if (!(file instanceof File)) throw new TypeError('OPFS archive is not a File')
          const url = URL.createObjectURL(file)
          Object.assign(window, { zip64VerificationFileURL: url })
          const link = document.createElement('a')
          link.href = url; link.download = 'verified.zip'
          document.body.append(link); link.click(); link.remove()
          return file.size
        })
        expect(fileBytes).toBe(probe.outputBytes)
        const inspectionDownload = await copied
        expect(await inspectionDownload.failure()).toBeNull()
        archivePath = (await inspectionDownload.path())!
        expect(statSync(archivePath).size).toBe(probe.outputBytes)
        await page.evaluate(() => {
          const target = window as Window & { zip64VerificationFileURL?: string }
          URL.revokeObjectURL(target.zip64VerificationFileURL!)
          delete target.zip64VerificationFileURL
        })
        verificationCopy = { method: 'Public OPFS getFile -> File URL -> native download', fileBytes, milliseconds: Date.now() - copyingStarted }
      }
      const expectedPath = join(temporary, 'expected.json')
      writeFileSync(expectedPath, JSON.stringify({
        'large.bin': { bytes: fileBytes, sha256 },
        '尾部.txt': { bytes: Buffer.byteLength('ZIP64 tail content'), sha256: createHash('sha256').update('ZIP64 tail content').digest('hex') },
        'empty/': { bytes: 0, sha256: createHash('sha256').digest('hex') },
      }))
      const verified = JSON.parse(execFileSync('python3', [join(import.meta.dirname, '../../scripts/verify-zip64.py'), archivePath, expectedPath], { encoding: 'utf8', timeout: 120_000 }))
      const reportPath = testInfo.outputPath(output === 'OPFS' ? 'large-zip-report.json' : 'large-sw-zip-report.json')
      writeFileSync(reportPath, JSON.stringify({ output, platform: platform(), arch: arch(), userAgent, fileBytes, uploadMs, exportMs, probe, verificationCopy, verified }, null, 2))
      await testInfo.attach(output === 'OPFS' ? 'large-zip-report.json' : 'large-sw-zip-report.json', { path: reportPath, contentType: 'application/json' })
      expect(readFileSync(reportPath).length).toBeLessThan(16_384)
    } finally {
      try { await context?.close() } finally {
        try { await server?.close() } finally { rmSync(temporary, { recursive: true, force: true }) }
      }
    }
  })
}
