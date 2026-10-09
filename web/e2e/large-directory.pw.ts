import { writeFileSync } from 'node:fs'
import { expect, test, type Page } from './legacy-list-test'
import { startIsolatedServer } from './isolated-server'
import { EncryptedDirectoryFixture } from './encrypted-directory-fixture'
import type { BrowserContext } from '@playwright/test'

test('1000/5000 real encrypted directory entries have bounded DOM, keyboard reachability and capacity rejection', async ({ page, context, browserName }, testInfo) => {
  test.skip(process.env.XDRIVE_DIRECTORY_E2E !== '1', 'S6 real 5000-object fixture is an explicit milestone run: XDRIVE_DIRECTORY_E2E=1')
  test.setTimeout(600_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  const server = await startIsolatedServer()
  const password = 'correct horse battery'
  const measurements: unknown[] = []
  const rendererHeapSamples: unknown[] = []
  try {
    await page.goto(`${server.baseURL}/setup#${server.token}`)
    await page.getByLabel('设置密码').fill(password)
    await page.getByLabel('再次输入密码').fill(password)
    await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
    await page.getByRole('button', { name: '创建加密云盘' }).click()
    await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
    const cookie = (await context.cookies()).find((item) => item.name === 'xdrive_session' && item.domain === new URL(server.baseURL).hostname)
    if (!cookie) throw new Error('fixture browser session cookie missing')
    const fixture = await EncryptedDirectoryFixture.open(context.request, server.baseURL, password, `${cookie.name}=${cookie.value}`)
    for (const count of [1000, 5000]) {
      await page.getByRole('button', { name: '锁定云盘', exact: true }).click()
      const buildingStarted = performance.now()
      const details = await fixture.growTo(count)
      const fixtureMillis = performance.now() - buildingStarted
      let loadingStarted = 0
      const observe = (request: { url(): string }) => { if (request.url().endsWith(`/api/v1/metadata/${fixture.rootId}`)) loadingStarted = performance.now() }
      page.on('request', observe)
      await page.getByLabel('密码', { exact: true }).fill(password)
      await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
      await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
      await expect(page.locator('.item-count')).toHaveText(`${count} 项`)
      rendererHeapSamples.push({ stage: `${count}-interactive-list`, ...(await rendererHeapSample(context, page, browserName)) })
      const firstInteractiveMillis = performance.now() - loadingStarted
      page.off('request', observe)
      expect(loadingStarted).toBeGreaterThan(0)
      if (count === 1000) expect(firstInteractiveMillis).toBeLessThanOrEqual(1500)
      const initial = await measure(page)
      expect(initial.rows).toBeLessThanOrEqual(initial.rowBudget)
      expect(details.rootEncryptedBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
      const first = page.locator('.virtual-entry-list [role="listitem"][aria-posinset="1"]')
      await first.focus()
      await first.press('End')
      const last = page.locator(`.virtual-entry-list [role="listitem"][aria-posinset="${count}"]`)
      await expect(last).toBeFocused()
      await expect(last).toHaveAttribute('aria-setsize', String(count))
      const end = await measure(page)
      expect(end.rows).toBeLessThanOrEqual(end.rowBudget)
      rendererHeapSamples.push({ stage: `${count}-list-end`, ...(await rendererHeapSample(context, page, browserName)) })
      await page.getByRole('button', { name: `folder-${String(count - 1).padStart(5, '0')}`, exact: true }).click()
      await expect(page.getByRole('heading', { name: `folder-${String(count - 1).padStart(5, '0')}`, exact: true })).toBeVisible()
      await expect(page.getByRole('heading', { name: '这里还没有文件', exact: true })).toBeVisible()
      await page.locator('.breadcrumbs').getByRole('button', { name: '我的文件', exact: true }).click()
      await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
      if (count === 5000) {
        let writes = 0
        const countWrites = (request: { url(): string; method(): string }) => { if (request.method() === 'POST' && /\/api\/v1\/(uploads|metadata\/transactions)/u.test(request.url())) writes += 1 }
        page.on('request', countWrites)
        page.once('dialog', (dialog) => void dialog.accept('capacity-excess'))
        await page.getByRole('button', { name: '新建文件夹', exact: true }).click()
        await expect(page.getByRole('alert')).toContainText('5000')
        page.off('request', countWrites)
        expect(writes).toBe(0)
      }
      await page.getByRole('button', { name: '网格视图', exact: true }).click()
      const grid = page.getByRole('list', { name: '文件网格' })
      await expect(grid).toBeVisible()
      const gridInitial = await measureGrid(page)
      expect(gridInitial.cards).toBeLessThanOrEqual(gridInitial.cardBudget)
      await grid.locator('[aria-posinset="1"]').focus(); await grid.locator('[aria-posinset="1"]').press('End')
      await expect(grid.locator(`[aria-posinset="${count}"]`)).toBeFocused()
      const gridEnd = await measureGrid(page); expect(gridEnd.cards).toBeLessThanOrEqual(gridEnd.cardBudget)
      await page.setViewportSize({ width: 390, height: 844 }); await expect(grid).toHaveAttribute('data-columns', '3')
      await grid.locator(`[aria-posinset="${count}"]`).press('Home'); await expect(grid.locator('[aria-posinset="1"]')).toBeFocused()
      const mobileGrid = await measureGrid(page); expect(mobileGrid.cards).toBeLessThanOrEqual(mobileGrid.cardBudget)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.getByRole('button', { name: '列表视图', exact: true }).click()
      measurements.push({ ...details, fixtureMillis, firstInteractiveMillis, initial, end, gridInitial, gridEnd, mobileGrid })
    }
    await page.getByRole('button', { name: '锁定云盘', exact: true }).click()
    await expect(page.getByRole('listitem')).toHaveCount(0)
    await expect(page.locator('body')).not.toContainText('folder-00000')
    await expect(page.locator('body')).not.toContainText('folder-04999')
    rendererHeapSamples.push({ stage: 'locked-final', ...(await rendererHeapSample(context, page, browserName)) })
    const report = { viewport: { width: 1280, height: 800 }, measurements, rendererHeapSamples, fixture: 'Normal setup, Argon2id, AEAD, object PUT, reservation, atomic metadata transactions; all children have real empty indices', timing: 'Root metadata request to visible interactive list; password KDF excluded', browser: testInfo.project.use.browserName, platformsNotVerified: ['mobile devices', 'Safari', '1C1G VPS'] }
    const reportPath = testInfo.outputPath('directory-report.json')
    writeFileSync(reportPath, JSON.stringify(report, null, 2))
    await testInfo.attach('directory-report', { path: reportPath, contentType: 'application/json' })
  } finally { await server.close() }
})
async function measure(page: Page) {
  return page.locator('.virtual-entry-list').evaluate((list) => {
    const rowHeight = Number.parseFloat(getComputedStyle(list).getPropertyValue('--entry-row-height'))
    return { rows: list.querySelectorAll('[role="listitem"]').length, height: list.clientHeight, rowHeight, rowBudget: Math.ceil(list.clientHeight / rowHeight) + 16 }
  })
}

async function rendererHeapSample(context: BrowserContext, page: Page, browserName: string) {
  if (browserName !== 'chromium') return { available: false, reason: 'CDP renderer metrics are Chromium-only' }
  const session = await context.newCDPSession(page)
  try {
    await session.send('Performance.enable')
    const { metrics } = await session.send('Performance.getMetrics')
    const metric = (name: string) => metrics.find((item) => item.name === name)?.value ?? null
    return {
      available: true,
      scope: 'page renderer only; excludes browser process, workers and GPU process',
      jsHeapUsedBytes: metric('JSHeapUsedSize'),
      jsHeapTotalBytes: metric('JSHeapTotalSize'),
      domNodes: metric('Nodes'),
      documents: metric('Documents'),
    }
  } finally {
    await session.detach()
  }
}

async function measureGrid(page: Page) {
 await expect.poll(() => page.getByRole('list', { name: '文件网格' }).evaluate(list => {
  const columns = Number((list as HTMLElement).dataset.columns)
  const expected = innerWidth <= 760 ? 3 : Math.max(1, Math.floor((list.clientWidth + 16) / 164))
  const row = list.querySelector('[role="presentation"] > [role="presentation"]') as HTMLElement | null
  const gap = innerWidth <= 760 ? 8 : 16
  const rowHeight = (list.clientWidth - (columns - 1) * gap) / columns + 70
  return columns === expected && !!row && Math.abs(Number.parseFloat(row.style.height) - rowHeight) < 0.1
 })).toBe(true)
 return page.getByRole('list', { name: '文件网格' }).evaluate(list => {
  const columns = Number((list as HTMLElement).dataset.columns)
  const row = list.querySelector('[role="presentation"] > [role="presentation"]') as HTMLElement
  const height = Number.parseFloat(row.style.height) + (columns === 3 && innerWidth <= 760 ? 8 : 16)
  return { cards: list.querySelectorAll('[role="listitem"]').length, viewportHeight: list.clientHeight, rowHeight: height, columns, cardBudget: (Math.ceil(list.clientHeight / height) + 6) * columns }
 })
}
