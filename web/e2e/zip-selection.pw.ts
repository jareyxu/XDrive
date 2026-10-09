import { expect, test, type Page } from './legacy-list-test'
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js'
import { startIsolatedServer } from './isolated-server'

async function createFolder(page: Page, name: string) {
  page.once('dialog', (dialog) => void dialog.accept(name))
  await page.getByRole('button', { name: '新建文件夹' }).click()
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
}
async function upload(page: Page, name: string, text: string) {
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) })
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
}
async function root(page: Page) {
  await page.locator('.breadcrumbs').getByRole('button', { name: '我的文件', exact: true }).click()
  await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
}

test('ZIP selections survive navigation, deduplicate ancestors, and reject stale or conflicting roots', async ({ page }) => {
  test.setTimeout(120_000)
  const server = await startIsolatedServer()
  try {
    await page.addInitScript(() => Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined }))
    await page.goto(`${server.baseURL}/setup#${server.token}`)
    await page.getByLabel('管理员用户名').fill('admin')
    await page.getByLabel('设置密码').fill('correct horse battery')
    await page.getByLabel('再次输入密码').fill('correct horse battery')
    await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
    await page.getByRole('button', { name: '创建加密云盘' }).click()
    await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
    await createFolder(page, '项目')
    await page.getByRole('button', { name: '项目', exact: true }).click()
    await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible()
    await upload(page, 'inside.txt', 'inside bytes')
    await createFolder(page, '空目录')
    await root(page)
    await upload(page, 'outside.txt', 'outside bytes')
    await upload(page, 'unselected.txt', 'must not appear')
    await page.getByRole('checkbox', { name: '选择 项目', exact: true }).check()
    await page.getByRole('button', { name: '项目', exact: true }).click()
    await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible()
    await page.getByRole('checkbox', { name: '选择 inside.txt', exact: true }).check()
    await page.getByRole('checkbox', { name: '选择 空目录', exact: true }).check()
    await root(page)
    await page.getByRole('checkbox', { name: '选择 outside.txt', exact: true }).check()
    await expect(page.getByText('已选 4 项', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '批量移动', exact: true })).toBeEnabled()
    const pending = page.waitForEvent('download')
    await page.getByRole('button', { name: '下载所选为 ZIP', exact: true }).click()
    const download = await pending
    expect(download.suggestedFilename()).toBe('XDrive-selection.zip')
    const stream = await download.createReadStream()
    if (!stream) throw new Error('ZIP stream missing')
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    const reader = new ZipReader(new Uint8ArrayReader(Buffer.concat(chunks)))
    try {
      const entries = await reader.getEntries()
      expect(entries.map((entry) => entry.filename).sort()).toEqual(['outside.txt', '项目/', '项目/inside.txt', '项目/空目录/'].sort())
      for (const entry of entries) {
        if (!entry.directory) expect(new TextDecoder().decode(await entry.getData!(new Uint8ArrayWriter()))).toBe(entry.filename === 'outside.txt' ? 'outside bytes' : 'inside bytes')
      }
    } finally { await reader.close() }
    await page.getByRole('button', { name: '取消选择', exact: true }).click()
    await page.getByRole('checkbox', { name: '选择 outside.txt', exact: true }).check()
    await page.getByRole('button', { name: '项目', exact: true }).click()
    await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible()
    await upload(page, 'outside.txt', 'different bytes')
    await page.getByRole('checkbox', { name: '选择 outside.txt', exact: true }).check()
    let unexpectedDownload = false
    page.on('download', () => { unexpectedDownload = true })
    await page.getByRole('button', { name: '下载所选为 ZIP', exact: true }).click()
    await expect(page.getByText(/ZIP 中存在重复或跨平台大小写冲突/)).toBeVisible()
    expect(unexpectedDownload).toBe(false)
    await page.getByRole('button', { name: '取消选择', exact: true }).click()
    await page.getByRole('checkbox', { name: '选择 inside.txt', exact: true }).check()
    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('button', { name: '移到回收站 inside.txt', exact: true }).click()
    await expect(page.getByRole('button', { name: 'inside.txt', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '下载所选为 ZIP', exact: true }).click()
    await expect(page.getByText(/已选项目已移动、被覆盖或删除/)).toBeVisible()
    expect(unexpectedDownload).toBe(false)
    await page.getByRole('button', { name: '锁定云盘' }).click()
    await expect(page.getByRole('heading', { name: '重新解锁云盘' })).toBeVisible()
    await expect(page.getByText('已选 1 项', { exact: true })).toHaveCount(0)
  } finally { await server.close() }
})
