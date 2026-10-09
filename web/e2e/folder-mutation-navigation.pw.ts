import { expect, test } from './legacy-list-test'
import { startIsolatedServer } from './isolated-server'

for (const mode of ['create', 'rename', 'move', 'parent', 'restore', 'delete', 'batch-delete'] as const) {
  test(`${mode} committed after history navigation cannot replace the current directory`, async ({ page }) => {
    const server = await startIsolatedServer()
    let release = () => {}, reached!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const waiting = new Promise<void>(resolve => { reached = resolve })
    try {
      await page.goto(`${server.baseURL}/setup#${server.token}`)
      await page.getByLabel('设置密码').fill('correct horse battery')
      await page.getByLabel('再次输入密码').fill('correct horse battery')
      await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
      await page.getByRole('button', { name: '创建加密云盘' }).click()
      await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
      for (const name of ['destination', 'source']) {
        page.once('dialog', dialog => void dialog.accept(name))
        await page.getByRole('button', { name: '新建文件夹', exact: true }).click()
        await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
      }
      await page.getByRole('button', { name: 'source', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'source', exact: true })).toBeVisible()
      await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'private-original.txt', mimeType: 'text/plain', buffer: Buffer.from('actual encrypted mutation navigation fixture') })
      await expect(page.getByRole('status')).toContainText('上传完成。')
      if (mode === 'restore') {
        page.once('dialog', dialog => void dialog.accept())
        await page.getByRole('button', { name: '移到回收站 private-original.txt', exact: true }).click()
        await expect(page.getByRole('status')).toContainText('已移到回收站。')
        await page.getByRole('button', { name: '回收站', exact: true }).click()
        await expect(page.getByRole('button', { name: '恢复 private-original.txt', exact: true })).toBeVisible()
      }
      await page.route('**/api/v1/metadata/transactions', async route => {
        const response = await route.fetch()
        expect(response.status()).toBe(200)
        reached(); await gate
        await route.fulfill({ response }).catch(() => undefined)
      })
      if (mode === 'create') {
        page.once('dialog', dialog => void dialog.accept('created-child'))
        await page.getByRole('button', { name: '新建文件夹', exact: true }).click()
      } else if (mode === 'rename') {
        page.once('dialog', dialog => void dialog.accept('private-renamed.txt'))
        await page.getByRole('button', { name: '重命名 private-original.txt', exact: true }).click()
      } else if (mode === 'move') {
        await page.getByRole('checkbox', { name: '选择 private-original.txt', exact: true }).check()
        await page.getByRole('button', { name: '批量移动', exact: true }).click()
        const dialog = page.getByRole('dialog', { name: '移动 private-original.txt', exact: true })
        await dialog.getByRole('button', { name: '我的文件', exact: true }).click()
        await dialog.getByRole('button', { name: 'destination', exact: true }).click()
        await dialog.getByRole('button', { name: '移动到此文件夹', exact: true }).click()
      } else if (mode === 'parent') {
        await page.getByRole('button', { name: '移动到上一级 private-original.txt', exact: true }).click()
      } else if (mode === 'restore') {
        await page.getByRole('button', { name: '恢复 private-original.txt', exact: true }).click()
      } else if (mode === 'delete') {
        page.once('dialog', dialog => void dialog.accept())
        await page.getByRole('button', { name: '移到回收站 private-original.txt', exact: true }).click()
      } else {
        await page.getByRole('checkbox', { name: '选择 private-original.txt', exact: true }).check()
        await page.getByRole('button', { name: '移到回收站所选', exact: true }).click()
        await page.getByRole('dialog', { name: '将所选项目移到回收站', exact: true }).getByRole('button', { name: '确认移到回收站', exact: true }).click()
      }
      await waiting
      if (mode === 'restore') await page.getByRole('button', { name: '我的文件', exact: true }).click()
      else await page.goBack()
      await expect(page).toHaveURL(`${server.baseURL}/drive`)
      await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
      release()
      const completed = mode === 'create' ? '文件夹已创建。' : mode === 'rename' ? '重命名完成。' : mode === 'move' ? '项目已移动。' : mode === 'parent' ? '项目已移动到上一级文件夹。' : mode === 'restore' ? '项目已恢复。' : mode === 'delete' ? '已移到回收站。' : '已将 1 个顶层项目原子移到回收站。'
      await expect(page.getByRole('status').filter({ hasText: completed })).toContainText(completed)
      await expect(page).toHaveURL(`${server.baseURL}/drive`)
      await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'source', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'private-original.txt', exact: true })).toHaveCount(mode === 'parent' ? 1 : 0)
      await page.unroute('**/api/v1/metadata/transactions')
      await page.getByRole('button', { name: 'source', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'source', exact: true })).toBeVisible()
      if (mode === 'create') {
        await expect(page.getByRole('button', { name: 'created-child', exact: true })).toBeVisible()
        await expect(page.getByRole('button', { name: 'private-original.txt', exact: true })).toBeVisible()
      } else if (mode === 'restore') {
        await expect(page.getByRole('button', { name: 'private-original.txt', exact: true })).toBeVisible()
      } else if (mode === 'rename') {
        await expect(page.getByRole('button', { name: 'private-renamed.txt', exact: true })).toBeVisible()
        await expect(page.getByRole('button', { name: 'private-original.txt', exact: true })).toHaveCount(0)
      } else {
        await expect(page.getByRole('button', { name: 'private-original.txt', exact: true })).toHaveCount(0)
        if (mode === 'parent') {
          await page.locator('.breadcrumbs').getByRole('button', { name: '我的文件', exact: true }).click()
          await expect(page.getByRole('button', { name: 'private-original.txt', exact: true })).toBeVisible()
        } else if (mode === 'move') {
          await page.locator('.breadcrumbs').getByRole('button', { name: '我的文件', exact: true }).click()
          await page.getByRole('button', { name: 'destination', exact: true }).click()
          await expect(page.getByRole('button', { name: 'private-original.txt', exact: true })).toBeVisible()
        } else {
          await page.getByRole('button', { name: '回收站', exact: true }).click()
          await expect(page.locator('body')).toContainText('private-original.txt')
        }
      }
      expect(await page.title()).toBe('XDrive')
    } finally { release(); await server.close() }
  })
}

test('move to parent uses the immediate ancestor at nested depth, preserving opaque navigation', async ({ page }) => {
  const server = await startIsolatedServer()
  try {
    await page.goto(`${server.baseURL}/setup#${server.token}`)
    await page.getByLabel('设置密码').fill('correct horse battery')
    await page.getByLabel('再次输入密码').fill('correct horse battery')
    await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
    await page.getByRole('button', { name: '创建加密云盘' }).click()
    await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
    for (const name of ['outer', 'inner']) {
      page.once('dialog', dialog => void dialog.accept(name))
      await page.getByRole('button', { name: '新建文件夹', exact: true }).click()
      await page.getByRole('button', { name, exact: true }).click()
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
    }
    const innerURL = page.url()
    await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'nested-parent.txt', mimeType: 'text/plain', buffer: Buffer.from('actual encrypted immediate parent fixture') })
    await expect(page.getByRole('status')).toContainText('上传完成。')
    await page.getByRole('button', { name: '移动到上一级 nested-parent.txt', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('项目已移动到上一级文件夹。')
    await expect(page).toHaveURL(innerURL)
    await expect(page.getByRole('button', { name: 'nested-parent.txt', exact: true })).toHaveCount(0)
    await page.locator('.breadcrumbs').getByRole('button', { name: 'outer', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'outer', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'nested-parent.txt', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'inner', exact: true })).toBeVisible()
    await page.locator('.breadcrumbs').getByRole('button', { name: '我的文件', exact: true }).click()
    await expect(page.getByRole('button', { name: 'nested-parent.txt', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'outer', exact: true })).toBeVisible()
  } finally { await server.close() }
})
