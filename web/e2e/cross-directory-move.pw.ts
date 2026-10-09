import { testUsesHTTPS } from './tls-proxy.mjs'
import { selectListPreference } from './legacy-list-test'
import { expect, test, type Page } from './legacy-list-test'
import { startIsolatedServer } from './isolated-server'

async function folder(page: Page, name: string) {
  page.once('dialog', (dialog) => void dialog.accept(name))
  await page.getByRole('button', { name: '新建文件夹', exact: true }).click()
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
}
async function upload(page: Page, name: string) {
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(`contents:${name}`) })
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
}
async function root(page: Page) {
  await page.locator('.breadcrumbs').getByRole('button', { name: '我的文件', exact: true }).click()
  await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
}
async function open(page: Page, name: string) {
  await page.getByRole('button', { name, exact: true }).click()
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
}
async function chooseTarget(page: Page, count: number) {
  await page.getByRole('button', { name: '批量移动', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: `移动 ${count} 个项目`, exact: true })
  await dialog.getByRole('button', { name: 'target', exact: true }).click()
  await dialog.getByRole('button', { name: '移动到此文件夹', exact: true }).click()
  return dialog
}

test('cross-directory moves deduplicate parents, rebuild after a global conflict, and reject collisions without partial movement', async ({ page, context, browser }) => {
  test.setTimeout(120_000)
  const server = await startIsolatedServer()
  // Independent browser storage models another device; local tabs use Web Locks.
  const remote = await browser.newContext({ ignoreHTTPSErrors: testUsesHTTPS() })
  await selectListPreference(remote)
  try {
    await page.goto(`${server.baseURL}/setup#${server.token}`)
    await page.getByLabel('设置密码').fill('correct horse battery')
    await page.getByLabel('再次输入密码').fill('correct horse battery')
    await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
    await page.getByRole('button', { name: '创建加密云盘' }).click()
    await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
    for (const name of ['A', 'B', 'target']) await folder(page, name)
    await open(page, 'A')
    await upload(page, 'a.txt')
    await page.getByRole('checkbox', { name: '选择 a.txt', exact: true }).check()
    await root(page)
    await open(page, 'B')
    await upload(page, 'b.txt')
    await page.getByRole('checkbox', { name: '选择 b.txt', exact: true }).check()
    await root(page)
    await upload(page, 'c.txt')
    await page.getByRole('checkbox', { name: '选择 c.txt', exact: true }).check()
    await page.getByRole('checkbox', { name: '选择 A', exact: true }).check()
    await expect(page.getByRole('toolbar', { name: '批量操作' })).toContainText('已选 4 项')

    await remote.addCookies(await context.cookies())
    const racer = await remote.newPage()
    await racer.goto(`${server.baseURL}/login`)
    await racer.getByLabel('密码', { exact: true }).fill('correct horse battery')
    await racer.getByRole('button', { name: '解锁云盘', exact: true }).click()
    await expect(racer.getByRole('heading', { name: '我的文件' })).toBeVisible()
    const attempts: { expectedGlobalRevision: number; updates: unknown[] }[] = []
    await page.route('**/api/v1/metadata/transactions', async (route) => {
      const body = route.request().postDataJSON() as { expectedGlobalRevision: number; updates: unknown[] }
      attempts.push(body)
      if (attempts.length === 1) await folder(racer, 'concurrent-folder')
      await route.continue()
    })
    const dialog = await chooseTarget(page, 4)
    await expect(dialog).toHaveCount(0, { timeout: 30_000 })
    expect(attempts).toHaveLength(2)
    expect(attempts.every((attempt) => attempt.updates.length === 3)).toBe(true)
    expect(attempts[1]!.expectedGlobalRevision).toBeGreaterThan(attempts[0]!.expectedGlobalRevision)
    await page.unroute('**/api/v1/metadata/transactions')
    await expect(page.getByRole('status')).toContainText('3 个项目已原子移动。')
    await expect(page.getByRole('button', { name: 'A', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'c.txt', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'concurrent-folder', exact: true })).toBeVisible()
    await open(page, 'B')
    await expect(page.getByRole('button', { name: 'b.txt', exact: true })).toHaveCount(0)
    await root(page)
    await open(page, 'target')
    await expect(page.getByRole('button', { name: 'b.txt', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'c.txt', exact: true })).toBeVisible()
    await open(page, 'A')
    await page.getByRole('button', { name: 'a.txt', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '预览 a.txt' })).toContainText('contents:a.txt')
    await page.getByRole('button', { name: '关闭预览', exact: true }).click()
    await root(page)
    await upload(page, 'b.txt')
    await page.getByRole('checkbox', { name: '选择 b.txt', exact: true }).check()
    await open(page, 'B')
    await upload(page, 'safe.txt')
    await page.getByRole('checkbox', { name: '选择 safe.txt', exact: true }).check()
    const conflict = await chooseTarget(page, 2)
    await expect(page.getByText('目标文件夹已有同名项目“b.txt”。', { exact: true })).toBeVisible()
    await conflict.getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.getByRole('button', { name: 'safe.txt', exact: true })).toBeVisible()
    await root(page)
    await expect(page.getByRole('button', { name: 'b.txt', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '取消选择', exact: true }).click()
    await open(page, 'B')
    await page.getByRole('checkbox', { name: '选择 safe.txt', exact: true }).check()
    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('button', { name: '移到回收站 safe.txt', exact: true }).click()
    await expect(page.getByRole('button', { name: 'safe.txt', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '批量移动', exact: true }).click()
    const stale = page.getByRole('dialog', { name: '移动 safe.txt' })
    await stale.getByRole('button', { name: 'target', exact: true }).click()
    await stale.getByRole('button', { name: '移动到此文件夹', exact: true }).click()
    await expect(page.getByText('已选项目已移动、被覆盖或删除，请重新选择。', { exact: true })).toBeVisible()
    await racer.close()
  } finally { await remote.close(); await server.close() }
})

test('opposing concurrent folder moves cannot form a directory cycle', async ({ page, context, browser }) => {
  test.setTimeout(120_000)
  const server = await startIsolatedServer()
  // Independent browser storage models another device; local tabs use Web Locks.
  const remote = await browser.newContext({ ignoreHTTPSErrors: testUsesHTTPS() })
  await selectListPreference(remote)
  try {
    await page.goto(`${server.baseURL}/setup#${server.token}`)
    await page.getByLabel('设置密码').fill('correct horse battery')
    await page.getByLabel('再次输入密码').fill('correct horse battery')
    await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
    await page.getByRole('button', { name: '创建加密云盘' }).click()
    await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
    await folder(page, 'left')
    await folder(page, 'right')
    await remote.addCookies(await context.cookies())
    const other = await remote.newPage()
    await other.goto(`${server.baseURL}/login`)
    await other.getByLabel('密码', { exact: true }).fill('correct horse battery')
    await other.getByRole('button', { name: '解锁云盘', exact: true }).click()
    await expect(other.getByRole('heading', { name: '我的文件' })).toBeVisible()
    let releaseLeft!: () => void; let releaseRight!: () => void
    const leftGate = new Promise<void>((resolve) => { releaseLeft = resolve })
    const rightGate = new Promise<void>((resolve) => { releaseRight = resolve })
    let leftReady!: (revision: number) => void; let rightReady!: (revision: number) => void
    const leftRevision = new Promise<number>((resolve) => { leftReady = resolve })
    const rightRevision = new Promise<number>((resolve) => { rightReady = resolve })
    await page.route('**/api/v1/metadata/transactions', async (route) => {
      leftReady(route.request().postDataJSON().expectedGlobalRevision)
      await leftGate; await route.continue()
    })
    await other.route('**/api/v1/metadata/transactions', async (route) => {
      rightReady(route.request().postDataJSON().expectedGlobalRevision)
      await rightGate; await route.continue()
    })
    await page.getByRole('button', { name: '移动 left', exact: true }).click()
    const left = page.getByRole('dialog', { name: '移动 left', exact: true })
    await left.getByRole('button', { name: 'right', exact: true }).click()
    await left.getByRole('button', { name: '移动到此文件夹', exact: true }).click()
    await other.getByRole('button', { name: '移动 right', exact: true }).click()
    const right = other.getByRole('dialog', { name: '移动 right', exact: true })
    await right.getByRole('button', { name: 'left', exact: true }).click()
    await right.getByRole('button', { name: '移动到此文件夹', exact: true }).click()
    expect(await leftRevision).toBe(await rightRevision)
    releaseLeft()
    await expect(left).toHaveCount(0)
    releaseRight()
    await expect(other.getByText('不能将文件夹移动到自身或其下级文件夹。', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'left', exact: true })).toHaveCount(0)
    await open(page, 'right')
    await open(page, 'left')
    // Breadcrumbs also have semantic list items; this assertion concerns file rows.
    await expect(page.getByRole('list', { name: '文件列表', exact: true }).getByRole('listitem')).toHaveCount(0)
    await other.close()
  } finally { await remote.close(); await server.close() }
})

test('a continuously contended move rebuilds four times, then leaves both indexes unchanged', async ({ page, context, browser }) => {
  test.setTimeout(120_000)
  const server = await startIsolatedServer()
  const remote = await browser.newContext({ ignoreHTTPSErrors: testUsesHTTPS() })
  await selectListPreference(remote)
  try {
    await page.goto(`${server.baseURL}/setup#${server.token}`)
    await page.getByLabel('设置密码').fill('correct horse battery')
    await page.getByLabel('再次输入密码').fill('correct horse battery')
    await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
    await page.getByRole('button', { name: '创建加密云盘' }).click()
    await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
    await folder(page, 'move-target')
    await upload(page, 'contended.txt')

    await remote.addCookies(await context.cookies())
    const racer = await remote.newPage()
    await racer.goto(`${server.baseURL}/login`)
    await racer.getByLabel('密码', { exact: true }).fill('correct horse battery')
    await racer.getByRole('button', { name: '解锁云盘', exact: true }).click()
    await expect(racer.getByRole('heading', { name: '我的文件' })).toBeVisible()

    const attempts: { expectedGlobalRevision: number; updates: { objectId: string }[] }[] = []
    const transactionStatuses: number[] = []
    page.on('response', (response) => {
      if (response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/metadata/transactions') transactionStatuses.push(response.status())
    })
    await page.route('**/api/v1/metadata/transactions', async (route) => {
      const body = route.request().postDataJSON() as { expectedGlobalRevision?: number; updates?: { objectId: string }[] }
      if (!Number.isSafeInteger(body.expectedGlobalRevision) || body.updates?.length !== 2) { await route.continue(); return }
      attempts.push(body as { expectedGlobalRevision: number; updates: { objectId: string }[] })
      await folder(racer, `racing-${attempts.length}`)
      await route.continue()
    })

    await page.getByRole('checkbox', { name: '选择 contended.txt', exact: true }).check()
    await page.getByRole('button', { name: '批量移动', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '移动 contended.txt', exact: true })
    await dialog.getByRole('button', { name: 'move-target', exact: true }).click()
    await dialog.getByRole('button', { name: '移动到此文件夹', exact: true }).click()
    await expect(dialog.getByRole('alert')).toHaveText('移动未完成。请检查冲突或刷新目录后重试。', { timeout: 60_000 })

    expect(attempts).toHaveLength(4)
    expect(new Set(attempts.map((attempt) => attempt.expectedGlobalRevision)).size).toBe(4)
    expect(attempts.every((attempt, index) => index === 0 || attempts[index - 1]!.expectedGlobalRevision < attempt.expectedGlobalRevision)).toBe(true)
    expect(new Set(attempts.map((attempt) => attempt.updates.map((update) => update.objectId).join(','))).size).toBe(4)
    expect(transactionStatuses).toEqual([409, 409, 409, 409])
    await expect(page.getByRole('button', { name: 'contended.txt', exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: 'move-target', exact: true }).click()
    await expect(page.getByRole('button', { name: 'contended.txt', exact: true })).toHaveCount(0)
    const usage = await page.evaluate(async () => await (await fetch('/api/v1/storage/usage')).json() as { pendingBytes: number; uploadReservedBytes: number })
    expect(usage).toMatchObject({ pendingBytes: 0, uploadReservedBytes: 0 })
    await expect(racer.getByRole('button', { name: 'racing-1', exact: true })).toBeVisible()
    await expect(racer.getByRole('button', { name: 'racing-2', exact: true })).toBeVisible()
    await expect(racer.getByRole('button', { name: 'racing-3', exact: true })).toBeVisible()
    await expect(racer.getByRole('button', { name: 'racing-4', exact: true })).toBeVisible()
    await racer.close()
  } finally { await remote.close(); await server.close() }
})
