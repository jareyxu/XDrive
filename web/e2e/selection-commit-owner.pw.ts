import { expect, test, type Page } from './legacy-list-test'
import { startIsolatedServer } from './isolated-server'

async function setup(page: Page, url: string, token: string) {
  await page.goto(`${url}/setup#${token}`)
  await page.getByLabel('设置密码').fill('correct horse battery')
  await page.getByLabel('再次输入密码').fill('correct horse battery')
  await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
  await page.getByRole('button', { name: '创建加密云盘' }).click()
  await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 30000 })
}
async function upload(page: Page, name: string) {
  const input = page.locator('input[type="file"]:not([webkitdirectory])').first()
  await input.setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(`bytes:${name}`) })
  await expect(page.getByRole('status')).toContainText('上传完成。', { timeout: 30000 })
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
  await expect(input).toBeEnabled()
}

for (const operation of ['move', 'delete'] as const) test(`${operation} completion preserves a new selection made after the actual transaction committed`, async ({ page }) => {
  test.setTimeout(120000)
  const server = await startIsolatedServer()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let committed = false
  try {
    await setup(page, server.baseURL, server.token)
    page.once('dialog', dialog => void dialog.accept('target'))
    await page.getByRole('button', { name: '新建文件夹', exact: true }).click()
    await expect(page.getByRole('button', { name: 'target', exact: true })).toBeVisible()
    await upload(page, 'acted.txt'); await upload(page, 'keep.txt')
    await page.getByLabel('选择 acted.txt', { exact: true }).check()
    await page.route('**/api/v1/metadata/transactions', async route => {
      const response = await route.fetch()
      expect(response.status()).toBe(200)
      committed = true
      await held
      await route.fulfill({ response })
    }, { times: 1 })
    if (operation === 'move') {
      const row = (name: string) => page.locator('.entry-row').filter({ has: page.getByRole('button', { name, exact: true }) })
      const source = (await row('acted.txt').boundingBox())!, target = (await row('target').boundingBox())!
      await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2); await page.mouse.down()
      await page.mouse.move(source.x + source.width / 2 + 12, source.y + source.height / 2 + 4)
      await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 })
      await expect(row('target')).toContainText('移到「target」')
      await page.mouse.up()
    } else {
      await page.getByRole('button', { name: '移到回收站所选', exact: true }).click()
      await page.getByRole('dialog', { name: '将所选项目移到回收站', exact: true }).getByRole('button', { name: '确认移到回收站', exact: true }).click()
    }
    await expect.poll(() => committed).toBe(true)
    await page.getByRole('button', { name: '取消选择', exact: true }).click()
    await page.getByLabel('选择 keep.txt', { exact: true }).check()
    await expect(page.getByRole('toolbar', { name: '批量操作' })).toContainText('已选 1 项')
    release()
    await expect(page.getByRole('status')).toContainText(operation === 'move' ? '项目已移动。' : '原子移到回收站。', { timeout: 30000 })
    await expect(page.getByRole('button', { name: 'acted.txt', exact: true })).toHaveCount(0)
    await expect(page.getByLabel('选择 keep.txt', { exact: true })).toBeChecked()
    await expect(page.getByRole('toolbar', { name: '批量操作' })).toContainText('已选 1 项')
    await page.getByRole('button', { name: 'keep.txt', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '预览 keep.txt', exact: true })).toContainText('bytes:keep.txt')
    await page.keyboard.press('Escape')
    if (operation === 'move') await page.getByRole('button', { name: 'target', exact: true }).click()
    else await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '回收站', exact: true }).click()
    await expect(page.getByRole('button', { name: 'acted.txt', exact: true })).toBeVisible({ timeout: 30000 })
    await page.getByRole('button', { name: 'acted.txt', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '预览 acted.txt', exact: true })).toContainText('bytes:acted.txt')
  } finally { release(); await server.close() }
})
