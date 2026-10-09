import { testUsesHTTPS } from './tls-proxy.mjs'
import { selectListPreference } from './legacy-list-test'
import { expect, test } from './legacy-list-test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, platform, arch } from 'node:os'
import { join } from 'node:path'
import { createRangePDFFixture } from './pdf-fixture'
import { startIsolatedServer } from './isolated-server'
import { loadMediaResourceTarget, unlockMediaResourceTarget } from './media-resource-target'
import { buildSparsePDFWorker } from '../pdf-worker/worker-adapter.mjs'
import { createWorkerHeapProbe, type WorkerHeapSample } from './worker-heap-probe'

const fixturePages = Number(process.env.XDRIVE_PDF_SCALE_PAGES ?? '100')
if (![100, 256, 512].includes(fixturePages)) throw new Error('PDF scale fixture must use100,256 or512 pages')
const fixtureLabel = fixturePages === 100 ? '200 MiB' : fixturePages === 256 ? '512 MiB' : '1 GiB'
const usesMediaResourceTarget = Boolean(process.env.XDRIVE_MEDIA_RESOURCE_STATE_PATH)
test.use({
  // Chromium honors Playwright's ignoreHTTPSErrors for page/API requests, but
  // still rejects a Service Worker script fetched from the validation guest's
  // self-signed Caddy endpoint. Only the explicit isolated target gets this
  // test-only switch; production browser behavior is unchanged.
  launchOptions: { args: usesMediaResourceTarget ? ['--ignore-certificate-errors'] : [] },
})

for (const layout of ['compact', 'distributed'] as const) test(`a ${fixtureLabel} non-linearized PDF with ${layout} metadata renders distant pages through authenticated ranges`, async ({ browser, browserName, page: fixturePage }, testInfo) => {
  const resourceTarget = loadMediaResourceTarget()
  test.setTimeout(resourceTarget ? 15 * 60_000 : 180_000)
  const heapMeasurement = process.env.XDRIVE_PDF_HEAP_PROBE === '1'
  const collectHeap = process.env.XDRIVE_PDF_HEAP_GC !== '0'
  if (heapMeasurement && browserName !== 'chromium') throw new Error('Worker heap measurement requires actual Chromium CDP')
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'xdrive-pdf-range-'))
  const fixtureName = `large-range-${layout}.pdf`
  const fixturePath = join(fixtureRoot, fixtureName)
  const fixture = createRangePDFFixture(fixturePath, fixturePages, layout === 'compact')
  expect(fixture.size).toBeGreaterThan((fixturePages === 100 ? 200 : fixturePages === 256 ? 512 : 1024) * 1024 * 1024)
  // More pages necessarily add xref records; keep the original16KiB tail
  // constraint for100 pages and account for actual larger xref tables.
  const xrefTailLimit = Math.max(16_384, (fixturePages * 3 + 4) * 20 + 2048)
  expect(fixture.xrefOffset).toBeGreaterThan(fixture.size - xrefTailLimit)
  const server = resourceTarget ? undefined : await startIsolatedServer()
  const context = resourceTarget ? fixturePage.context() : await browser.newContext({ ignoreHTTPSErrors: testUsesHTTPS(), baseURL: server!.baseURL })
  if (!resourceTarget) await selectListPreference(context)
  let page: import('@playwright/test').Page | undefined
  let heapProbe: Awaited<ReturnType<typeof createWorkerHeapProbe>> | undefined
  const heapSamples: { page: number; collected: boolean; heap: WorkerHeapSample }[] = []
  const sampleHeap = async (page: number) => {
    if (!heapProbe) return
    heapSamples.push({ page, collected: false, heap: await heapProbe.sample() })
    if (collectHeap) heapSamples.push({ page, collected: true, heap: await heapProbe.sample(true) })
  }
  try {
    page = resourceTarget ? fixturePage : await context.newPage()
    const sparseCandidate = process.env.XDRIVE_PDF_SPARSE_SPIKE === '1' ? buildSparsePDFWorker({ instrument: true }) : null
    const sparseUsage: { residentBytes: number; residentChunks: number; evictedChunks: number }[] = []
    let sparseWorkerRequests = 0
    if (sparseCandidate) {
      await page.route('**/pdf.worker*.mjs', async route => {
        sparseWorkerRequests += 1
        await route.fulfill({ contentType: 'text/javascript', body: sparseCandidate.source })
      })
      page.on('console', message => {
        if (message.text().startsWith('xdrive-pdf-sparse-usage:')) sparseUsage.push(JSON.parse(message.text().slice('xdrive-pdf-sparse-usage:'.length)))
      })
    }
    await page.addInitScript(() => { Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined }) })
    const repairWarnings: string[] = []
    page.on('console', (message) => { if (message.text().includes('Indexing all PDF objects')) repairWarnings.push(message.text()) })
    if (resourceTarget) {
      await unlockMediaResourceTarget(page, resourceTarget)
    } else {
      await page.goto(`/setup#${server!.token}`)
      await page.getByLabel('设置密码').fill('correct horse battery')
      await page.getByLabel('再次输入密码').fill('correct horse battery')
      await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
      await page.getByRole('button', { name: '创建加密云盘' }).click()
      await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
    }
    const uploadedSizes = new Map<string, number>()
    page.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().includes('/objects/')) uploadedSizes.set(request.url().split('/').at(-1)!, Number(request.headers()['x-xdrive-object-size']))
    })
    const uploadStarted = Date.now()
    const fileEntry = page.getByRole('button', { name: fixtureName, exact: true })
    const reuseExisting = resourceTarget !== undefined && process.env.XDRIVE_MEDIA_RESOURCE_REUSE_PDFS === '1' && await fileEntry.count() > 0
    if (!reuseExisting) await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles(fixturePath)
    await expect(fileEntry).toBeVisible({ timeout: resourceTarget ? 10 * 60_000 : 120_000 })
    const uploadMs = reuseExisting ? null : Date.now() - uploadStarted
    const fetched: { objectId: string; bytes: number }[] = []
    page.on('response', (response) => {
      if (response.request().method() === 'GET' && response.url().includes('/api/v1/objects/')) {
        const objectId = response.url().split('/').at(-1)!
        const bytes = Number(response.headers()['content-length'])
        uploadedSizes.set(objectId, bytes)
        fetched.push({ objectId, bytes })
      }
    })
    await page.evaluate(() => {
      const probe = { blobs: [] as number[], maxDecryptedBytes: 0 }
      Object.assign(window, { pdfRangeProbe: probe })
      const create = URL.createObjectURL.bind(URL)
      URL.createObjectURL = (blob) => { if (blob instanceof Blob) probe.blobs.push(blob.size); return create(blob) }
      const decrypt = crypto.subtle.decrypt.bind(crypto.subtle)
      crypto.subtle.decrypt = async (...args) => { const bytes = await decrypt(...args); probe.maxDecryptedBytes = Math.max(probe.maxDecryptedBytes, bytes.byteLength); return bytes }
    })
    const canvas = page.locator('.pdf-page canvas')
    const samples: { page: number; renderMs: number; fetchedBytes: number }[] = []
    let started = Date.now()
    await fileEntry.click()
    await expect(canvas).toHaveAttribute('data-rendered-page', '1', { timeout: 30_000 })
    if (heapMeasurement) {
      const worker = page.workers().find(worker => worker.url().includes('pdf.worker'))
      if (!worker) throw new Error('Owned PDF worker is absent')
      heapProbe = await createWorkerHeapProbe(browser, worker.url())
      await sampleHeap(1)
    }
    samples.push({ page: 1, renderMs: Date.now() - started, fetchedBytes: fetched.reduce((sum, read) => sum + read.bytes, 0) })
    await saveCanvas(page, testInfo.outputPath('large-pdf-page-1.png'))
    for (const target of [75, 25, 100, 1]) {
      started = Date.now()
      await page.getByLabel('PDF 页码').fill(String(target))
      await page.getByRole('button', { name: '跳转', exact: true }).click()
      await expect(canvas).toHaveAttribute('data-rendered-page', String(target), { timeout: 30_000 })
      // Verify the distinct rendered image, rather than just a page counter.
      const pixel = await canvas.evaluate((element) => [...(element as HTMLCanvasElement).getContext('2d')!.getImageData(100, 200, 1, 1).data])
      expect(pixel[2]).toBe(160 + (target - 1) % 80)
      samples.push({ page: target, renderMs: Date.now() - started, fetchedBytes: fetched.reduce((sum, read) => sum + read.bytes, 0) })
      if (target === 100) await saveCanvas(page, testInfo.outputPath('large-pdf-page-100.png'))
    }
    const probe = await page.evaluate(() => (window as unknown as { pdfRangeProbe: { blobs: number[]; maxDecryptedBytes: number } }).pdfRangeProbe)
    expect(repairWarnings).toEqual([])
    expect(probe.blobs.every((size) => size < 64 * 1024 * 1024)).toBe(true)
    expect(probe.maxDecryptedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
    if (sparseCandidate) {
      expect(sparseWorkerRequests).toBe(1)
      expect(sparseUsage.length).toBeGreaterThan(0)
      expect(Math.max(...sparseUsage.map(sample => sample.residentBytes))).toBeLessThanOrEqual(32 * 1024 * 1024)
    }
    expect(fetched.reduce((sum, read) => sum + read.bytes, 0)).toBeLessThan(layout === 'compact' ? fixture.size / 2 : fixture.size * 2)
    // Distributed page dictionaries may legitimately touch every encrypted
    // data chunk. The original100-page bound is27 (26 actual file chunks+1);
    // derive that same fixture invariant for larger files, rather than treating
    // its sample-specific number as a constant network limit for all PDFs.
    const dataObjectBound = layout === 'compact' ? 12 : Math.ceil(fixture.size / (8 * 1024 * 1024)) + 1
    expect(new Set(fetched.filter((read) => (uploadedSizes.get(read.objectId) ?? 0) > 1024 * 1024).map((read) => read.objectId)).size).toBeLessThan(dataObjectBound)
    const originalPhaseFetchedBytes = fetched.reduce((sum, read) => sum + read.bytes, 0)
    const scaleSeekSamples: { page: number; renderMs: number }[] = []
    if (fixturePages > 100) {
      for (const target of [Math.ceil(fixturePages * 0.75), Math.ceil(fixturePages * 0.25), fixturePages, 1]) {
        const seekStarted = Date.now()
        await page.getByLabel('PDF 页码').fill(String(target))
        await page.getByRole('button', { name: '跳转', exact: true }).click()
        await expect(canvas).toHaveAttribute('data-rendered-page', String(target), { timeout: 30_000 })
        const pixel = await canvas.evaluate(element => [...(element as HTMLCanvasElement).getContext('2d')!.getImageData(100, 200, 1, 1).data])
        expect(pixel[2]).toBe(160 + (target - 1) % 80)
        scaleSeekSamples.push({ page: target, renderMs: Date.now() - seekStarted })
        await sampleHeap(target)
      }
    }
    if (!sparseCandidate) await sampleHeap(1)
    const sparseSeekSamples: { page: number; renderMs: number }[] = []
    if (sparseCandidate) {
      // Keep the original five-page bandwidth assertions above, then exceed
      // the resident budget and revisit a page whose source was evicted.
      const count = process.env.XDRIVE_PDF_HEAP_SWEEP === '1' ? 99 : 21
      for (const target of [...Array.from({ length: count }, (_, index) => index + 2), 1]) {
        const seekStarted = Date.now()
        await page.getByLabel('PDF 页码').fill(String(target))
        await page.getByRole('button', { name: '跳转', exact: true }).click()
        await expect(canvas).toHaveAttribute('data-rendered-page', String(target), { timeout: 30_000 })
        const pixel = await canvas.evaluate(element => [...(element as HTMLCanvasElement).getContext('2d')!.getImageData(100, 200, 1, 1).data])
        expect(pixel[2]).toBe(160 + (target - 1) % 80)
        sparseSeekSamples.push({ page: target, renderMs: Date.now() - seekStarted })
        if (heapProbe && (target % 5 === 0 || target === 1)) {
          await sampleHeap(target)
        }
      }
      expect(Math.max(...sparseUsage.map(sample => sample.residentBytes))).toBeLessThanOrEqual(32 * 1024 * 1024)
      expect(Math.max(...sparseUsage.map(sample => sample.evictedChunks))).toBeGreaterThan(0)
    }
    await page.getByLabel('PDF 页码').fill(String(fixturePages + 1))
    await page.getByLabel('PDF 页码').press('Enter')
    await expect(page.getByLabel('PDF 页码')).toHaveValue('1')
    const pdfWorkerCount = async () => page.workers().filter((worker) => worker.url().includes('pdf.worker')).length
    expect(await pdfWorkerCount()).toBe(1)
    await heapProbe?.close()
    heapProbe = undefined
    await page.getByRole('button', { name: '关闭预览' }).click()
    await expect(canvas).toHaveCount(0)
    await expect.poll(pdfWorkerCount).toBe(0)
    const report = { date: new Date().toISOString(), platform: platform(), arch: arch(), browser: browser.version(), resourceTarget: resourceTarget ? { environment: 'isolated Linux VPS validation guest', guestOS: 'Debian 12 amd64', guestVCPU: 1, guestMemoryMiB: 1024, guestDiskGiB: 25, browserRunsOnGuest: false } : null, fixture, layout, uploadMs, samples, fetched, originalPhaseFetchedBytes, dataObjectBound, scaleSeekSamples, probe, workerClosed: true, heapSamples,
      uploadReused: reuseExisting, sparseCandidate: sparseCandidate ? { sha256: sparseCandidate.sha256, upstreamSha256: sparseCandidate.upstreamSha256, workerRequests: sparseWorkerRequests, usage: sparseUsage, seekSamples: sparseSeekSamples } : null,
      limitations: ['Single desktop engine per run; not Safari/iOS/Android device certification', 'No whole-browser RSS or 1C1G measurement', 'Hybrid Worker source storage is bounded; total decoded/parser/object memory remains unproven', 'Generated uncompressed-image PDF; other layouts remain required'] }
    const reportPath = testInfo.outputPath('large-pdf-report.json')
    writeFileSync(reportPath, JSON.stringify(report, null, 2))
    await testInfo.attach('large-pdf-report', { path: reportPath, contentType: 'application/json' })
    if (layout === 'compact') {
      const damaged = Buffer.from('%PDF-1.7\nThis document is deliberately missing its object tree and xref.\n')
      await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'damaged.pdf', mimeType: 'application/pdf', buffer: damaged })
      await expect(page.getByRole('button', { name: 'damaged.pdf', exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'damaged.pdf', exact: true }).click()
      await expect(page.getByRole('alert')).toContainText('PDF 无法打开')
      await expect.poll(pdfWorkerCount).toBe(0)
      const downloaded = page.waitForEvent('download', { timeout: 30_000 })
      await page.getByRole('button', { name: '下载原文件', exact: true }).click()
      const path = await (await downloaded).path()
      expect(path).not.toBeNull()
      expect(readFileSync(path!)).toEqual(damaged)
      await page.getByRole('button', { name: '关闭预览' }).click()
    }
    await page.getByRole('button', { name: '锁定云盘' }).click()
    await expect(page.getByRole('button', { name: fixtureName, exact: true })).toHaveCount(0)
  } finally {
    try { await heapProbe?.close() }
    finally {
      try { if (page && !page.isClosed()) await page.close({ runBeforeUnload: false }) }
      finally {
        try { if (!resourceTarget) await context.close() }
        finally { try { await server?.close() } finally { rmSync(fixtureRoot, { recursive: true, force: true }) } }
      }
    }
  }
})

async function saveCanvas(page: import('@playwright/test').Page, path: string) {
  const png = await page.locator('.pdf-page canvas').evaluate((element) => (element as HTMLCanvasElement).toDataURL('image/png'))
  writeFileSync(path, Buffer.from(png.split(',')[1]!, 'base64'))
}
