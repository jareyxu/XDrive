import { expect, test } from './legacy-list-test'
import { startIsolatedServer } from './isolated-server'

test('zero-byte files commit an empty chunk manifest and round-trip in each browser engine', async ({ page }) => {
  const server = await startIsolatedServer()
  try {
    await page.addInitScript(() => {
      const target = window as Window & { xdriveManifestProbe?: unknown[] }
      target.xdriveManifestProbe = []
      const saveProbe = { bytes: 0, writes: 0, closed: false }
      Object.assign(window, { xdriveSaveProbe: saveProbe })
      Object.defineProperty(window, 'showSaveFilePicker', {
        configurable: true,
        value: async () => ({ createWritable: async () => new WritableStream<Uint8Array>({
          write(chunk) { saveProbe.bytes += chunk.byteLength; saveProbe.writes += 1 },
          close() { saveProbe.closed = true },
        }) }),
      })
      const original = SubtleCrypto.prototype.encrypt
      SubtleCrypto.prototype.encrypt = function (algorithm, key, data) {
        const bytes = data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array()
        const plaintext = new TextDecoder().decode(bytes)
        if (plaintext.includes('"chunks":[]') && plaintext.includes('"chunkSize"')) {
          try {
            const value: unknown = JSON.parse(plaintext)
            if (typeof value === 'object' && value !== null && 'version' in value && value.version === 3) target.xdriveManifestProbe?.push(value)
          } catch { /* The assertion below reports missing captured manifests. */ }
        }
        return Reflect.apply(original, this, [algorithm, key, data])
      }
    })

    await page.goto(`${server.baseURL}/setup#${server.token}`)
    await page.getByLabel('设置密码').fill('correct horse battery')
    await page.getByLabel('再次输入密码').fill('correct horse battery')
    await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
    await page.getByRole('button', { name: '创建加密云盘' }).click()
    await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })

    await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({
      name: 'empty.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(0),
    })
    await expect(page.getByRole('button', { name: 'empty.bin', exact: true })).toBeVisible({ timeout: 30_000 })
    const manifests = await page.evaluate(() => (window as Window & { xdriveManifestProbe?: unknown[] }).xdriveManifestProbe ?? [])
    expect(manifests).toHaveLength(1)
    expect(manifests[0]).toMatchObject({ version: 3, fileCryptoVersion: 2, size: 0, chunkSize: 8 * 1024 * 1024, chunkCount: 0, chunks: [], thumbnail: null })

    await page.getByRole('button', { name: '下载 empty.bin', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('文件已保存。')
    const saved = await page.evaluate(() => (window as Window & { xdriveSaveProbe?: { bytes: number; writes: number; closed: boolean } }).xdriveSaveProbe)
    expect(saved).toEqual({ bytes: 0, writes: 0, closed: true })
  } finally {
    await server.close()
  }
})
