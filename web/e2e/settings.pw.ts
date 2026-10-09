import type {} from '../src/preferences/preferences'
import { expect, test } from './legacy-list-test'
import AxeBuilder from '@axe-core/playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startIsolatedServer } from './isolated-server'
const password = 'correct horse battery'

test('settings applies system/explicit themes, persists only preferences, synchronizes tabs and retains the locked route', async ({ page, context }) => {
 test.setTimeout(120000)
 const server = await startIsolatedServer()
 try {
  const external: string[] = [], resources: string[] = []
  page.on('request', request => { resources.push(request.url()); if (/^https?:/u.test(request.url()) && new URL(request.url()).origin !== server.baseURL) external.push(request.url()) })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto(`${server.baseURL}/setup#${server.token}`)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByLabel('设置密码').fill(password); await page.getByLabel('再次输入密码').fill(password)
  await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check(); await page.getByRole('button', { name: '创建加密云盘' }).click()
  await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 30000 })
  expect(resources.filter(url => /SettingsScreen-|pdf-|zip\./u.test(url))).toEqual([])
  const nav = page.getByRole('navigation', { name: '主导航' })
  await nav.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page).toHaveURL(`${server.baseURL}/settings`)
  const screen = page.getByRole('region', { name: '云盘设置' })
  await expect(screen).toContainText('dev（开发构建）'); await expect(screen).toContainText('从未备份。')
  await screen.getByRole('button', { name: '浅色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.getByLabel('玻璃通透度').fill('1')
  await page.getByLabel('降低透明度', { exact: false }).check()
  await expect(page.locator('.sidebar')).toHaveCSS('backdrop-filter', 'none')
  await page.getByLabel('备份提醒阈值', { exact: true }).selectOption('7')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('xdrive.preferences.v1')!))).toEqual({ theme: 'light', clarity: 1, reduceTransparency: true, backupReminderDays: 7, uploadConcurrency: 2, view: 'list' })
  await screen.getByRole('button', { name: '修改密码', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '修改密码', exact: true })).toContainText('修改密码不会更换主密钥')
  await page.getByRole('dialog', { name: '修改密码', exact: true }).getByRole('button', { name: '取消', exact: true }).click()
  const other = await context.newPage(); await other.goto(`${server.baseURL}/settings`)
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'light')
  await other.evaluate(() => window.xdrivePreferences.set({ theme: 'dark', reduceTransparency: false }))
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(screen.getByRole('button', { name: '深色', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.reload(); await expect(page.getByRole('button', { name: '解锁云盘', exact: true })).toBeVisible()
  await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible()
  await expect(page.getByLabel('备份提醒阈值', { exact: true })).toHaveValue('7')
  await page.getByRole('button', { name: '锁定云盘', exact: true }).click()
  await expect(page.getByRole('button', { name: '解锁云盘', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: '云盘设置' })).toHaveCount(0)
  expect(await page.title()).toBe('XDrive'); expect(external).toEqual([]); await other.close()
 } finally { await server.close() }
})

test('mobile settings has solid grouped rows, contrast/focus targets and explicit read failure without fake values', async ({ page, browserName }) => {
 test.setTimeout(120000)
 const server = await startIsolatedServer()
 try {
  await page.goto(`${server.baseURL}/setup#${server.token}`)
  await page.getByLabel('设置密码').fill(password); await page.getByLabel('再次输入密码').fill(password)
  await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check(); await page.getByRole('button', { name: '创建加密云盘' }).click()
  await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 30000 })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '设置', exact: true }).click()
  const screen = page.getByRole('region', { name: '云盘设置' })
  await expect(screen).toContainText('dev（开发构建）')
  const directory = join(import.meta.dirname, '..', '..', 'docs', 'operations', 'artifacts', 'settings-2026-10-01', browserName); mkdirSync(directory, { recursive: true })
  const results = []
  for (const theme of ['浅色', '深色']) {
   await screen.getByRole('button', { name: theme, exact: true }).click()
   for (const clarity of ['0', '1']) {
    await page.getByLabel('玻璃通透度').fill(clarity)
    const audit = await new AxeBuilder({ page }).include('section[aria-label="云盘设置"]').analyze()
    expect(audit.violations.filter(issue => ['critical', 'serious'].includes(issue.impact!))).toEqual([])
    results.push({ theme, clarity, transparency: 'glass', violations: audit.violations })
    await page.screenshot({ path: join(directory, `${theme === '浅色' ? 'light' : 'dark'}-${clarity}.png`), fullPage: true })
   }
   await page.getByLabel('降低透明度', { exact: false }).check()
   const solid = await new AxeBuilder({ page }).include('section[aria-label="云盘设置"]').analyze()
   expect(solid.violations.filter(issue => ['critical', 'serious'].includes(issue.impact!))).toEqual([])
   await expect(page.locator('.sidebar')).toHaveCSS('backdrop-filter', 'none')
   results.push({ theme, clarity: '1', transparency: 'solid', violations: solid.violations })
   await page.screenshot({ path: join(directory, `${theme === '浅色' ? 'light' : 'dark'}-solid.png`), fullPage: true })
   await page.getByLabel('降低透明度', { exact: false }).uncheck()
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  for (const button of await screen.getByRole('button').all()) { expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44); expect(await button.evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(12) }
  await page.route('**/api/v1/system/info', route => route.abort('failed'))
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的文件', exact: true }).click()
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('无法更新备份或版本信息')
  await expect(screen.locator('dd').first()).toHaveText('不可用')
  await page.unroute('**/api/v1/system/info'); await page.getByRole('button', { name: '重新读取', exact: true }).click()
  await expect(screen).toContainText('dev（开发构建）')
  writeFileSync(join(directory, 'accessibility.json'), JSON.stringify({ browser: browserName, physicalDevice: false, viewport: { width: 390, height: 844 }, results }, null, 2))
 } finally { await server.close() }
})
