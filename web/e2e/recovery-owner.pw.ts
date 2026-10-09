import { expect, test } from './legacy-list-test'
import { startIsolatedServer } from './isolated-server'

const password = 'correct horse battery'
for (const stage of ['local-key', 'decrypted-record'] as const) for (const action of ['lock', 'logout'] as const) test(`local recovery ${stage} finishing after ${action} cannot begin plaintext decryption or status reads`, async ({ page }) => {
  test.setTimeout(90_000)
  const server = await startIsolatedServer()
  try {
    await page.goto(`${server.baseURL}/setup#${server.token}`)
    await page.getByLabel('\u8bbe\u7f6e\u5bc6\u7801').fill(password)
    await page.getByLabel('\u518d\u6b21\u8f93\u5165\u5bc6\u7801').fill(password)
    await page.getByLabel('\u6211\u5df2\u4e86\u89e3\uff1a\u5982\u679c\u5fd8\u8bb0\u5bc6\u7801\uff0c\u4e91\u76d8\u6570\u636e\u65e0\u6cd5\u6062\u590d\u3002').check()
    await page.getByRole('button', { name: '\u521b\u5efa\u52a0\u5bc6\u4e91\u76d8' }).click()
    await expect(page.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
    await page.route('**/api/v1/uploads/*/objects/*', route => route.fulfill({ status: 503, json: { error: 'test_interruption' } }))
    await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'private-recovery.txt', mimeType: 'text/plain', buffer: Buffer.from('real interrupted encrypted upload') })
    await expect(page.getByRole('region', { name: '\u53ef\u6062\u590d\u7684\u4e0a\u4f20\u4efb\u52a1' })).toContainText('private-recovery.txt')
    await page.unrouteAll()
    await page.getByRole('button', { name: '\u9501\u5b9a\u4e91\u76d8', exact: true }).click()
    await page.evaluate(stage => {
      const probe = { reached: false, decrypts: 0, statusReads: 0, ended: false, finished: false, plaintext: null as Uint8Array | null, release: () => {} }
      const gate = new Promise<void>(resolve => { probe.release = resolve })
      const derive = crypto.subtle.deriveKey.bind(crypto.subtle)
      let held = false
      crypto.subtle.deriveKey = async (...args: Parameters<SubtleCrypto['deriveKey']>) => {
        const key = await derive(...args)
        const params = args[0] as HkdfParams
        if (stage === 'local-key' && !held && params.name === 'HKDF' && new TextDecoder().decode(params.info as ArrayBuffer) === 'xdrive/v1/local') {
          held = true; probe.reached = true; await gate; probe.finished = true
        }
        return key
      }
      const decrypt = crypto.subtle.decrypt.bind(crypto.subtle)
      crypto.subtle.decrypt = async (...args: Parameters<SubtleCrypto['decrypt']>) => {
        if (probe.ended) probe.decrypts++
        const result = await decrypt(...args)
        if (stage === 'decrypted-record' && !held && new TextDecoder().decode(result).includes('private-recovery.txt')) {
          held = true; probe.plaintext = new Uint8Array(result); probe.reached = true; await gate; probe.finished = true
        }
        return result
      }
      const fetch = window.fetch.bind(window)
      window.fetch = (input, init) => {
        const url = input instanceof Request ? input.url : String(input)
        if (probe.ended && /\/api\/v1\/uploads\/[^/]+$/u.test(url)) probe.statusReads++
        return fetch(input, init)
      }
      Object.assign(window, { recoveryProbe: probe })
    }, stage)
    await page.getByLabel('\u5bc6\u7801', { exact: true }).fill(password)
    await page.getByRole('button', { name: '\u89e3\u9501\u4e91\u76d8', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (window as Window & { recoveryProbe: { reached: boolean } }).recoveryProbe.reached)).toBe(true)
    await page.getByRole('button', { name: action === 'lock' ? '\u9501\u5b9a\u4e91\u76d8' : '\u9000\u51fa\u767b\u5f55', exact: true }).click()
    await expect(page.getByRole('heading', { name: action === 'lock' ? '\u91cd\u65b0\u89e3\u9501\u4e91\u76d8' : '\u6b22\u8fce\u56de\u6765', exact: true })).toBeVisible()
    await page.evaluate(() => {
      const probe = (window as Window & { recoveryProbe: { ended: boolean; release: () => void } }).recoveryProbe
      probe.ended = true; probe.release()
    })
    await expect.poll(() => page.evaluate(() => (window as Window & { recoveryProbe: { finished: boolean } }).recoveryProbe.finished)).toBe(true)
    await page.waitForTimeout(200)
    if (stage === 'decrypted-record') expect(await page.evaluate(() => {
      const bytes = (window as Window & { recoveryProbe: { plaintext: Uint8Array | null } }).recoveryProbe.plaintext
      return bytes !== null && bytes.length > 0 && bytes.every(byte => byte === 0)
    })).toBe(true)
    expect(await page.evaluate(() => {
      const probe = (window as Window & { recoveryProbe: { decrypts: number; statusReads: number } }).recoveryProbe
      return { decrypts: probe.decrypts, statusReads: probe.statusReads }
    })).toEqual({ decrypts: 0, statusReads: 0 })
    await expect(page.locator('body')).not.toContainText('private-recovery.txt')
    if (action === 'logout') await page.getByLabel('\u7ba1\u7406\u5458\u7528\u6237\u540d').fill('admin')
    await page.getByLabel('\u5bc6\u7801', { exact: true }).fill(password)
    await page.getByRole('button', { name: '\u89e3\u9501\u4e91\u76d8', exact: true }).click()
    await expect(page.getByRole('region', { name: '\u53ef\u6062\u590d\u7684\u4e0a\u4f20\u4efb\u52a1' })).toContainText('private-recovery.txt')
    await expect.poll(() => page.evaluate(() => (window as Window & { recoveryProbe: { decrypts: number } }).recoveryProbe.decrypts)).toBeGreaterThan(0)
    await expect.poll(() => page.evaluate(() => (window as Window & { recoveryProbe: { statusReads: number } }).recoveryProbe.statusReads)).toBeGreaterThan(0)
  } finally {
    await page.evaluate(() => (window as Window & { recoveryProbe?: { release: () => void } }).recoveryProbe?.release()).catch(() => undefined)
    await server.close()
  }
})

test('real Vite StrictMode remount restores encrypted pending tasks after unlock', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'This separate HTTP Vite development fixture is Chromium-only; production lifecycle races run in all engines.')
  test.setTimeout(90_000)
  const server = await startIsolatedServer()
  const { createServer } = await import('vite')
  const dev = await createServer({ server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: server.baseURL, changeOrigin: false } } } })
  try {
    await dev.listen()
    const address = dev.httpServer!.address()
    if (!address || typeof address === 'string') throw new Error('Vite fixture missing loopback address')
    await page.goto(`http://127.0.0.1:${address.port}/setup#${server.token}`)
    await page.getByLabel('\u8bbe\u7f6e\u5bc6\u7801').fill(password)
    await page.getByLabel('\u518d\u6b21\u8f93\u5165\u5bc6\u7801').fill(password)
    await page.getByLabel('\u6211\u5df2\u4e86\u89e3\uff1a\u5982\u679c\u5fd8\u8bb0\u5bc6\u7801\uff0c\u4e91\u76d8\u6570\u636e\u65e0\u6cd5\u6062\u590d\u3002').check()
    await page.getByRole('button', { name: '\u521b\u5efa\u52a0\u5bc6\u4e91\u76d8' }).click()
    await expect(page.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
    await page.route('**/api/v1/uploads/*/objects/*', route => route.fulfill({ status: 503, json: { error: 'test_interruption' } }))
    await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'dev-recovery.txt', mimeType: 'text/plain', buffer: Buffer.from('real dev-mode encrypted upload') })
    const region = page.getByRole('region', { name: '\u53ef\u6062\u590d\u7684\u4e0a\u4f20\u4efb\u52a1' })
    await expect(region).toContainText('dev-recovery.txt')
    await page.unrouteAll()
    await page.getByRole('button', { name: '\u9501\u5b9a\u4e91\u76d8', exact: true }).click()
    await page.getByLabel('\u5bc6\u7801', { exact: true }).fill(password)
    await page.getByRole('button', { name: '\u89e3\u9501\u4e91\u76d8', exact: true }).click()
    await expect(page.getByRole('heading', { name: '\u6211\u7684\u6587\u4ef6', exact: true })).toBeVisible()
    await expect(region).toContainText('dev-recovery.txt')
  } finally { await dev.close(); await server.close() }
})
