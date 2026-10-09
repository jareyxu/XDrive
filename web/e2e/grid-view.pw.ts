import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { startIsolatedServer } from './isolated-server'
const password = 'correct horse battery'
async function setup(page: Page, url: string, token: string) {
 await page.goto(`${url}/setup#${token}`)
 await page.getByLabel('设置密码').fill(password); await page.getByLabel('再次输入密码').fill(password)
 await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
 await page.getByRole('button', { name: '创建加密云盘' }).click()
 await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 30000 })
}
async function upload(page: Page, name: string, content: string, modified: number, type = 'text/plain') {
 await page.evaluate(({ name, content, modified, type }) => {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]:not([webkitdirectory])')!
  const transfer = new DataTransfer(); transfer.items.add(new File([content], name, { type, lastModified: modified })); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }))
 }, { name, content, modified, type })
 await expect(page.getByRole('button', { name, exact: true })).toBeVisible({ timeout: 30000 })
 await expect(page.locator('input[type="file"]:not([webkitdirectory])').first()).toBeEnabled()
}
const names = (page: Page) => page.locator('.entry-card-name').allTextContents()
test('default grid sorts real encrypted entries, opens menus, previews/downloads, renames and persists list preference', async ({ page }) => {
 test.setTimeout(120000); const server = await startIsolatedServer()
 try {
  await page.addInitScript(() => Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined }))
  await setup(page, server.baseURL, server.token)
  page.once('dialog', dialog => void dialog.accept('folder')); await page.getByRole('button', { name: '新建文件夹', exact: true }).click()
  await expect(page.getByRole('button', { name: 'folder', exact: true })).toBeVisible()
  await upload(page, 'file10.txt', 'larger private grid fixture', Date.UTC(2025, 3, 21, 12))
  await upload(page, 'file2.txt', 'small', Date.UTC(2025, 4, 2, 12))
  await upload(page, 'data.pdf', 'pdf sample bytes', Date.UTC(2025, 5, 3, 12), 'application/pdf')
  await expect(page.getByRole('list', { name: '文件网格' })).toBeVisible()
  expect(await names(page)).toEqual(['folder', 'data.pdf', 'file2.txt', 'file10.txt'])
  await page.getByLabel('排序字段').selectOption('size'); expect(await names(page)).toEqual(['folder', 'file2.txt', 'data.pdf', 'file10.txt'])
  await page.getByRole('button', { name: '切换为降序' }).click(); expect(await names(page)).toEqual(['folder', 'file10.txt', 'data.pdf', 'file2.txt'])
  await page.getByLabel('排序字段').selectOption('modified'); expect(await names(page)).toEqual(['folder', 'data.pdf', 'file2.txt', 'file10.txt'])
  await page.getByRole('button', { name: '打开 file2.txt', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '预览 file2.txt' })).toContainText('small'); await page.getByLabel('关闭预览').click()
  const more = page.getByRole('button', { name: '更多操作 file2.txt', exact: true })
  await more.click(); const menu = page.getByRole('dialog', { name: '项目操作 file2.txt' }); await expect(menu).toBeVisible()
  for (const [key, names] of [['Tab', ['重命名 file2.txt', '移动 file2.txt', '移到回收站 file2.txt', '下载 file2.txt', '关闭']], ['Shift+Tab', ['下载 file2.txt', '移到回收站 file2.txt', '移动 file2.txt', '重命名 file2.txt', '关闭']]] as const) {
    for (const name of names) { await page.keyboard.press(key); await expect(menu.getByRole('button', { name, exact: true })).toBeFocused() }
  }
  await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0); await expect(more).toBeFocused()
  await more.click(); const downloaded = page.waitForEvent('download', { timeout: 30000 }); await page.getByRole('button', { name: '下载 file2.txt', exact: true }).click()
  const stream = await (await downloaded).createReadStream(); if (!stream) throw new Error('download missing')
  let content = ''; for await (const chunk of stream) content += chunk.toString(); expect(content).toBe('small')
  const card = page.locator('.entry-card').filter({ has: page.getByRole('button', { name: 'file2.txt', exact: true }) }); await card.focus()
  page.once('dialog', dialog => void dialog.accept('renamed.txt')); await card.press('F2'); await expect(page.getByRole('button', { name: 'renamed.txt', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '列表视图', exact: true }).click(); await expect(page.locator('.virtual-entry-list')).toBeVisible()
  await expect(page.getByRole('group', { name: '文件列表列标题' })).toBeVisible()
  const fileRow = page.locator('.drive-list-row').filter({ has: page.getByRole('button', { name: 'file10.txt', exact: true }) })
  await expect(fileRow.locator('.drive-list-modified')).toContainText('2025')
  await expect(page.locator('.drive-list-row').filter({ has: page.getByRole('button', { name: 'data.pdf', exact: true }) }).locator('.drive-list-mime')).toHaveText('application/pdf')
  await page.getByRole('button', { name: '按修改时间排序' }).click()
  const orderedListNames = () => page.locator('.drive-list-row').evaluateAll(rows => rows.map(row => row.querySelector('.drive-list-name')?.childNodes[0]?.textContent?.trim()))
  await expect.poll(orderedListNames).toEqual(['folder', 'file10.txt', 'renamed.txt', 'data.pdf'])
  await page.getByRole('button', { name: '按修改时间排序' }).click()
  await expect.poll(orderedListNames).toEqual(['folder', 'data.pdf', 'renamed.txt', 'file10.txt'])
  await page.getByRole('button', { name: '按名称排序' }).click()
  await expect.poll(orderedListNames).toEqual(['folder', 'renamed.txt', 'file10.txt', 'data.pdf'])
  await page.getByRole('button', { name: '按名称排序' }).click()
  await expect.poll(orderedListNames).toEqual(['folder', 'data.pdf', 'file10.txt', 'renamed.txt'])
  await page.getByRole('button', { name: '按大小排序' }).click()
  await expect.poll(orderedListNames).toEqual(['folder', 'renamed.txt', 'data.pdf', 'file10.txt'])
  await page.getByRole('button', { name: '按类型排序' }).click()
  await expect.poll(orderedListNames).toEqual(['folder', 'data.pdf', 'file10.txt', 'renamed.txt'])
  await page.getByRole('button', { name: '按类型排序' }).click()
  await expect.poll(orderedListNames).toEqual(['folder', 'file10.txt', 'renamed.txt', 'data.pdf'])
  await page.getByRole('button', { name: '更多操作 renamed.txt' }).click(); page.once('dialog', dialog => void dialog.accept()); await page.getByRole('dialog', { name: '项目操作 renamed.txt' }).getByRole('button', { name: '移到回收站 renamed.txt' }).click()
  await expect(page.getByRole('button', { name: 'renamed.txt', exact: true })).toHaveCount(0)
  await page.reload(); await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
  await expect(page.locator('.virtual-entry-list')).toBeVisible(); expect(await page.evaluate(() => JSON.parse(localStorage.getItem('xdrive.preferences.v1')!).view)).toBe('list')
  await page.getByRole('button', { name: '网格视图', exact: true }).click(); await expect(page.getByRole('list', { name: '文件网格' })).toBeVisible()
  await page.getByRole('button', { name: '锁定云盘', exact: true }).click(); await expect(page.locator('.entry-card')).toHaveCount(0); await expect(page.locator('body')).not.toContainText('file10.txt')
 } finally { await server.close() }
})
test('mobile default grid has three columns, usable card targets and accessible light/dark/solid controls', async ({ page, browserName }) => {
 test.setTimeout(120000); const server = await startIsolatedServer()
 try {
  await setup(page, server.baseURL, server.token); await page.setViewportSize({ width: 390, height: 844 })
  for (const name of ['folder1', 'folder2', 'folder3', 'folder4']) { page.once('dialog', dialog => void dialog.accept(name)); await page.getByRole('button', { name: '新建文件夹', exact: true }).click(); await expect(page.getByRole('button', { name, exact: true })).toBeVisible() }
  const grid = page.getByRole('list', { name: '文件网格' }); await expect(grid).toHaveAttribute('data-columns', '3')
  await page.setViewportSize({ width: 320, height: 700 }); await expect(grid).toHaveAttribute('data-columns', '3')
  await expect.poll(async () => (await grid.getByRole('listitem').first().boundingBox())!.width).toBeGreaterThanOrEqual(96)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('button', { name: '列表视图', exact: true }).click()
  await expect(page.locator('.drive-list-mobile-meta').first()).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('button', { name: '网格视图', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  const artifactDir = join(import.meta.dirname, '..', '..', 'docs', 'operations', 'artifacts', 'grid-2026-10-01', browserName); mkdirSync(artifactDir, { recursive: true }); const audits = []
  for (const theme of ['light', 'dark'] as const) for (const reduceTransparency of [false, true]) {
   await page.evaluate(value => window.xdrivePreferences.set(value), { theme, reduceTransparency })
   const audit = await new AxeBuilder({ page }).include('[aria-label="文件网格"]').include('[aria-label="视图与排序"]').analyze()
   expect(audit.violations.filter(issue => ['critical', 'serious'].includes(issue.impact!))).toEqual([])
   audits.push({ theme, reduceTransparency, violations: audit.violations }); await page.screenshot({ path: join(artifactDir, `${theme}-${reduceTransparency ? 'solid' : 'glass'}.png`), fullPage: true })
  }
  writeFileSync(join(artifactDir, 'accessibility.json'), JSON.stringify({ browser: browserName, physicalDevice: false, viewport: { width: 390, height: 844 }, audits }, null, 2))
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  for (const button of await grid.getByRole('button').all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await page.getByLabel('选择 folder1', { exact: true }).check(); await expect(page.getByRole('toolbar', { name: '批量操作' })).toContainText('已选 1 项')
  const first = grid.getByRole('listitem').first(); await first.focus(); await first.press('ArrowDown'); await expect(grid.getByRole('listitem').last()).toBeFocused()
  await grid.getByRole('listitem').last().press('Enter'); await expect(page.getByRole('heading', { name: 'folder4', exact: true })).toBeVisible()
 } finally { await server.close() }
})
