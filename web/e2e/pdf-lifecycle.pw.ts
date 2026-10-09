import { expect, test, selectListPreference } from './legacy-list-test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createRangePDFFixture } from './pdf-fixture'
import { startIsolatedServer } from './isolated-server'
import { testUsesHTTPS } from './tls-proxy.mjs'
import { buildSparsePDFWorker } from '../pdf-worker/worker-adapter.mjs'

for (const action of ['close', 'lock'] as const) test(`published hybrid PDF ${action} cancels an authenticated in-flight distant-page read`, async ({ browser }, testInfo) => {
  test.setTimeout(180_000)
  const root = mkdtempSync(join(tmpdir(), 'xdrive-pdf-lifecycle-'))
  const path = join(root, 'lifecycle.pdf')
  const fixture = createRangePDFFixture(path, 100, true)
  const server = await startIsolatedServer()
  const context = await browser.newContext({ baseURL: server.baseURL, ignoreHTTPSErrors: testUsesHTTPS() })
  await selectListPreference(context)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  try {
    const page = await context.newPage()
    if (action === 'lock') await page.clock.install()
    const instrument = process.env.XDRIVE_PDF_SPARSE_SPIKE === '1'
    const candidate = buildSparsePDFWorker({ instrument })
    if (instrument) await page.route('**/pdf.worker*.mjs', route => route.fulfill({ contentType: 'text/javascript', body: candidate.source }))
    await page.goto(`/setup#${server.token}`)
    await page.getByLabel('设置密码').fill('correct horse battery')
    await page.getByLabel('再次输入密码').fill('correct horse battery')
    await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
    await page.getByRole('button', { name: '创建加密云盘' }).click()
    await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
    await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles(path)
    await expect(page.getByRole('button', { name: 'lifecycle.pdf', exact: true })).toBeVisible({ timeout: 120_000 })
    const workerResponse = page.waitForResponse(response => response.url().includes('/pdf.worker') && response.status() === 200)
    await page.getByRole('button', { name: 'lifecycle.pdf', exact: true }).click()
    const canvas = page.locator('.pdf-page canvas')
    await expect(canvas).toHaveAttribute('data-rendered-page', '1', { timeout: 30_000 })
    expect(createHash('sha256').update(await (await workerResponse).body()).digest('hex')).toBe(candidate.sha256)
    await page.evaluate(() => {
      const probe = { calls: 0 }
      Object.assign(window, { pdfCancellationProbe: probe })
      const decrypt = crypto.subtle.decrypt.bind(crypto.subtle)
      crypto.subtle.decrypt = (...args) => { probe.calls += 1; return decrypt(...args) }
    })
    const held: { url: string; status: number; bytes: number; finished: boolean; failed: boolean }[] = []
    page.on('requestfailed', request => { const item = held.find(read => read.url === request.url()); if (item) item.failed = true })
    // Fetch real authenticated ciphertext, but hold its browser delivery. All
    // newly requested chunks are gated so the parser cannot race ahead through
    // a second parallel request while teardown is being verified.
    await page.route('**/api/v1/objects/*', async route => {
      if (route.request().method() !== 'GET') return route.continue()
      const item = { url: route.request().url(), status: 0, bytes: 0, finished: false, failed: false }
      held.push(item)
      try {
        const response = await route.fetch()
        item.status = response.status()
        item.bytes = Number(response.headers()['content-length'])
        await gate
        await route.fulfill({ response }).catch(() => undefined)
      } finally { item.finished = true }
    })
    await page.getByLabel('PDF 页码').fill('75')
    await page.getByRole('button', { name: '跳转', exact: true }).click()
    await expect.poll(() => held.filter(read => read.status === 200).length).toBeGreaterThan(0)
    const before = await page.evaluate(() => (window as unknown as { pdfCancellationProbe: { calls: number } }).pdfCancellationProbe.calls)
    if (action === 'close') await page.getByRole('button', { name: '关闭预览' }).click()
    else {
      // The modal correctly makes background toolbar controls inert. Exercise
      // the real idle lock instead of force-clicking an inaccessible control.
      await page.clock.fastForward(10 * 60_000 + 1000)
      await expect(page.getByRole('heading', { name: '重新解锁云盘', exact: true })).toBeVisible()
    }
    await expect(canvas).toHaveCount(0)
    await expect.poll(() => page.workers().filter(worker => worker.url().includes('pdf.worker')).length).toBe(0)
    if (action === 'lock') await expect(page.getByRole('button', { name: 'lifecycle.pdf', exact: true })).toHaveCount(0)
    release()
    await expect.poll(() => held.every(read => read.finished)).toBe(true)
    await expect.poll(() => held.every(read => read.failed)).toBe(true)
    expect(await page.evaluate(() => (window as unknown as { pdfCancellationProbe: { calls: number } }).pdfCancellationProbe.calls)).toBe(before)
    await expect(canvas).toHaveCount(0)
    await page.unroute('**/api/v1/objects/*')
    if (action === 'lock') {
      await page.getByLabel('密码', { exact: true }).fill('correct horse battery')
      await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
      await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
    }
    await page.getByRole('button', { name: 'lifecycle.pdf', exact: true }).click()
    await expect(canvas).toHaveAttribute('data-rendered-page', '1', { timeout: 30_000 })
    await page.getByLabel('PDF 页码').fill('75')
    await page.getByRole('button', { name: '跳转', exact: true }).click()
    await expect(canvas).toHaveAttribute('data-rendered-page', '75', { timeout: 30_000 })
    const pixel = await canvas.evaluate(element => [...(element as HTMLCanvasElement).getContext('2d')!.getImageData(100, 200, 1, 1).data])
    expect(pixel[2]).toBe(234)
    const report = testInfo.outputPath('pdf-lifecycle-report.json')
    writeFileSync(report, JSON.stringify({ action, fixture, browser: browser.version(), workerSha256: candidate.sha256, productionAsset: !instrument, held, decryptCallsAtStop: before, resumedPage: 75, bluePixel: pixel[2], limitations: [...(instrument ? ['Explicit instrumented worker route'] : []), 'Held authenticated response tests cancellation before ciphertext delivery, not every possible parser interleaving'] }, null, 2))
    await testInfo.attach('pdf-lifecycle-report', { path: report, contentType: 'application/json' })
  } finally {
    release()
    try { await context.close() }
    finally { try { await server.close() } finally { rmSync(root, { recursive: true, force: true }) } }
  }
})
