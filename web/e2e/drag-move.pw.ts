import { expect, test, type Page } from '@playwright/test'
import { startIsolatedServer } from './isolated-server'

const password = 'correct horse battery'
async function setup(page: Page, url: string, token: string) {
 await page.goto(`${url}/setup#${token}`); await page.getByLabel('设置密码').fill(password); await page.getByLabel('再次输入密码').fill(password)
 await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check(); await page.getByRole('button', { name: '创建加密云盘' }).click()
 await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 30000 })
}
async function createFolder(page: Page, name: string) {
 page.once('dialog', dialog => void dialog.accept(name)); await page.getByRole('button', { name: '新建文件夹', exact: true }).click()
 const grid = await page.getByRole('button', { name: '网格视图', exact: true }).getAttribute('aria-pressed') === 'true'
 await expect(page.getByRole('button', { name: grid ? `打开 ${name}` : name, exact: true })).toBeVisible()
}
async function upload(page: Page, name: string) {
 await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(`bytes:${name}`) })
 await expect(page.getByRole('button', { name, exact: true })).toBeVisible({ timeout: 30000 })
 await expect(page.getByRole('status')).toContainText('上传完成。', { timeout: 30000 })
 await expect(page.locator('input[type="file"]:not([webkitdirectory])').first()).toBeEnabled()
}
const home = (page: Page) => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的文件', exact: true })
async function goHome(page: Page) { await home(page).click(); await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 30000 }) }
function entryCard(page: Page, view: 'grid' | 'list', buttonName: string) {
 return page.locator(view === 'grid' ? '.entry-card' : '.entry-row').filter({ has: page.getByRole('button', { name: buttonName, exact: true }) })
}
async function select(page: Page, name: string) { await page.getByLabel(`选择 ${name}`, { exact: true }).check(); await expect(page.getByRole('toolbar', { name: '批量操作' })).toContainText('已选') }
async function dragCardToFolder(page: Page, source: ReturnType<typeof entryCard>, target: ReturnType<typeof entryCard>, expectedLabel: string) {
 const from = (await source.boundingBox())!, to = (await target.boundingBox())!
 await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down()
 await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 4)
 await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 })
 await expect(target).toContainText(expectedLabel, { timeout: 10000 })
 await page.mouse.up()
}

for (const view of ['grid', 'list'] as const) test(`${view} drag moves a cross-directory selection in one transaction and preserves every file`, async ({ page }) => {
 test.setTimeout(120000); const server = await startIsolatedServer()
 try {
  await setup(page, server.baseURL, server.token)
  if (view === 'list') await page.getByRole('button', { name: '列表视图', exact: true }).click()
  await createFolder(page, 'target'); await createFolder(page, 'source'); await upload(page, 'root.txt')
  await entryCard(page, view, 'source').getByRole('button', { name: view === 'grid' ? '打开 source' : 'source', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'source', exact: true })).toBeVisible(); await upload(page, 'nested.txt')
  await select(page, 'nested.txt'); await goHome(page); await select(page, 'root.txt')

  const transactions: Record<string, unknown>[] = []
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/v1/metadata/transactions')) transactions.push(request.postDataJSON()) })
  const target = entryCard(page, view, view === 'grid' ? '打开 target' : 'target')
  await dragCardToFolder(page, entryCard(page, view, 'root.txt'), target, '移到「target」')
  await expect(page.getByRole('status')).toContainText('2 个项目已原子移动。', { timeout: 30000 })
  expect(transactions).toHaveLength(1); expect(transactions[0]!.updates).toHaveLength(3)
  await target.getByRole('button', { name: view === 'grid' ? '打开 target' : 'target', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'target', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'root.txt', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'nested.txt', exact: true })).toBeVisible()
  await goHome(page); await entryCard(page, view, 'source').getByRole('button', { name: view === 'grid' ? '打开 source' : 'source', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'source', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'nested.txt', exact: true })).toHaveCount(0)
 } finally { await server.close() }
})

test('folder drop rejects self-descendant cycles before issuing a mutation', async ({ page }) => {
 test.setTimeout(120000); const server = await startIsolatedServer()
 try {
  await setup(page, server.baseURL, server.token); await createFolder(page, 'branch'); await page.getByRole('button', { name: '打开 branch', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'branch', exact: true })).toBeVisible(); await createFolder(page, 'inner')
  let writes = 0; page.on('request', request => { if (['POST', 'PUT', 'DELETE'].includes(request.method())) writes++ })
  const inner = entryCard(page, 'grid', '打开 inner'); await dragCardToFolder(page, inner, inner, '不能把文件夹移动到自身或其下级文件夹。')
  expect(writes).toBe(0)
 } finally { await server.close() }
})
