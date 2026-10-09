import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from './legacy-list-test'
import { startIsolatedServer } from './isolated-server'

test('a nested folder/file type conflict is summarized before writes and an explicit skip preserves the blocker', async ({ page }) => {
  test.setTimeout(90_000)
  const server = await startIsolatedServer()
  const source = mkdtempSync(join(tmpdir(), 'xdrive-folder-preflight-'))
  const bundle = join(source, 'bundle')
  mkdirSync(join(bundle, 'a-ready'), { recursive: true })
  mkdirSync(join(bundle, 'z-collision'))
  writeFileSync(join(bundle, 'a-ready', 'new.txt'), 'must not be uploaded')
  writeFileSync(join(bundle, 'z-collision', 'nested.txt'), 'conflicts with existing file')
  try {
    await page.goto(`${server.baseURL}/setup#${server.token}`)
    await page.getByLabel('设置密码').fill('correct horse battery')
    await page.getByLabel('再次输入密码').fill('correct horse battery')
    await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
    await page.getByRole('button', { name: '创建加密云盘' }).click()
    await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 30_000 })
    page.once('dialog', (dialog) => void dialog.accept('bundle'))
    await page.getByRole('button', { name: '新建文件夹', exact: true }).click()
    await expect(page.getByRole('button', { name: 'bundle', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'bundle', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'bundle', exact: true })).toBeVisible()
    await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'z-collision', mimeType: 'text/plain', buffer: Buffer.from('original file retained') })
    await expect(page.getByRole('button', { name: 'z-collision', exact: true })).toBeVisible()
    await page.locator('.breadcrumbs').getByRole('button', { name: '我的文件', exact: true }).click()
    await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
    const before = await snapshot(page)
    const writes: string[] = []
    const observe = (request: { method(): string; url(): string }) => {
      if (['POST', 'PUT', 'DELETE'].includes(request.method()) && new URL(request.url()).pathname.startsWith('/api/v1/')) writes.push(new URL(request.url()).pathname)
    }
    page.on('request', observe)
    await page.locator('input[webkitdirectory]').setInputFiles(bundle)
    const dialog = page.getByRole('dialog', { name: '文件夹上传冲突' })
    await expect(dialog.getByRole('heading')).toHaveText('1 项存在同名冲突')
    await expect(dialog.getByLabel('处理 bundle/z-collision', { exact: true })).toHaveValue('keep-both')
    expect(writes).toEqual([])
    expect(await snapshot(page)).toEqual(before)
    await dialog.getByLabel('处理 bundle/z-collision', { exact: true }).selectOption('skip')
    page.off('request', observe)
    await dialog.getByRole('button', { name: '确认处理并上传' }).click()
    await expect(page.getByRole('status').filter({ hasText: '文件夹上传完成，共 1 个文件，跳过 1 个。' })).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: 'bundle', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'bundle', exact: true })).toBeVisible()
    await expect(page.locator('.item-count')).toHaveText('2 项')
    await page.getByRole('button', { name: 'a-ready', exact: true }).click()
    await expect(page.getByRole('button', { name: 'new.txt', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'new.txt', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '预览 new.txt' })).toContainText('must not be uploaded')
    await page.getByRole('button', { name: '关闭预览' }).click()
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的文件', exact: true }).click()
    await page.getByRole('button', { name: 'bundle', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'bundle', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'z-collision', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '预览 z-collision' })).toContainText('original file retained')
  } finally { await server.close(); rmSync(source, { recursive: true, force: true }) }
})

async function snapshot(page: Page) {
  return page.evaluate(async () => {
    const read = async (path: string) => {
      const response = await fetch(`/api/v1/${path}`, { cache: 'no-store' })
      if (!response.ok) throw new Error(`fixture snapshot unavailable: ${response.status}`)
      return response.json() as Promise<Record<string, unknown>>
    }
    const [state, usage] = await Promise.all([read('vault/state'), read('storage/usage')])
    return { vaultMutationRevision: state.vaultMutationRevision, usedBytes: usage.usedBytes, reservedBytes: usage.reservedBytes }
  })
}
