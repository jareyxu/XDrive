import { expect, test } from './legacy-list-test'
import { startIsolatedServer } from './isolated-server'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'

for (const choice of ['keep-both', 'overwrite', 'skip'] as const) {
  test(`single-file ${choice} confirmation after history navigation keeps its original upload destination`, async ({ page }) => {
    const server = await startIsolatedServer()
    try {
      await page.goto(`${server.baseURL}/setup#${server.token}`)
      await page.getByLabel('设置密码').fill('correct horse battery')
      await page.getByLabel('再次输入密码').fill('correct horse battery')
      await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
      await page.getByRole('button', { name: '创建加密云盘' }).click()
      await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
      const input = page.locator('input[type="file"]:not([webkitdirectory])').first()
      const file = (bytes: string) => ({ name: 'same-name.txt', mimeType: 'text/plain', buffer: Buffer.from(bytes) })
      await expect(page.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
      await input.setInputFiles(file('root contents must stay unchanged'))
      await expect(page.getByRole('status')).toContainText('上传完成。')
      page.once('dialog', dialog => void dialog.accept('original-destination'))
      await page.getByRole('button', { name: '新建文件夹', exact: true }).click()
      await page.getByRole('button', { name: 'original-destination', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'original-destination', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
      await input.setInputFiles(file('original destination bytes'))
      await expect(page.getByRole('status')).toContainText('上传完成。')
      await expect(page.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
      await input.setInputFiles(file('new chosen upload bytes'))
      const conflict = page.getByRole('dialog', { name: '同名文件冲突', exact: true })
      await expect(conflict).toBeVisible()
      await expect(conflict).toContainText('上传位置：我的文件 / original-destination')
      await page.goBack()
      await expect(page).toHaveURL(`${server.baseURL}/drive`)
      await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
      await expect(conflict).toContainText('上传位置：我的文件 / original-destination')
      await conflict.getByRole('button', { name: choice === 'keep-both' ? '保留两者' : choice === 'overwrite' ? '覆盖并移入回收站' : '跳过', exact: true }).click()
      await expect(conflict).toHaveCount(0)
      await expect(page.getByRole('status').filter({ hasText: choice === 'skip' ? '已跳过同名文件。' : '上传完成。' })).toContainText(choice === 'skip' ? '已跳过同名文件。' : '上传完成。')
      await expect(page).toHaveURL(`${server.baseURL}/drive`)
      await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'same-name (1).txt', exact: true })).toHaveCount(0)
      await page.getByRole('button', { name: 'same-name.txt', exact: true }).click()
      await expect(page.getByRole('dialog', { name: '预览 same-name.txt', exact: true })).toContainText('root contents must stay unchanged')
      await page.getByRole('button', { name: '关闭预览', exact: true }).click()
      await page.getByRole('button', { name: 'original-destination', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'original-destination', exact: true })).toBeVisible()
      const savedName = choice === 'keep-both' ? 'same-name (1).txt' : 'same-name.txt'
      await page.getByRole('button', { name: savedName, exact: true }).click()
      await expect(page.getByRole('dialog', { name: `预览 ${savedName}`, exact: true })).toContainText(choice === 'skip' ? 'original destination bytes' : 'new chosen upload bytes')
      await page.getByRole('button', { name: '关闭预览', exact: true }).click()
      if (choice === 'keep-both') {
        await page.getByRole('button', { name: 'same-name.txt', exact: true }).click()
        await expect(page.getByRole('dialog', { name: '预览 same-name.txt', exact: true })).toContainText('original destination bytes')
        await page.getByRole('button', { name: '关闭预览', exact: true }).click()
      }
      if (choice === 'overwrite') {
        await page.getByRole('button', { name: '回收站', exact: true }).click()
        await page.getByRole('button', { name: 'same-name.txt', exact: true }).click()
        await expect(page.getByRole('dialog', { name: '预览 same-name.txt', exact: true })).toContainText('original destination bytes')
      }
      expect(await page.title()).toBe('XDrive')
    } finally { await server.close() }
  })
}

for (const mode of ['files', 'folder'] as const) {
  for (const choice of ['keep-both', 'overwrite', 'skip'] as const) {
    test(`${mode} ${choice} after history navigation keeps the original encrypted hierarchy`, async ({ page }) => {
      const server = await startIsolatedServer()
      const fixture = mkdtempSync(join(tmpdir(), 'xdrive-conflict-navigation-'))
      try {
        await page.goto(`${server.baseURL}/setup#${server.token}`)
        await page.getByLabel('设置密码').fill('correct horse battery')
        await page.getByLabel('再次输入密码').fill('correct horse battery')
        await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
        await page.getByRole('button', { name: '创建加密云盘' }).click()
        await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
        page.once('dialog', dialog => void dialog.accept('batch-destination'))
        await page.getByRole('button', { name: '新建文件夹', exact: true }).click()
        await page.getByRole('button', { name: 'batch-destination', exact: true }).click()
        await expect(page.getByRole('heading', { name: 'batch-destination', exact: true })).toBeVisible()
        const upload = async (contents: string) => {
          if (mode === 'folder') {
            writeFileSync(join(fixture, 'same-name.txt'), contents)
            await expect(page.getByRole('button', { name: '\u4e0a\u4f20\u6587\u4ef6\u5939', exact: true })).toBeEnabled()
            await page.locator('input[webkitdirectory]').setInputFiles(fixture)
          } else {
            await expect(page.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
            await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles(['same-name.txt', 'second.txt'].map(name => ({ name, mimeType: 'text/plain', buffer: Buffer.from(`${contents} ${name}`) })))
          }
        }
        await upload('original hierarchy bytes')
        await expect(page.getByRole('status')).toContainText(mode === 'folder' ? '文件夹上传完成' : '批量上传完成')
        await upload('new hierarchy bytes')
        const conflict = page.getByRole('dialog', { name: mode === 'folder' ? '文件夹上传冲突' : '文件上传冲突', exact: true })
        await expect(conflict).toBeVisible()
        await expect(conflict).toContainText('上传位置：我的文件 / batch-destination')
        await page.goBack()
        await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
        await expect(conflict).toContainText('上传位置：我的文件 / batch-destination')
        await conflict.getByRole('button', { name: choice === 'keep-both' ? '全部保留两者' : choice === 'overwrite' ? '全部覆盖' : '全部跳过', exact: true }).click()
        await conflict.getByRole('button', { name: '确认处理并上传', exact: true }).click()
        await expect(conflict).toHaveCount(0)
        await expect(page.getByRole('status').filter({ hasText: mode === 'folder' ? '文件夹上传完成' : '批量上传完成' })).toBeVisible()
        await expect(page).toHaveURL(`${server.baseURL}/drive`)
        await expect(page.getByRole('button', { name: 'same-name.txt', exact: true })).toHaveCount(0)
        await expect(page.getByRole('button', { name: 'same-name (1).txt', exact: true })).toHaveCount(0)
        await expect(page.getByRole('button', { name: basename(fixture), exact: true })).toHaveCount(0)
        await page.getByRole('button', { name: 'batch-destination', exact: true }).click()
        await expect(page.getByRole('heading', { name: 'batch-destination', exact: true })).toBeVisible()
        if (mode === 'folder') {
          await page.getByRole('button', { name: basename(fixture), exact: true }).click()
        }
        const saved = choice === 'keep-both' ? 'same-name (1).txt' : 'same-name.txt'
        await page.getByRole('button', { name: saved, exact: true }).click()
        await expect(page.getByRole('dialog', { name: `预览 ${saved}`, exact: true })).toContainText(choice === 'skip' ? 'original hierarchy bytes' : 'new hierarchy bytes')
        await page.getByRole('button', { name: '关闭预览', exact: true }).click()
        if (mode === 'files') {
          const second = choice === 'keep-both' ? 'second (1).txt' : 'second.txt'
          await page.getByRole('button', { name: second, exact: true }).click()
          await expect(page.getByRole('dialog', { name: `预览 ${second}`, exact: true })).toContainText(choice === 'skip' ? 'original hierarchy bytes' : 'new hierarchy bytes')
          await page.getByRole('button', { name: '关闭预览', exact: true }).click()
        }
        if (choice === 'keep-both') {
          await page.getByRole('button', { name: 'same-name.txt', exact: true }).click()
          await expect(page.getByRole('dialog', { name: '预览 same-name.txt', exact: true })).toContainText('original hierarchy bytes')
          await page.getByRole('button', { name: '关闭预览', exact: true }).click()
        }
        if (choice === 'overwrite') {
          await page.getByRole('button', { name: '回收站', exact: true }).click()
          await page.getByRole('button', { name: 'same-name.txt', exact: true }).click()
          await expect(page.getByRole('dialog', { name: '预览 same-name.txt', exact: true })).toContainText('original hierarchy bytes')
        }
        expect(await page.title()).toBe('XDrive')
      } finally { await server.close(); rmSync(fixture, { recursive: true, force: true }) }
    })
  }
}

for (const change of ['replacement', 'name-collision', 'deleted-destination'] as const) {
  test(`single-file conflict rechecks ${change} from another real tab before writing its original destination`, async ({ page, context }) => {
    const server = await startIsolatedServer()
    const other = await context.newPage()
    try {
      await page.goto(`${server.baseURL}/setup#${server.token}`)
      await page.getByLabel('设置密码').fill('correct horse battery')
      await page.getByLabel('再次输入密码').fill('correct horse battery')
      await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
      await page.getByRole('button', { name: '创建加密云盘' }).click()
      await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
      const file = (name: string, bytes: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(bytes) })
      const input = page.locator('input[type="file"]:not([webkitdirectory])').first()
      await expect(page.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
      await input.setInputFiles(file('same-name.txt', 'root stays unchanged'))
      await expect(page.getByRole('status')).toContainText('上传完成。')
      page.once('dialog', dialog => void dialog.accept('original-destination'))
      await page.getByRole('button', { name: '新建文件夹', exact: true }).click()
      await page.getByRole('button', { name: 'original-destination', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'original-destination', exact: true })).toBeVisible()
      const destinationURL = page.url()
      await expect(page.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
      await input.setInputFiles(file('same-name.txt', 'old destination bytes'))
      await expect(page.getByRole('status')).toContainText('上传完成。')
      await expect(page.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
      await input.setInputFiles(file('same-name.txt', 'first tab chosen bytes'))
      const conflict = page.getByRole('dialog', { name: '同名文件冲突', exact: true })
      await expect(conflict).toBeVisible()
      await page.goBack()
      await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
      await other.goto(destinationURL)
      await expect(other.getByRole('heading', { name: '重新解锁云盘', exact: true })).toBeVisible()
      await other.getByLabel('密码', { exact: true }).fill('correct horse battery')
      await other.getByRole('button', { name: '解锁云盘', exact: true }).click()
      await expect(other.getByRole('heading', { name: 'original-destination', exact: true })).toBeVisible()
      const changedBytes = 'another tab has explicitly replaced this file with different longer contents'
      if (change === 'deleted-destination') {
        await other.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的文件', exact: true }).click()
        await expect(other.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
        other.once('dialog', dialog => void dialog.accept())
        await other.getByRole('button', { name: '移到回收站 original-destination', exact: true }).click()
        await expect(other.getByRole('button', { name: 'original-destination', exact: true })).toHaveCount(0)
      } else {
        await expect(other.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
        await other.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles(file(change === 'replacement' ? 'same-name.txt' : 'same-name (1).txt', changedBytes))
        if (change === 'replacement') await other.getByRole('dialog', { name: '同名文件冲突', exact: true }).getByRole('button', { name: '覆盖并移入回收站', exact: true }).click()
        await expect(other.getByRole('status').filter({ hasText: '上传完成。' })).toBeVisible()
      }
      const writes: string[] = []
      page.on('request', request => { if (['POST', 'PUT', 'DELETE'].includes(request.method())) writes.push(new URL(request.url()).pathname) })
      await conflict.getByRole('button', { name: change === 'replacement' ? '覆盖并移入回收站' : '保留两者', exact: true }).click()
      if (change === 'deleted-destination') {
        await expect(conflict).toHaveCount(0)
        await expect(page.getByRole('alert')).toContainText('回收站')
        expect(writes).toEqual([])
      } else {
        await expect(conflict).toBeVisible()
        await expect(conflict).toContainText('上传位置：我的文件 / original-destination')
        if (change === 'replacement') await expect(conflict).toContainText(`文件 · ${Buffer.byteLength(changedBytes)} B`)
        expect(writes).toEqual([])
        await conflict.getByRole('button', { name: change === 'replacement' ? '覆盖并移入回收站' : '保留两者', exact: true }).click()
        await expect(conflict).toHaveCount(0)
        await expect(page.getByRole('status').filter({ hasText: '上传完成。' })).toBeVisible()
        expect(writes.some(path => path === '/api/v1/metadata/transactions')).toBe(true)
      }
      await expect(page).toHaveURL(`${server.baseURL}/drive`)
      await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'same-name (1).txt', exact: true })).toHaveCount(0)
      await page.getByRole('button', { name: 'same-name.txt', exact: true }).click()
      await expect(page.getByRole('dialog', { name: '预览 same-name.txt', exact: true })).toContainText('root stays unchanged')
      await page.getByRole('button', { name: '关闭预览', exact: true }).click()
      if (change !== 'deleted-destination') {
        await page.getByRole('button', { name: 'original-destination', exact: true }).click()
        await expect(page.getByRole('heading', { name: 'original-destination', exact: true })).toBeVisible()
        const saved = change === 'replacement' ? 'same-name.txt' : 'same-name (2).txt'
        await page.getByRole('button', { name: saved, exact: true }).click()
        await expect(page.getByRole('dialog', { name: `预览 ${saved}`, exact: true })).toContainText('first tab chosen bytes')
        await page.getByRole('button', { name: '关闭预览', exact: true }).click()
        if (change === 'name-collision') {
          await page.getByRole('button', { name: 'same-name (1).txt', exact: true }).click()
          await expect(page.getByRole('dialog', { name: '预览 same-name (1).txt', exact: true })).toContainText(changedBytes)
        }
      } else {
        await page.getByRole('button', { name: '回收站', exact: true }).click()
        await page.getByRole('button', { name: 'original-destination', exact: true }).click()
        await expect(page.getByRole('button', { name: 'same-name (1).txt', exact: true })).toHaveCount(0)
        await page.getByRole('button', { name: 'same-name.txt', exact: true }).click()
        await expect(page.getByRole('dialog', { name: '预览 same-name.txt', exact: true })).toContainText('old destination bytes')
      }
      expect(await page.title()).toBe('XDrive')
    } finally { await other.close(); await server.close() }
  })
}

test('an upload replacing a folder invalidates that folder route opened while its final commit is pending', async ({ page }) => {
  const server = await startIsolatedServer()
  let release = () => {}, reached!: () => void
  const waiting = new Promise<void>(resolve => { reached = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  try {
    await page.goto(`${server.baseURL}/setup#${server.token}`)
    await page.getByLabel('设置密码').fill('correct horse battery')
    await page.getByLabel('再次输入密码').fill('correct horse battery')
    await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
    await page.getByRole('button', { name: '创建加密云盘' }).click()
    await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
    page.once('dialog', dialog => void dialog.accept('replace-folder.txt'))
    await page.getByRole('button', { name: '新建文件夹', exact: true }).click()
    await page.getByRole('button', { name: 'replace-folder.txt', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'replace-folder.txt', exact: true })).toBeVisible()
    const input = page.locator('input[type="file"]:not([webkitdirectory])').first()
    await expect(page.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
    await input.setInputFiles({ name: 'old-private.txt', mimeType: 'text/plain', buffer: Buffer.from('original subtree bytes') })
    await expect(page.getByRole('status')).toContainText('上传完成。')
    await page.locator('.breadcrumbs').getByRole('button', { name: '我的文件', exact: true }).click()
    await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
    await page.route('**/api/v1/metadata/transactions', async route => {
      reached(); await gate
      await route.continue().catch(() => undefined)
    })
    await expect(page.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
    await input.setInputFiles({ name: 'replace-folder.txt', mimeType: 'text/plain', buffer: Buffer.from('new replacement bytes') })
    await page.getByRole('dialog', { name: '同名文件冲突', exact: true }).getByRole('button', { name: '覆盖并移入回收站', exact: true }).click()
    await waiting
    await page.getByRole('button', { name: 'replace-folder.txt', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'replace-folder.txt', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'old-private.txt', exact: true })).toBeVisible()
    const folderURL = page.url()
    await page.getByRole('button', { name: 'old-private.txt', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '预览 old-private.txt', exact: true })).toContainText('original subtree bytes')
    release()
    await expect(page.getByRole('alert')).toContainText('回收站')
    await expect(page).toHaveURL(folderURL)
    await expect(page.getByRole('dialog', { name: '预览 old-private.txt', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'old-private.txt', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '上传', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '新建文件夹', exact: true })).toBeDisabled()
    await page.unroute('**/api/v1/metadata/transactions')
    await page.locator('.breadcrumbs').getByRole('button', { name: '我的文件', exact: true }).click()
    await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'replace-folder.txt', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '预览 replace-folder.txt', exact: true })).toContainText('new replacement bytes')
    await page.getByRole('button', { name: '关闭预览', exact: true }).click()
    await page.getByRole('button', { name: '回收站', exact: true }).click()
    await page.getByRole('button', { name: 'replace-folder.txt', exact: true }).click()
    await page.getByRole('button', { name: 'old-private.txt', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '预览 old-private.txt', exact: true })).toContainText('original subtree bytes')
  } finally { release(); await server.close() }
})

test('a valid immutable file preview survives an unrelated upload revision while its route revalidates', async ({ page }) => {
  const server = await startIsolatedServer()
  let release = () => {}, reached!: () => void
  const waiting = new Promise<void>(resolve => { reached = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  try {
    await page.goto(`${server.baseURL}/setup#${server.token}`)
    await page.getByLabel('设置密码').fill('correct horse battery')
    await page.getByLabel('再次输入密码').fill('correct horse battery')
    await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
    await page.getByRole('button', { name: '创建加密云盘' }).click()
    await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
    const input = page.locator('input[type="file"]:not([webkitdirectory])').first()
    await expect(page.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
    await input.setInputFiles({ name: 'unchanged.txt', mimeType: 'text/plain', buffer: Buffer.from('immutable preview bytes') })
    await expect(page.getByRole('status')).toContainText('上传完成。')
    await expect(page.getByRole('button', { name: '上传', exact: true })).toBeEnabled()
    await page.route('**/api/v1/metadata/transactions', async route => {
      reached(); await gate
      await route.continue().catch(() => undefined)
    })
    await expect(page.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
    await input.setInputFiles({ name: 'unrelated.txt', mimeType: 'text/plain', buffer: Buffer.from('new independent bytes') })
    await waiting
    await page.getByRole('button', { name: 'unchanged.txt', exact: true }).click()
    const preview = page.getByRole('dialog', { name: '预览 unchanged.txt', exact: true })
    await expect(preview).toContainText('immutable preview bytes')
    release()
    await expect(page.getByRole('status').filter({ hasText: '上传完成。' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'unrelated.txt', exact: true })).toBeVisible()
    await expect(preview).toContainText('immutable preview bytes')
    await page.getByRole('button', { name: '关闭预览', exact: true }).click()
    await page.getByRole('button', { name: 'unrelated.txt', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '预览 unrelated.txt', exact: true })).toContainText('new independent bytes')
  } finally { release(); await server.close() }
})
