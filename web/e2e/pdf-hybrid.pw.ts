import { expect, test } from './legacy-list-test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRangePDFFixture } from './pdf-fixture'
import { startIsolatedServer } from './isolated-server'
import { testUsesHTTPS } from './tls-proxy.mjs'
import { buildSparsePDFWorker } from '../pdf-worker/worker-adapter.mjs'

test('published hybrid worker preserves an18MiB ordinary PDF and its complete-data xref repair', async ({ browser }, testInfo) => {
  test.setTimeout(120_000)
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'xdrive-pdf-hybrid-'))
  const ordinary = join(fixtureRoot, 'ordinary.pdf')
  const repaired = join(fixtureRoot, 'repairable.pdf')
  const fixture = createRangePDFFixture(ordinary, 9, false)
  expect(fixture.size).toBeGreaterThan(10 * 1024 * 1024)
  expect(fixture.size).toBeLessThan(20 * 1024 * 1024)
  const original = readFileSync(ordinary)
  const tailBegin = original.lastIndexOf(Buffer.from('startxref\n'))
  expect(tailBegin).toBeGreaterThan(0)
  // Keep all objects/image bytes valid; only break the xref pointer to require
  // the real upstream complete-data repair path, rather than mock rendering.
  writeFileSync(repaired, Buffer.concat([original.subarray(0, tailBegin), Buffer.from('startxref\n0\n%%EOF\n')]))
  const server = await startIsolatedServer()
  const context = await browser.newContext({ baseURL: server.baseURL, ignoreHTTPSErrors: testUsesHTTPS() })
  const instrument = process.env.XDRIVE_PDF_SPARSE_SPIKE === '1'
  const candidate = buildSparsePDFWorker({ instrument })
  try {
    const page = await context.newPage()
    let workerRequests = 0
    let workerInstances = 0
    page.on('worker', worker => { if (worker.url().includes('/pdf.worker')) workerInstances += 1 })
    const warnings: string[] = []
    const sparseUsage: string[] = []
    page.on('console', message => {
      if (message.text().includes('Indexing all PDF objects')) warnings.push(message.text())
      if (message.text().startsWith('xdrive-pdf-sparse-usage:')) sparseUsage.push(message.text())
    })
    page.on('request', request => { if (request.url().includes('/pdf.worker')) workerRequests += 1 })
    if (instrument) await page.route('**/pdf.worker*.mjs', async route => {
      await route.fulfill({ contentType: 'text/javascript', body: candidate.source })
    })
    await page.goto(`/setup#${server.token}`)
    await page.getByLabel('设置密码').fill('correct horse battery')
    await page.getByLabel('再次输入密码').fill('correct horse battery')
    await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
    await page.getByRole('button', { name: '创建加密云盘' }).click()
    await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
    for (const file of [ordinary, repaired]) {
      await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles(file)
      const name = file === ordinary ? 'ordinary.pdf' : 'repairable.pdf'
      await expect(page.getByRole('button', { name, exact: true })).toBeVisible({ timeout: 30_000 })
      await page.getByRole('button', { name, exact: true }).click()
      const canvas = page.locator('.pdf-page canvas')
      await expect(canvas).toHaveAttribute('data-rendered-page', '1', { timeout: 30_000 })
      await page.getByLabel('PDF 页码').fill('9')
      await page.getByRole('button', { name: '跳转', exact: true }).click()
      await expect(canvas).toHaveAttribute('data-rendered-page', '9', { timeout: 30_000 })
      const pixel = await canvas.evaluate(element => [...(element as HTMLCanvasElement).getContext('2d')!.getImageData(100, 200, 1, 1).data])
      expect(pixel[2]).toBe(168)
      await page.getByRole('button', { name: '关闭预览' }).click()
      await expect.poll(() => page.workers().filter(worker => worker.url().includes('pdf.worker')).length).toBe(0)
    }
    expect(workerInstances).toBe(2)
    // A real published immutable asset may be served from the module cache
    // without a second network request. Both distinct Workers must still run.
    if (instrument) expect(workerRequests).toBe(2)
    else { expect(workerRequests).toBeGreaterThanOrEqual(1); expect(workerRequests).toBeLessThanOrEqual(2) }
    expect(warnings.length).toBeGreaterThan(0)
    expect(sparseUsage).toEqual([])
    await page.getByRole('button', { name: '锁定云盘' }).click()
    await expect(page.getByRole('button', { name: 'ordinary.pdf', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'repairable.pdf', exact: true })).toHaveCount(0)
    const reportPath = testInfo.outputPath('pdf-hybrid-report.json')
    writeFileSync(reportPath, JSON.stringify({ workerSha256: candidate.sha256, productionAsset: !instrument, upstreamSha256: candidate.upstreamSha256, fixture, browser: browser.version(), workerRequests, workerInstances, warnings, sparseUsage, verifiedPages: [1, 9], limitations: [...(instrument ? ['Explicit instrumented worker route'] : []), 'No whole browser RSS or true device certification', 'Large complete-data repair remains unsupported in the bounded worker'] }, null, 2))
    await testInfo.attach('pdf-hybrid-report', { path: reportPath, contentType: 'application/json' })
  } finally {
    try { await context.close() }
    finally { try { await server.close() } finally { rmSync(fixtureRoot, { recursive: true, force: true }) } }
  }
})
