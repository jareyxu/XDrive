import { testUsesHTTPS } from './tls-proxy.mjs'
import { selectListPreference } from './legacy-list-test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from './legacy-list-test'
import AxeBuilder from '@axe-core/playwright'
import { startIsolatedServer } from './isolated-server'

async function setup(page: Page, baseURL: string, token: string) {
  await page.goto(`${baseURL}/setup#${token}`)
  await page.getByLabel('设置密码').fill('correct horse battery')
  await page.getByLabel('再次输入密码').fill('correct horse battery')
  await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
  await page.getByRole('button', { name: '创建加密云盘' }).click()
  await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 30_000 })
}
async function preview(page: Page, name: string, content: string) {
  await page.getByRole('button', { name, exact: true }).click()
  await expect(page.getByRole('dialog', { name: `预览 ${name}` })).toContainText(content)
  await page.getByRole('button', { name: '关闭预览' }).click()
}
async function seed(page: Page, bundle: string, names: readonly string[]) {
  for (const name of names) writeFileSync(join(bundle, name), `old:${name}`)
  await expect(page.getByRole('button', { name: '上传文件夹', exact: true })).toBeEnabled()
  await page.locator('input[webkitdirectory]').setInputFiles(bundle)
  await expect(page.getByRole('status').filter({ hasText: `文件夹上传完成，共 ${names.length} 个文件。` })).toBeVisible({ timeout: 30_000 })
}
test('folder conflict summary supports global and per-file choices, safe generated names, cancel and all-skip without writes', async ({ page }) => {
  test.setTimeout(90_000)
  const server = await startIsolatedServer(), root = mkdtempSync(join(tmpdir(), 'xdrive-folder-choices-')), bundle = join(root, 'bundle')
  mkdirSync(bundle)
  try {
    await setup(page, server.baseURL, server.token)
    await seed(page, bundle, ['a.txt', 'b.txt', 'c.txt'])
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'c (1).txt', 'd.txt']) writeFileSync(join(bundle, name), `new:${name}`)
    await expect(page.getByRole('button', { name: '上传文件夹', exact: true })).toBeEnabled()
    await page.locator('input[webkitdirectory]').setInputFiles(bundle)
    const dialog = page.getByRole('dialog', { name: '文件夹上传冲突' })
    await expect(dialog.getByRole('heading')).toHaveText('3 项存在同名冲突')
    for (const button of ['全部覆盖', '全部跳过', '全部保留两者']) await dialog.getByRole('button', { name: button, exact: true }).click()
    await dialog.getByLabel('处理 bundle/a.txt', { exact: true }).selectOption('overwrite')
    await dialog.getByLabel('处理 bundle/b.txt', { exact: true }).selectOption('skip')
    await dialog.getByRole('button', { name: '确认处理并上传' }).click()
    await expect(page.getByRole('status').filter({ hasText: '文件夹上传完成，共 4 个文件，跳过 1 个。' })).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: 'bundle', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'bundle', exact: true })).toBeVisible()
    for (const [name, content] of [['a.txt', 'new:a.txt'], ['b.txt', 'old:b.txt'], ['c.txt', 'old:c.txt'], ['c (1).txt', 'new:c (1).txt'], ['c (2).txt', 'new:c.txt'], ['d.txt', 'new:d.txt']]) await preview(page, name!, content!)
    await page.getByRole('button', { name: '回收站', exact: true }).click()
    await preview(page, 'a.txt', 'old:a.txt')
    await expect(page.getByRole('button', { name: 'b.txt', exact: true })).toHaveCount(0)
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的文件', exact: true }).click()
    await expect(page.getByRole('button', { name: '上传文件夹', exact: true })).toBeEnabled()
    await page.locator('input[webkitdirectory]').setInputFiles(bundle)
    await expect(dialog.getByRole('heading')).toHaveText('5 项存在同名冲突')
    await dialog.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: '上传文件夹', exact: true })).toBeEnabled()
    const writes: string[] = []
    const observe = (request: { method(): string; url(): string }) => { if (['POST', 'PUT', 'DELETE'].includes(request.method())) writes.push(new URL(request.url()).pathname) }
    page.on('request', observe)
    await expect(page.getByRole('button', { name: '上传文件夹', exact: true })).toBeEnabled()
    await page.locator('input[webkitdirectory]').setInputFiles(bundle)
    await dialog.getByRole('button', { name: '全部跳过', exact: true }).click()
    await dialog.getByRole('button', { name: '确认处理并上传' }).click()
    await expect(page.getByRole('status').filter({ hasText: '文件夹上传完成，共 0 个文件，跳过 5 个。' })).toBeVisible()
    page.off('request', observe)
    expect(writes).toEqual([])
  } finally { await server.close(); rmSync(root, { recursive: true, force: true }) }
})

test('incoming folder can atomically replace a same-named file and preserve the old file in trash', async ({ page }) => {
  test.setTimeout(90_000)
  const server = await startIsolatedServer(), root = mkdtempSync(join(tmpdir(), 'xdrive-folder-over-file-')), bundle = join(root, 'replace-me')
  mkdirSync(bundle); mkdirSync(join(bundle, 'nested'))
  writeFileSync(join(bundle, 'top.txt'), 'new top-level bytes')
  writeFileSync(join(bundle, 'nested', 'child.txt'), 'new nested bytes')
  let release = () => {}, notify = () => {}
  const held = new Promise<void>((resolve) => { notify = resolve }), gate = new Promise<void>((resolve) => { release = resolve })
  let heldCommit: Record<string, unknown> | undefined
  try {
    await setup(page, server.baseURL, server.token)
    await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'replace-me', mimeType: 'text/plain', buffer: Buffer.from('old file bytes') })
    await expect(page.getByRole('button', { name: 'replace-me', exact: true })).toBeVisible()
    await page.route('**/api/v1/metadata/transactions', async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>
      if (body.finalizeTombstoneBuildId) {
        heldCommit = body; notify(); await gate
      }
      await route.continue()
    })
    await expect(page.getByRole('button', { name: '上传文件夹', exact: true })).toBeEnabled()
    await page.locator('input[webkitdirectory]').setInputFiles(bundle)
    const dialog = page.getByRole('dialog', { name: '文件夹上传冲突' })
    await expect(dialog.getByRole('heading')).toHaveText('1 项存在同名冲突')
    await expect(dialog.getByText(/新文件夹（2 个文件/u)).toBeVisible()
    await dialog.getByLabel('处理 replace-me', { exact: true }).selectOption('overwrite')
    await dialog.getByRole('button', { name: '确认处理并上传' }).click()
    await held
    const atomicUpdates = heldCommit?.updates as readonly unknown[] | undefined
    expect(atomicUpdates).toHaveLength(3) // child pointer, parent index, and trash index share one transaction
    await expect(page.getByRole('button', { name: 'replace-me', exact: true })).toBeVisible()
    release()
    await expect(page.getByRole('status').filter({ hasText: '文件夹上传完成，共 2 个文件。' })).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: 'replace-me', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'replace-me', exact: true })).toBeVisible()
    await preview(page, 'top.txt', 'new top-level bytes')
    await page.getByRole('button', { name: 'nested', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'nested', exact: true })).toBeVisible()
    await preview(page, 'child.txt', 'new nested bytes')
    await page.getByRole('button', { name: '回收站', exact: true }).click()
    await preview(page, 'replace-me', 'old file bytes')
    const usage = await page.evaluate(async () => (await (await fetch('/api/v1/storage/usage')).json()) as { uploadReservedBytes: number; reservedBytes: number; quotaBytes: number; usedBytes: number })
    expect(usage.uploadReservedBytes).toBe(0)
    expect(usage.usedBytes + usage.reservedBytes).toBeLessThanOrEqual(usage.quotaBytes)
  } finally { release(); await server.close(); rmSync(root, { recursive: true, force: true }) }
})

test('incoming folder can keep both by renaming its full subtree or skip the whole subtree without writes', async ({ page }) => {
  test.setTimeout(90_000)
  const server = await startIsolatedServer(), root = mkdtempSync(join(tmpdir(), 'xdrive-folder-type-choices-'))
  const keepFolder = join(root, 'keep-me'), skipFolder = join(root, 'skip-me')
  mkdirSync(keepFolder); mkdirSync(join(keepFolder, 'nested')); writeFileSync(join(keepFolder, 'nested', 'new.txt'), 'new subtree')
  mkdirSync(skipFolder); writeFileSync(join(skipFolder, 'new.txt'), 'skipped subtree')
  try {
    await setup(page, server.baseURL, server.token)
    const files = page.locator('input[type="file"]:not([webkitdirectory])').first()
    await files.setInputFiles({ name: 'keep-me', mimeType: 'text/plain', buffer: Buffer.from('old keep file') })
    await expect(page.getByRole('button', { name: 'keep-me', exact: true })).toBeVisible()
    await files.setInputFiles({ name: 'skip-me', mimeType: 'text/plain', buffer: Buffer.from('old skip file') })
    await expect(page.getByRole('button', { name: 'skip-me', exact: true })).toBeVisible()

    await expect(page.getByRole('button', { name: '上传文件夹', exact: true })).toBeEnabled()
    await page.locator('input[webkitdirectory]').setInputFiles(keepFolder)
    const dialog = page.getByRole('dialog', { name: '文件夹上传冲突' })
    await expect(dialog.getByRole('heading')).toHaveText('1 项存在同名冲突')
    await dialog.getByLabel('处理 keep-me', { exact: true }).selectOption('keep-both')
    await dialog.getByRole('button', { name: '确认处理并上传' }).click()
    await expect(page.getByRole('status').filter({ hasText: '文件夹上传完成，共 1 个文件。' })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('button', { name: 'keep-me (1)', exact: true })).toBeVisible()
    await preview(page, 'keep-me', 'old keep file')
    await page.getByRole('button', { name: 'keep-me (1)', exact: true }).click()
    await page.getByRole('button', { name: 'nested', exact: true }).click()
    await preview(page, 'new.txt', 'new subtree')
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的文件', exact: true }).click()

    const writes: string[] = []
    const observe = (request: { method(): string; url(): string }) => { if (['POST', 'PUT', 'DELETE'].includes(request.method())) writes.push(new URL(request.url()).pathname) }
    page.on('request', observe)
    await expect(page.getByRole('button', { name: '上传文件夹', exact: true })).toBeEnabled()
    await page.locator('input[webkitdirectory]').setInputFiles(skipFolder)
    await dialog.getByLabel('处理 skip-me', { exact: true }).selectOption('skip')
    await dialog.getByRole('button', { name: '确认处理并上传' }).click()
    await expect(page.getByRole('status').filter({ hasText: '文件夹上传完成，共 0 个文件，跳过 1 个。' })).toBeVisible()
    page.off('request', observe)
    expect(writes).toEqual([])
    await preview(page, 'skip-me', 'old skip file')
    await expect(page.getByRole('button', { name: 'skip-me (1)', exact: true })).toHaveCount(0)
  } finally { await server.close(); rmSync(root, { recursive: true, force: true }) }
})

test('new remote conflicts after confirmation are presented again without inheriting replace-all', async ({ page, browser }) => {
  test.setTimeout(90_000)
  const server = await startIsolatedServer(), root = mkdtempSync(join(tmpdir(), 'xdrive-folder-recheck-')), bundle = join(root, 'bundle')
  mkdirSync(bundle)
  const remote = await browser.newContext({ ignoreHTTPSErrors: testUsesHTTPS() })
  await selectListPreference(remote)
  try {
    await setup(page, server.baseURL, server.token)
    await seed(page, bundle, ['a.txt'])
    writeFileSync(join(bundle, 'a.txt'), 'new:a.txt')
    writeFileSync(join(bundle, 'b.txt'), 'selected:b.txt')
    await expect(page.getByRole('button', { name: '上传文件夹', exact: true })).toBeEnabled()
    await page.locator('input[webkitdirectory]').setInputFiles(bundle)
    const dialog = page.getByRole('dialog', { name: '文件夹上传冲突' })
    await expect(dialog.getByRole('heading')).toHaveText('1 项存在同名冲突')
    await dialog.getByRole('button', { name: '全部覆盖', exact: true }).click()
    await remote.addCookies(await page.context().cookies())
    const other = await remote.newPage()
    await other.goto(`${server.baseURL}/drive`)
    await other.getByLabel('密码', { exact: true }).fill('correct horse battery')
    await other.getByRole('button', { name: '解锁云盘', exact: true }).click()
    await other.getByRole('button', { name: 'bundle', exact: true }).click()
    await expect(other.getByRole('heading', { name: 'bundle', exact: true })).toBeVisible()
    await other.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'b.txt', mimeType: 'text/plain', buffer: Buffer.from('remote:b.txt') })
    await expect(other.getByRole('button', { name: 'b.txt', exact: true })).toBeVisible()
    const writes: string[] = []
    const observe = (request: { method(): string; url(): string }) => { if (['POST', 'PUT', 'DELETE'].includes(request.method())) writes.push(new URL(request.url()).pathname) }
    page.on('request', observe)
    await dialog.getByRole('button', { name: '确认处理并上传' }).click()
    await expect(dialog.getByRole('heading')).toHaveText('2 项存在同名冲突')
    await expect(dialog.getByLabel('处理 bundle/a.txt', { exact: true })).toHaveValue('keep-both')
    await expect(dialog.getByLabel('处理 bundle/b.txt', { exact: true })).toHaveValue('keep-both')
    expect(writes).toEqual([])
    await dialog.getByRole('button', { name: '全部跳过', exact: true }).click()
    await dialog.getByRole('button', { name: '确认处理并上传' }).click()
    await expect(page.getByRole('status').filter({ hasText: '文件夹上传完成，共 0 个文件，跳过 2 个。' })).toBeVisible()
    page.off('request', observe)
    expect(writes).toEqual([])
    await page.getByRole('button', { name: 'bundle', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'bundle', exact: true })).toBeVisible()
    await preview(page, 'a.txt', 'old:a.txt')
    await preview(page, 'b.txt', 'remote:b.txt')
  } finally { await remote.close(); await server.close(); rmSync(root, { recursive: true, force: true }) }
})

test('folder overwrite under quota pressure preserves the old file and retries only after independent trash cleanup', async ({ page }) => {
  test.setTimeout(90_000)
  const server = await startIsolatedServer({ quotaBytes: Math.ceil(100 * 1024 * 4 / 3) }), root = mkdtempSync(join(tmpdir(), 'xdrive-folder-quota-')), bundle = join(root, 'bundle')
  mkdirSync(bundle)
  writeFileSync(join(bundle, 'replace.txt'), 'A'.repeat(10 * 1024))
  try {
    await setup(page, server.baseURL, server.token)
    await expect(page.getByRole('button', { name: '上传文件夹', exact: true })).toBeEnabled()
    await page.locator('input[webkitdirectory]').setInputFiles(bundle)
    await expect(page.getByRole('status').filter({ hasText: '文件夹上传完成，共 1 个文件。' })).toBeVisible()
    await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'other.txt', mimeType: 'text/plain', buffer: Buffer.alloc(25 * 1024, 67) })
    await expect(page.getByRole('button', { name: 'other.txt', exact: true })).toBeVisible()
    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('button', { name: '移到回收站 other.txt', exact: true }).click()
    await expect(page.getByRole('button', { name: 'other.txt', exact: true })).toHaveCount(0)
    writeFileSync(join(bundle, 'replace.txt'), 'B'.repeat(70 * 1024))
    await expect(page.getByRole('button', { name: '上传文件夹', exact: true })).toBeEnabled()
    await page.locator('input[webkitdirectory]').setInputFiles(bundle)
    const dialog = page.getByRole('dialog', { name: '文件夹上传冲突' })
    await dialog.getByRole('button', { name: '全部覆盖', exact: true }).click()
    await dialog.getByRole('button', { name: '确认处理并上传' }).click()
    await expect(page.getByRole('alert')).toContainText('空间不足')
    await expect(page.getByRole('alert')).toContainText('缺少')
    await expect(page.getByRole('alert')).toContainText('旧文件保持原位')
    await expect(page.getByRole('button', { name: '前往回收站清理', exact: true })).toBeVisible()
    const usage = await page.evaluate(async () => (await (await fetch('/api/v1/storage/usage')).json()) as { usedBytes: number; reservedBytes: number; uploadReservedBytes: number; quotaBytes: number })
    expect(usage.usedBytes + usage.reservedBytes).toBeLessThanOrEqual(usage.quotaBytes)
    expect(usage.uploadReservedBytes).toBe(0)
    await page.getByRole('button', { name: 'bundle', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'bundle', exact: true })).toBeVisible()
    await preview(page, 'replace.txt', 'A'.repeat(100))
    // Opening another folder/preview dismisses the previous operation's error.
    // Its cleanup shortcut was verified above; use the persistent navigation.
    await page.getByRole('button', { name: '回收站', exact: true }).click()
    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('button', { name: '永久删除 other.txt', exact: true }).click()
    await expect(page.getByText('回收站为空', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '我的文件', exact: true }).click()
    await expect(page.getByRole('button', { name: '上传文件夹', exact: true })).toBeEnabled()
    await page.locator('input[webkitdirectory]').setInputFiles(bundle)
    await expect(dialog.getByRole('heading')).toHaveText('1 项存在同名冲突')
    await dialog.getByRole('button', { name: '全部覆盖', exact: true }).click()
    await dialog.getByRole('button', { name: '确认处理并上传' }).click()
    await expect(page.getByRole('status').filter({ hasText: '文件夹上传完成，共 1 个文件。' })).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: 'bundle', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'bundle', exact: true })).toBeVisible()
    await preview(page, 'replace.txt', 'B'.repeat(100))
    await page.getByRole('button', { name: '回收站', exact: true }).click()
    await preview(page, 'replace.txt', 'A'.repeat(100))
  } finally { await server.close(); rmSync(root, { recursive: true, force: true }) }
})

test('a conflict arriving during a chunk PUT abandons that pending session before replanning the remaining file', async ({ page, browser }) => {
  test.setTimeout(90_000)
  const server = await startIsolatedServer(), root = mkdtempSync(join(tmpdir(), 'xdrive-folder-mid-put-')), bundle = join(root, 'bundle')
  mkdirSync(bundle)
  const remote = await browser.newContext({ ignoreHTTPSErrors: testUsesHTTPS() })
  await selectListPreference(remote)
  let release = () => {}, notify = () => {}
  const held = new Promise<void>((resolve) => { notify = resolve }), gate = new Promise<void>((resolve) => { release = resolve })
  let uploadId = '', intercepted = false
  try {
    await setup(page, server.baseURL, server.token)
    await seed(page, bundle, ['a.txt'])
    rmSync(join(bundle, 'a.txt'))
    writeFileSync(join(bundle, 'b.txt'), 'selected:b.txt')
    await remote.addCookies(await page.context().cookies())
    const other = await remote.newPage()
    await other.goto(`${server.baseURL}/drive`)
    await other.getByLabel('密码', { exact: true }).fill('correct horse battery')
    await other.getByRole('button', { name: '解锁云盘', exact: true }).click()
    await other.getByRole('button', { name: 'bundle', exact: true }).click()
    await expect(other.getByRole('heading', { name: 'bundle', exact: true })).toBeVisible()
    await page.route('**/api/v1/uploads/*/objects/*', async (route) => {
      if (!intercepted && route.request().method() === 'PUT') {
        intercepted = true; uploadId = new URL(route.request().url()).pathname.split('/')[4]!
        notify(); await gate
      }
      await route.continue()
    })
    await expect(page.getByRole('button', { name: '上传文件夹', exact: true })).toBeEnabled()
    await page.locator('input[webkitdirectory]').setInputFiles(bundle)
    await held
    await other.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'b.txt', mimeType: 'text/plain', buffer: Buffer.from('remote:b.txt') })
    await expect(other.getByRole('button', { name: 'b.txt', exact: true })).toBeVisible()
    release()
    const dialog = page.getByRole('dialog', { name: '文件夹上传冲突' })
    await expect(dialog.getByRole('heading')).toHaveText('1 项存在同名冲突')
    const status = await page.evaluate(async (id) => {
      const response = await fetch(`/api/v1/uploads/${id}`)
      if (!response.ok) throw new Error(`pending fixture status ${response.status}`)
      return response.json()
    }, uploadId) as { state: string; claims: unknown[]; objects: unknown[] }
    expect(status.state).toBe('aborted')
    expect(status.claims).toEqual([])
    await dialog.getByRole('button', { name: '全部保留两者', exact: true }).click()
    await dialog.getByRole('button', { name: '确认处理并上传' }).click()
    await expect(page.getByRole('status').filter({ hasText: '文件夹上传完成，共 1 个文件。' })).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: 'bundle', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'bundle', exact: true })).toBeVisible()
    await preview(page, 'b.txt', 'remote:b.txt')
    await preview(page, 'b (1).txt', 'selected:b.txt')
    const usage = await page.evaluate(async () => (await fetch('/api/v1/storage/usage')).json()) as { uploadReservedBytes: number; reservedBytes: number }
    expect(usage.uploadReservedBytes).toBe(0)
  } finally { release(); await remote.close(); await server.close(); rmSync(root, { recursive: true, force: true }) }
})

test('folder conflict dialog fits a narrow touch viewport and keeps keyboard focus inside its modal', async ({ page, browserName }, testInfo) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 375, height: 812 })
  // This test exercises the webkitdirectory compatibility path and its filechooser.
  // The preferred native directory picker has a separate encrypted-upload E2E.
  await page.addInitScript(() => { Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true }) })
  const server = await startIsolatedServer(), root = mkdtempSync(join(tmpdir(), 'xdrive-folder-dialog-')), bundle = join(root, 'bundle')
  mkdirSync(bundle)
  try {
    await setup(page, server.baseURL, server.token)
    await seed(page, bundle, ['long-file-name-with-many-characters.txt'])
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '上传文件夹', exact: true }).click()
    await (await chooser).setFiles(bundle)
    const dialog = page.getByRole('dialog', { name: '文件夹上传冲突' })
    await expect(dialog.getByRole('heading')).toHaveText('1 项存在同名冲突')
    const layout = await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left, right: rect.right, viewport: innerWidth, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, height: rect.height, viewportHeight: innerHeight, background: getComputedStyle(element).backgroundColor, heights: [...element.querySelectorAll('button,select')].map((control) => control.getBoundingClientRect().height), controls: [...element.querySelectorAll('button,select')].map((control) => ({ tag: control.tagName, label: control.getAttribute('aria-label') ?? control.textContent, height: control.getBoundingClientRect().height, cssMinHeight: getComputedStyle(control).minHeight, cssHeight: getComputedStyle(control).height })) }
    })
    await testInfo.attach('folder-conflict-layout', { body: JSON.stringify(layout, null, 2), contentType: 'application/json' })
    expect(layout.left).toBeGreaterThanOrEqual(0)
    expect(layout.right).toBeLessThanOrEqual(layout.viewport)
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth)
    expect(layout.height).toBeLessThanOrEqual(layout.viewportHeight)
    expect(layout.heights.every((height) => height >= 44)).toBe(true)
    expect(layout.background).toMatch(/^rgb\(\d+, \d+, \d+\)$/u)
    for (const direction of ['Tab', 'Shift+Tab']) {
      for (let tab = 0; tab < 12; tab += 1) {
        const expectedIndex = await dialog.evaluate((element, backward) => {
          const controls = [...element.querySelectorAll<HTMLElement>('button,select,[tabindex]')].filter((control) => control.tabIndex >= 0 && !control.matches(':disabled') && control.getClientRects().length > 0)
          const current = controls.findIndex((control) => control === document.activeElement)
          return current < 0 ? (backward ? controls.length - 1 : 0) : (current + (backward ? -1 : 1) + controls.length) % controls.length
        }, direction === 'Shift+Tab')
        await page.keyboard.press(direction)
        expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
        expect(await dialog.evaluate((element) => {
          const controls = [...element.querySelectorAll<HTMLElement>('button,select,[tabindex]')].filter((control) => control.tabIndex >= 0 && !control.matches(':disabled') && control.getClientRects().length > 0)
          return controls.findIndex((control) => control === document.activeElement)
        })).toBe(expectedIndex)
      }
    }
    const accessibility = await new AxeBuilder({ page }).include('dialog').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
    expect(accessibility.violations.filter((item) => item.impact === 'serious' || item.impact === 'critical')).toEqual([])
    const reportPath = testInfo.outputPath('folder-conflict-accessibility.json')
    writeFileSync(reportPath, JSON.stringify({ viewport: { width: 375, height: 812 }, layout, keyboardTabSteps: 24, axeViolations: accessibility.violations.map((item) => ({ id: item.id, impact: item.impact })), scope: `Desktop ${browserName} narrow viewport, new conflict modal only; not real mobile or full application accessibility` }, null, 2))
    await testInfo.attach('folder-conflict-accessibility', { path: reportPath, contentType: 'application/json' })
    const image = testInfo.outputPath('folder-conflict-narrow.png')
    await dialog.screenshot({ path: image })
    await testInfo.attach('narrow-folder-conflict', { path: image, contentType: 'image/png' })
    await dialog.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: '上传文件夹', exact: true })).toBeFocused()
  } finally { await server.close(); rmSync(root, { recursive: true, force: true }) }
})
