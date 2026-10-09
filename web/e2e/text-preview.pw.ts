import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { startIsolatedServer } from './isolated-server'

const password = 'correct horse battery'
test('configured text preview limit rejects before object reads, allows the exact boundary and fails closed on unavailable policy', async ({ page }) => {
  const server = await startIsolatedServer({ textPreviewLimit: 1024 })
  try {
    await setup(page, server.baseURL, server.token)
    await upload(page, 'exact.txt', 'x'.repeat(1024), 'text/plain')
    await upload(page, 'over.txt', 'x'.repeat(1025), 'text/plain')
    let reads = 0
    page.on('request', request => { if (request.method() === 'GET' && /\/api\/v1\/objects\//u.test(request.url())) reads++ })
    await page.getByRole('button', { name: 'over.txt', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('1,024 bytes 预览上限')
    expect(reads).toBe(0)
    await page.getByRole('button', { name: 'exact.txt', exact: true }).click()
    await expect(page.locator('.preview-text')).toHaveText('x'.repeat(1024))
    expect(reads).toBeGreaterThan(0)
    await page.keyboard.press('Escape')
    reads = 0
    await page.route('**/api/v1/system/info', route => route.fulfill({ status: 200, json: { textPreviewLimit: 0 } }))
    await page.getByRole('button', { name: 'exact.txt', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('无法读取有效的文本预览上限')
    expect(reads).toBe(0)
    await page.route('**/api/v1/system/info', route => route.fulfill({ status: 503, json: { error: 'unavailable' } }))
    const failedPolicy = page.waitForResponse(response => response.url().endsWith('/api/v1/system/info') && response.status() === 503)
    await page.getByRole('button', { name: 'exact.txt', exact: true }).click()
    await failedPolicy
    await expect(page.getByRole('alert')).not.toContainText('无法读取有效的文本预览上限')
    await expect(page.locator('.preview-text')).toHaveCount(0)
    expect(reads).toBe(0)
  } finally { await server.close() }
})
async function setup(page: Page, url: string, token: string) {
  await page.clock.install()
  await page.addInitScript(() => Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined }))
  await page.goto(`${url}/setup#${token}`)
  await page.getByLabel('设置密码').fill(password)
  await page.getByLabel('再次输入密码').fill(password)
  await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
  await page.getByRole('button', { name: '创建加密云盘' }).click()
  await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 30_000 })
}
async function upload(page: Page, name: string, source: string, mimeType: string) {
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name, mimeType, buffer: Buffer.from(source) })
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('input[type="file"]:not([webkitdirectory])').first()).toBeEnabled()
}
async function originalDownload(page: Page, source: string) {
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载原文件', exact: true }).click()
  const stream = await (await download).createReadStream()
  if (!stream) throw new Error('download stream missing')
  const buffers: Buffer[] = []
  for await (const buffer of stream) buffers.push(Buffer.from(buffer))
  expect(Buffer.concat(buffers)).toEqual(Buffer.from(source))
}
test('real encrypted source has worker-based highlighting, virtual line numbers, complete navigation, exact download and lock cleanup', async ({ page }) => {
  test.setTimeout(120_000)
  const server = await startIsolatedServer(), requests: string[] = []
  page.on('request', request => requests.push(request.url()))
  try {
    await setup(page, server.baseURL, server.token)
    expect(requests.filter(url => /CodePreview-|code-highlight\.worker|MarkdownPreview-/u.test(url))).toEqual([])
    const source = Array.from({ length: 15_050 }, (_, i) => `export const safeLine${i} = ${i}; // 中文 🦊`).join('\n')
    await upload(page, 'private-source.ts', source, 'application/octet-stream')
    await page.getByRole('button', { name: 'private-source.ts', exact: true }).click()
    const region = page.getByRole('region', { name: '代码预览', exact: true })
    await expect(region.getByRole('status')).toHaveText('typescript · 只读', { timeout: 30_000 })
    await expect(region.locator('.hljs-keyword').first()).toHaveText('export')
    expect(await region.locator('.code-line').count()).toBeLessThan(60)
    await page.getByLabel('跳至行', { exact: true }).fill('12345')
    await region.getByRole('button', { name: '跳转', exact: true }).click()
    await expect(region.locator('[data-line-number="12345"] code')).toHaveText('export const safeLine12344 = 12344; // 中文 🦊')
    await region.getByRole('region', { name: /只读源码/ }).press('End')
    await expect(region.locator('[data-line-number="15050"] code')).toContainText('safeLine15049')
    await originalDownload(page, source)
    await page.setViewportSize({ width: 320, height: 700 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const audit = await new AxeBuilder({ page }).include('.code-preview').analyze()
    expect(audit.violations.filter(issue => ['serious', 'critical'].includes(issue.impact!))).toEqual([])
    await page.clock.fastForward(11 * 60_000)
    await expect(page.getByRole('heading', { name: '重新解锁云盘' })).toBeVisible()
    await expect(page.locator('.code-preview, .code-line')).toHaveCount(0)
    await expect(page.locator('body')).not.toContainText('safeLine15049')
  } finally { await server.close() }
})
test('encrypted Markdown blocks active HTML and remote media, preserves source/download, isolates links and loads only on preview', async ({ page }) => {
  test.setTimeout(90_000)
  const server = await startIsolatedServer(), requests: string[] = []
  page.on('request', request => requests.push(request.url()))
  try {
    await setup(page, server.baseURL, server.token)
    expect(requests.filter(url => /MarkdownPreview-|CodePreview-|code-highlight\.worker/u.test(url))).toEqual([])
    const source = ['# Private Notes', '![tracker](https://tracker.invalid/pixel)', '<img src="https://tracker.invalid/raw" onerror="window.previewCompromised=1">', '<svg onload="window.previewCompromised=2"><a href="javascript:alert(1)">unsafe</a></svg>', '<iframe src="https://tracker.invalid/frame"></iframe>', '<script>window.previewCompromised=3</script>', '[script](javascript:alert(1)) [data](data:text/html,evil) [file](file:///etc/passwd)', '[Docs](https://example.com/docs)', '- [x] Done\n- [ ] Pending', '```html\n<img src=x onerror=alert(1)>\n```'].join('\n\n')
    await upload(page, 'private-notes.md', source, 'text/markdown')
    await page.getByRole('button', { name: 'private-notes.md', exact: true }).click()
    const article = page.locator('.preview-markdown')
    await expect(article.getByRole('heading', { name: 'Private Notes' })).toBeVisible()
    await expect(article.locator('.markdown-image-placeholder')).toContainText('图片已阻止：tracker')
    await expect(article.locator('img, script, svg, iframe, object, embed, form, input')).toHaveCount(0)
    expect(await page.evaluate(() => (window as Window & { previewCompromised?: number }).previewCompromised)).toBeUndefined()
    const link = article.getByRole('link', { name: 'Docs', exact: true })
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    await expect(link).toHaveAttribute('referrerpolicy', 'no-referrer')
    expect(await article.locator('a[href]').evaluateAll(links => links.map(a => a.getAttribute('href')))).toEqual(['https://example.com/docs'])
    await page.getByRole('button', { name: '源码', exact: true }).click()
    await expect(page.locator('.preview-text')).toHaveText(source)
    await originalDownload(page, source)
    await page.getByRole('button', { name: '阅读', exact: true }).click()
    expect(requests.filter(url => new URL(url).origin !== server.baseURL)).toEqual([])
    expect(requests.some(url => url.includes('MarkdownPreview-'))).toBe(true)
    await page.clock.fastForward(11 * 60_000)
    await expect(page.getByRole('heading', { name: '重新解锁云盘' })).toBeVisible()
    await expect(page.locator('body')).not.toContainText('Private Notes')
    await expect(page.locator('.preview-markdown, .preview-text')).toHaveCount(0)
  } finally { await server.close() }
})
