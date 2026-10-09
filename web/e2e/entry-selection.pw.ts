import { expect, test, type Page } from '@playwright/test'
import { startIsolatedServer } from './isolated-server'
const password = 'correct horse battery'
async function setup(page: Page, baseURL: string, token: string) {
 await page.goto(`${baseURL}/setup#${token}`)
 await page.getByLabel('设置密码').fill(password); await page.getByLabel('再次输入密码').fill(password)
 await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check(); await page.getByRole('button', { name: '创建加密云盘' }).click()
 await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 30000 })
 for (const name of ['folder1', 'folder2', 'folder3', 'folder4', 'folder5']) { page.once('dialog', dialog => void dialog.accept(name)); await page.getByRole('button', { name: '新建文件夹', exact: true }).click(); await expect(page.getByRole('button', { name, exact: true })).toBeVisible() }
}
for (const view of ['grid', 'list']) test(`${view} modifiers/Space/all use current order and keep cross-directory selection without opening`, async ({ page }) => {
 test.setTimeout(120000); const server = await startIsolatedServer()
 try {
  await setup(page, server.baseURL, server.token)
  if (view === 'list') await page.getByRole('button', { name: '列表视图', exact: true }).click()
  const writes: string[] = []
  const countWrites = (request: { method(): string; url(): string }) => { if (['POST', 'PUT', 'DELETE'].includes(request.method()) && request.url().includes('/api/v1/')) writes.push(request.url()) }
  page.on('request', countWrites)
  const selected = page.getByRole('toolbar', { name: '批量操作' })
  await page.getByRole('button', { name: 'folder1', exact: true }).click({ modifiers: ['ControlOrMeta'] }); await expect(selected).toContainText('已选 1 项')
  await page.getByRole('button', { name: 'folder4', exact: true }).click({ modifiers: ['Shift'] }); await expect(selected).toContainText('已选 4 项')
  await page.getByRole('button', { name: 'folder2', exact: true }).click({ modifiers: ['Meta'] }); await expect(selected).toContainText('已选 3 项')
  const last = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'folder5', exact: true }) }); await last.focus(); await last.press('Space'); await expect(selected).toContainText('已选 4 项')
  await page.getByLabel('选择 folder1', { exact: true }).focus(); await page.keyboard.press('ControlOrMeta+a'); await expect(selected).toContainText('已选 5 项'); expect(writes).toEqual([]); page.off('request', countWrites)
  await page.getByRole('button', { name: '取消选择', exact: true }).click(); await expect(selected).toHaveCount(0)
  await page.getByRole('button', { name: 'folder1', exact: true }).click({ modifiers: ['ControlOrMeta'] })
  await page.getByRole('button', { name: 'folder2', exact: true }).click(); await expect(page.getByRole('heading', { name: 'folder2', exact: true })).toBeVisible()
  page.once('dialog', dialog => void dialog.accept('child')); await page.getByRole('button', { name: '新建文件夹', exact: true }).click(); await expect(page.getByRole('button', { name: 'child', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'child', exact: true }).click({ modifiers: ['Shift'] }); await expect(selected).toContainText('已选 2 项')
  await page.getByLabel('选择 child', { exact: true }).focus(); await page.keyboard.press('Meta+a'); await expect(selected).toContainText('已选 2 项')
  await page.getByRole('button', { name: 'child', exact: true }).focus(); await page.keyboard.press('Escape'); await expect(selected).toHaveCount(0)
  await page.getByRole('button', { name: '锁定云盘', exact: true }).click(); await expect(page.locator('body')).not.toContainText('folder1'); await expect(page.getByRole('listitem')).toHaveCount(0)
 } finally { await server.close() }
})
test.describe('touch selection', () => {
 test.skip(({ browserName }) => browserName !== 'chromium', 'Trusted held touch/drag/cancel injection requires Chromium CDP; this is an unverified input path on other engines.')
 test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })
 for (const view of ['grid', 'list']) test(`${view} trusted long press selects, suppresses opening, and drag/cancel cannot leave a delayed selection`, async ({ page, context }) => {
  test.setTimeout(120000); const server = await startIsolatedServer()
  try {
   await setup(page, server.baseURL, server.token)
   if (view === 'list') await page.getByRole('button', { name: '列表视图', exact: true }).click()
   const session = await context.newCDPSession(page)
   const target = page.getByRole('button', { name: view === 'grid' ? '打开 folder1' : 'folder1', exact: true })
   const rect = (await target.boundingBox())!, point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
   await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] }); await page.waitForTimeout(600)
   await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
   const selected = page.getByRole('toolbar', { name: '批量操作' }); await expect(selected).toContainText('已选 1 项'); await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible(); await expect(page.getByRole('dialog')).toHaveCount(0)
   const navigation = page.getByRole('navigation', { name: '主导航' })
   const toolbarBox = (await selected.boundingBox())!, navigationBox = (await navigation.boundingBox())!
   expect(toolbarBox.x).toBeGreaterThanOrEqual(0); expect(toolbarBox.x + toolbarBox.width).toBeLessThanOrEqual(390)
   expect(toolbarBox.y + toolbarBox.height).toBeLessThanOrEqual(navigationBox.y)
   for (const button of await selected.getByRole('button').all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44)
   await page.setViewportSize({ width: 320, height: 720 })
   const narrowBox = (await selected.boundingBox())!
   expect(narrowBox.x).toBeGreaterThanOrEqual(0); expect(narrowBox.x + narrowBox.width).toBeLessThanOrEqual(320)
   expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
   const secondButton = page.getByRole('button', { name: view === 'grid' ? '打开 folder2' : 'folder2', exact: true })
   // Fixed bottom actions do not reduce IntersectionObserver visibility.
   // Explicitly scroll with the app's selection scroll margin, then prove hit testing.
   await secondButton.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }))
   const secondBox = (await secondButton.boundingBox())!, secondPoint = { x: secondBox.x + secondBox.width / 2, y: secondBox.y + secondBox.height / 2 }
   const hit = await page.evaluate(({ x, y }) => { const button = document.elementFromPoint(x, y)?.closest('button'); return button?.getAttribute('aria-label') || button?.textContent?.trim() }, secondPoint)
   expect(hit).toBe(view === 'grid' ? '打开 folder2' : 'folder2')
   await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [secondPoint] }); await page.waitForTimeout(80)
   await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
   await expect(selected).toContainText('已选 2 项'); await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
   await page.getByRole('button', { name: '取消选择', exact: true }).tap(); await expect(selected).toHaveCount(0)
   const next = (await target.boundingBox())!, position = { x: next.x + next.width / 2, y: next.y + next.height / 2 }
   await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [position] }); await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: position.x, y: position.y + 25 }] }); await session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }); await page.waitForTimeout(650); await expect(selected).toHaveCount(0)
   await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [position] }); await page.waitForTimeout(100); await page.getByRole('button', { name: '锁定云盘', exact: true }).click(); await session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }); await page.waitForTimeout(550)
   await expect(page.getByRole('button', { name: '解锁云盘', exact: true })).toBeVisible(); await expect(page.getByRole('listitem')).toHaveCount(0); await expect(page.locator('body')).not.toContainText('folder1')
  } finally { await server.close() }
 })
})
