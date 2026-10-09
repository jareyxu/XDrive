import { testUsesHTTPS } from './tls-proxy.mjs'
import { selectListPreference } from './legacy-list-test'
import { expect, test, type Page } from './legacy-list-test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startIsolatedServer } from './isolated-server'
const password = 'correct horse battery'
const source = (name: string, text = `new:${name}`) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) })
const picker = (page: Page) => page.locator('input[type="file"]:not([webkitdirectory])').first()
async function setup(page: Page, baseURL: string, token: string) {
  await page.goto(`${baseURL}/setup#${token}`)
  await page.getByLabel('设置密码').fill(password)
  await page.getByLabel('再次输入密码').fill(password)
  await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
  await page.getByRole('button', { name: '创建加密云盘' }).click()
  await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 30_000 })
}
async function preview(page: Page, name: string, text: string) {
  await page.getByRole('button', { name, exact: true }).click()
  await expect(page.getByRole('dialog', { name: `预览 ${name}` })).toContainText(text)
  await page.getByRole('button', { name: '关闭预览' }).click()
}

test('direct multiple-file picker supports mixed conflict decisions, existing bytes, generated names and all-skip without writes', async ({ page }) => {
  test.setTimeout(90_000)
  const server = await startIsolatedServer()
  try {
    await setup(page, server.baseURL, server.token)
    await expect(picker(page)).toHaveAttribute('multiple', '')
    page.once('dialog', (dialog) => void dialog.accept('Destination'))
    await page.getByRole('button', { name: '新建文件夹', exact: true }).click()
    await page.getByRole('button', { name: 'Destination', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Destination', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
    await picker(page).setInputFiles(['a.txt', 'b.txt', 'c.txt'].map((name) => source(name, `old:${name}`)))
    await expect(page.getByRole('status')).toContainText('批量上传完成，共 3 个文件。')
    await expect(page.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
    await picker(page).setInputFiles(['a.txt', 'b.txt', 'c.txt', 'c (1).txt', 'd.txt'].map((name) => source(name)))
    const dialog = page.getByRole('dialog', { name: '文件上传冲突', exact: true })
    await expect(dialog.getByRole('heading')).toHaveText('3 项存在同名冲突')
    await dialog.getByRole('button', { name: '全部保留两者' }).click()
    await dialog.getByLabel('处理 a.txt', { exact: true }).selectOption('overwrite')
    await dialog.getByLabel('处理 b.txt', { exact: true }).selectOption('skip')
    await dialog.getByRole('button', { name: '确认处理并上传' }).click()
    await expect(page.getByRole('status')).toContainText('批量上传完成，共 4 个文件，跳过 1 个。')
    for (const [name, text] of [['a.txt', 'new:a.txt'], ['b.txt', 'old:b.txt'], ['c.txt', 'old:c.txt'], ['c (1).txt', 'new:c (1).txt'], ['c (2).txt', 'new:c.txt'], ['d.txt', 'new:d.txt']]) await preview(page, name!, text!)
    await expect(page.locator('.entry-kind').filter({ hasText: '文件夹' })).toHaveCount(0)
    await page.getByRole('button', { name: '回收站', exact: true }).click()
    await preview(page, 'a.txt', 'old:a.txt')
    await page.getByRole('button', { name: '我的文件', exact: true }).click()
    await page.getByRole('button', { name: 'Destination', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Destination', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
    await picker(page).setInputFiles(['a.txt', 'b.txt'].map((name) => source(name)))
    await expect(dialog).toBeVisible()
    await dialog.press('Escape')
    await expect(dialog).toHaveCount(0)
    const writes: string[] = []
    page.on('request', (request) => { if (['PUT', 'POST', 'DELETE'].includes(request.method())) writes.push(new URL(request.url()).pathname) })
    await expect(page.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
    await picker(page).setInputFiles(['a.txt', 'b.txt'].map((name) => source(name)))
    await dialog.getByRole('button', { name: '全部跳过' }).click()
    await dialog.getByRole('button', { name: '确认处理并上传' }).click()
    await expect(page.getByRole('status')).toContainText('批量上传完成，共 0 个文件，跳过 2 个。')
    expect(writes).toEqual([])
    await page.locator('.breadcrumbs').getByRole('button', { name: '我的文件', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Destination', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'a.txt', exact: true })).toHaveCount(0)
  } finally { await server.close() }
})

test('duplicate normalized names in a multi-file selection reject before writes and do not hide completed entries', async ({ page }) => {
  const server = await startIsolatedServer()
  try {
    await setup(page, server.baseURL, server.token)
    await expect(page.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
    await picker(page).setInputFiles(source('preserved.txt'))
    await expect(page.getByRole('button', { name: 'preserved.txt', exact: true })).toBeVisible()
    const writes: string[] = []
    page.on('request', (request) => { if (['PUT', 'POST', 'DELETE'].includes(request.method())) writes.push(new URL(request.url()).pathname) })
    await expect(page.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
    await picker(page).setInputFiles([source('Café.txt'), source('Cafe\u0301.txt')])
    await expect(page.getByRole('alert')).toContainText('重复')
    expect(writes).toEqual([])
    await preview(page, 'preserved.txt', 'new:preserved.txt')
    await expect(page.getByRole('button', { name: 'Café.txt', exact: true })).toHaveCount(0)
  } finally { await server.close() }
})

test('quota exhaustion in a multi-file batch retains earlier commits and stops remaining writes', async ({ page }) => {
  test.setTimeout(90_000)
  const server = await startIsolatedServer({ quotaBytes: 50 * 1024 })
  try {
    await setup(page, server.baseURL, server.token)
    await expect(page.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
    await picker(page).setInputFiles([source('a.txt', 'A'.repeat(8 * 1024)), source('b.txt', 'B'.repeat(60 * 1024)), source('c.txt')])
    await expect(page.getByRole('alert')).toContainText('空间不足')
    await expect(page.getByRole('alert')).toContainText('已完成 1 / 3 个文件')
    await expect(page.getByRole('button', { name: '前往回收站清理' })).toBeVisible()
    await preview(page, 'a.txt', 'A'.repeat(100))
    for (const name of ['b.txt', 'c.txt']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0)
    const usage = await page.evaluate(async () => (await (await fetch('/api/v1/storage/usage')).json()) as { uploadReservedBytes: number; reservedBytes: number; usedBytes: number; quotaBytes: number })
    expect(usage.uploadReservedBytes).toBe(0)
    expect(usage.usedBytes).toBeLessThanOrEqual(usage.quotaBytes)
  } finally { await server.close() }
})

test('locking a batch during its second file preserves the first commit and allows the encrypted pending file to resume', async ({ page }) => {
  test.setTimeout(90_000)
  const server = await startIsolatedServer(), root = mkdtempSync(join(tmpdir(), 'xdrive-batch-lock-'))
  const files = ['a.txt', 'b.txt', 'c.txt'].map((name) => join(root, name))
  files.forEach((path, index) => writeFileSync(path, String.fromCharCode(65 + index).repeat(128 * 1024)))
  const sessions = new Set<string>()
  let release = () => {}, notify = () => {}, heldOnce = false
  const held = new Promise<void>((resolve) => { notify = resolve }), gate = new Promise<void>((resolve) => { release = resolve })
  try {
    await setup(page, server.baseURL, server.token)
    await page.route('**/api/v1/uploads/*/objects/*', async (route) => {
      if (route.request().method() === 'PUT') {
        sessions.add(new URL(route.request().url()).pathname.split('/')[4]!)
        if (sessions.size === 2 && !heldOnce) { heldOnce = true; notify(); await gate }
      }
      await route.continue().catch(() => {})
    })
    await expect(page.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
    await picker(page).setInputFiles(files)
    await held
    await page.getByRole('button', { name: '锁定云盘' }).click()
    await expect(page.getByRole('heading', { name: '重新解锁云盘' })).toBeVisible()
    await expect(page.getByText('a.txt', { exact: true })).toHaveCount(0)
    release()
    await page.getByLabel('密码', { exact: true }).fill(password)
    await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
    await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
    await preview(page, 'a.txt', 'A'.repeat(100))
    for (const name of ['b.txt', 'c.txt']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0)
    expect(sessions.size).toBe(2)
    await expect(page.getByRole('region', { name: '可恢复的上传任务' })).toContainText('b.txt')
    const choose = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '重新选择原文件并续传', exact: true }).click()
    await (await choose).setFiles(files[1]!)
    await expect(page.getByRole('status')).toContainText('续传完成。')
    await preview(page, 'b.txt', 'B'.repeat(100))
    await expect(page.getByRole('region', { name: '可恢复的上传任务' })).toHaveCount(0)
    expect(await page.evaluate(async () => (await (await fetch('/api/v1/storage/usage')).json()).uploadReservedBytes)).toBe(0)
    await expect(page.getByRole('button', { name: 'c.txt', exact: true })).toHaveCount(0)
  } finally { release(); await server.close(); rmSync(root, { recursive: true, force: true }) }
})

test('a remote file arriving while direct-batch choices wait forces fresh confirmation', async ({ page, browser }) => {
  test.setTimeout(90_000)
  const server = await startIsolatedServer(), remote = await browser.newContext({ ignoreHTTPSErrors: testUsesHTTPS() })
  await selectListPreference(remote)
  try {
    await setup(page, server.baseURL, server.token)
    await expect(page.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
    await picker(page).setInputFiles(source('a.txt', 'old:a'))
    await expect(page.getByRole('button', { name: 'a.txt', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
    await picker(page).setInputFiles([source('a.txt'), source('b.txt')])
    const dialog = page.getByRole('dialog', { name: '文件上传冲突', exact: true })
    await expect(dialog.getByRole('heading')).toHaveText('1 项存在同名冲突')
    await dialog.getByRole('button', { name: '全部覆盖' }).click()
    await remote.addCookies(await page.context().cookies())
    const other = await remote.newPage()
    await other.goto(`${server.baseURL}/drive`)
    await other.getByLabel('密码', { exact: true }).fill(password)
    await other.getByRole('button', { name: '解锁云盘', exact: true }).click()
    await expect(other.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
    await expect(other.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
    await picker(other).setInputFiles(source('b.txt', 'remote:b'))
    await expect(other.getByRole('button', { name: 'b.txt', exact: true })).toBeVisible()
    const writes: string[] = []
    page.on('request', (request) => { if (['POST', 'PUT', 'DELETE'].includes(request.method())) writes.push(new URL(request.url()).pathname) })
    await dialog.getByRole('button', { name: '确认处理并上传' }).click()
    await expect(dialog.getByRole('heading')).toHaveText('2 项存在同名冲突')
    await expect(dialog.getByLabel('处理 a.txt', { exact: true })).toHaveValue('keep-both')
    await expect(dialog.getByLabel('处理 b.txt', { exact: true })).toHaveValue('keep-both')
    expect(writes).toEqual([])
    await dialog.getByRole('button', { name: '全部跳过' }).click()
    await dialog.getByRole('button', { name: '确认处理并上传' }).click()
    await expect(page.getByRole('status')).toContainText('批量上传完成，共 0 个文件，跳过 2 个。')
    expect(writes).toEqual([])
    await preview(page, 'a.txt', 'old:a')
    await preview(page, 'b.txt', 'remote:b')
  } finally { await remote.close(); await server.close() }
})
