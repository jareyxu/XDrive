import { testUsesHTTPS } from './tls-proxy.mjs'
import { selectListPreference } from './legacy-list-test'
import { expect, test } from './legacy-list-test'
import type { Page } from './legacy-list-test'
import { startIsolatedServer } from './isolated-server'

test('deletion rebuilds actual changed membership and stops after four competing mutations', async ({ browser }) => {
  test.setTimeout(120_000)
  const server = await startIsolatedServer()
  const primary = await browser.newContext({ ignoreHTTPSErrors: testUsesHTTPS(), baseURL: server.baseURL  })
  await selectListPreference(primary)
  const secondary = await browser.newContext({ ignoreHTTPSErrors: testUsesHTTPS(), baseURL: server.baseURL  })
  await selectListPreference(secondary)
  try {
    const page = await primary.newPage()
    await page.goto(`/setup#${server.token}`)
    await page.getByLabel('管理员用户名').fill('admin')
    await page.getByLabel('设置密码').fill('correct horse battery')
    await page.getByLabel('再次输入密码').fill('correct horse battery')
    await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
    await page.getByRole('button', { name: '创建加密云盘' }).click()
    await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
    await createFolder(page, 'delete-subtree')
    await page.getByRole('button', { name: 'delete-subtree', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'delete-subtree', exact: true })).toBeVisible()
    await uploadText(page, 'original.txt')
    await page.locator('.breadcrumbs').getByRole('button', { name: '我的文件' }).click()
    const other = await secondary.newPage()
    await other.goto('/login')
    await other.getByLabel('管理员用户名').fill('admin')
    await other.getByLabel('密码').fill('correct horse battery')
    await other.getByRole('button', { name: '解锁云盘' }).click()
    await expect(other.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
    await other.getByRole('button', { name: 'delete-subtree', exact: true }).click()
    await expect(other.getByRole('heading', { name: 'delete-subtree', exact: true })).toBeVisible()

    const builds: string[] = []
    const cancelled: string[] = []
    const members = new Map<string, string[]>()
    const finalBuilds: string[] = []
    let abandoned = 0
    let mode: 'once' | 'always' | 'off' = 'once'
    page.on('response', async (response) => {
      const path = new URL(response.url()).pathname
      if (path === '/api/v1/tombstone-builds' && response.status() === 201) builds.push((await response.json() as { buildId: string }).buildId)
      if (response.request().method() === 'DELETE' && path.startsWith('/api/v1/tombstone-builds/') && response.ok()) cancelled.push(path.split('/').at(-1)!)
      if (path.endsWith('/abandon') && response.ok()) abandoned += 1
    })
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (path.startsWith('/api/v1/tombstone-builds/') && path.endsWith('/members')) {
        const buildId = path.split('/').at(-2)!
        const batch = (request.postDataJSON() as { members: { id: string }[] }).members.map((member) => member.id)
        members.set(buildId, [...members.get(buildId) ?? [], ...batch])
      }
    })
    await page.route('**/api/v1/metadata/transactions', async (route) => {
      const body = route.request().postDataJSON() as { finalizeTombstoneBuildId?: string }
      if (!body.finalizeTombstoneBuildId) { await route.continue(); return }
      finalBuilds.push(body.finalizeTombstoneBuildId)
      if (mode === 'once' && finalBuilds.length === 1) await uploadText(other, 'concurrent.txt')
      if (mode === 'always') await createFolder(other, `competing-${finalBuilds.length}`)
      await route.continue()
    })
    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('button', { name: '移到回收站 delete-subtree' }).click()
    await expect(page.getByText('已移到回收站。')).toBeVisible({ timeout: 30_000 })
    expect(finalBuilds).toHaveLength(2)
    expect(new Set(finalBuilds).size).toBe(2)
    expect(members.get(finalBuilds[1]!)!.length).toBe(members.get(finalBuilds[0]!)!.length + 2)
    await expect.poll(() => cancelled.length).toBe(1)
    await expect.poll(() => abandoned).toBe(1)
    await page.getByRole('button', { name: '回收站', exact: true }).click()
    await page.getByRole('button', { name: 'delete-subtree', exact: true }).click()
    await expect(page.getByRole('button', { name: 'original.txt', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'concurrent.txt', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'concurrent.txt', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '预览 concurrent.txt' })).toContainText('bytes for concurrent.txt')
    await page.getByRole('button', { name: '关闭预览' }).click()
    await page.getByRole('button', { name: '我的文件', exact: true }).click()
    await createFolder(page, 'continuously-contended')
    await other.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的文件', exact: true }).click()
    // Reload the other page's root so every competing mutation starts from a
    // current revision; the service, not a synthetic 409, rejects each delete.
    await other.reload()
    await other.getByLabel('密码').fill('correct horse battery')
    await other.getByRole('button', { name: '解锁云盘' }).click()
    await expect(other.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
    mode = 'always'
    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('button', { name: '移到回收站 continuously-contended' }).click()
    await expect(page.getByText('检测到其他标签页或设备正在持续修改云盘，请等待上传 / 移动等操作完成后重试。')).toBeVisible({ timeout: 30_000 })
    expect(finalBuilds).toHaveLength(6)
    expect(new Set(finalBuilds).size).toBe(6)
    await expect.poll(() => cancelled.length).toBe(5)
    await expect.poll(() => abandoned).toBe(5)
    expect(builds).toHaveLength(6)
    await expect(page.getByRole('button', { name: 'continuously-contended', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '回收站', exact: true }).click()
    await expect(page.getByRole('button', { name: 'continuously-contended', exact: true })).toHaveCount(0)
    mode = 'off'
    await page.reload()
    await page.getByLabel('密码').fill('correct horse battery')
    await page.getByRole('button', { name: '解锁云盘' }).click()
    // Refresh preserves the real /trash route. Continue this cancellation
    // scenario in the active root through the same navigation as a user.
    await expect(page.getByRole('heading', { name: '回收站', exact: true })).toBeVisible({ timeout: 30_000 })
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的文件', exact: true }).click()
    await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
    await createFolder(page, 'cancel-traversal')
    const childRead = page.waitForResponse((response) => response.request().method() === 'GET' && /^\/drive\/[A-Za-z0-9_-]{16,64}$/u.test(new URL(page.url()).pathname) && new URL(response.url()).pathname === `/api/v1/metadata/${new URL(page.url()).pathname.split('/').at(-1)!}`)
    await page.getByRole('button', { name: 'cancel-traversal', exact: true }).click()
    const childPath = new URL((await childRead).url()).pathname
    await expect(page.getByRole('heading', { name: 'cancel-traversal', exact: true })).toBeVisible()
    await uploadText(page, 'cancel.txt')
    await page.locator('.breadcrumbs').getByRole('button', { name: '我的文件' }).click()
    let release!: () => void
    let started!: () => void
    const hold = new Promise<void>((resolve) => { release = resolve })
    const traversalStarted = new Promise<void>((resolve) => { started = resolve })
    await page.route(`**${childPath}`, async (route) => {
      started()
      await hold
      try { await route.continue() } catch { /* Locking aborts this in-flight read. */ }
    })
    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('button', { name: '移到回收站 cancel-traversal' }).click()
    await traversalStarted
    await page.getByRole('button', { name: '锁定云盘' }).click()
    release()
    await expect(page.getByRole('heading', { name: '重新解锁云盘' })).toBeVisible()
    await expect.poll(() => cancelled.length).toBe(6)
    expect(finalBuilds).toHaveLength(6)
    expect(abandoned).toBe(5)
    await page.unroute(`**${childPath}`)
    await page.getByLabel('密码').fill('correct horse battery')
    await page.getByRole('button', { name: '解锁云盘' }).click()
    await expect(page.getByRole('button', { name: 'cancel-traversal', exact: true })).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: '回收站', exact: true }).click()
    await expect(page.getByRole('button', { name: 'cancel-traversal', exact: true })).toHaveCount(0)
  } finally { await primary.close(); await secondary.close(); await server.close() }
})

test('deletion re-resolves its parent after a remote ancestor move and rename', async ({ browser }) => {
  test.setTimeout(120_000)
  const server = await startIsolatedServer()
  const primary = await browser.newContext({ ignoreHTTPSErrors: testUsesHTTPS(), baseURL: server.baseURL })
  const secondary = await browser.newContext({ ignoreHTTPSErrors: testUsesHTTPS(), baseURL: server.baseURL })
  await selectListPreference(primary)
  await selectListPreference(secondary)
  try {
    const page = await primary.newPage()
    await page.goto(`/setup#${server.token}`)
    await page.getByLabel('管理员用户名').fill('admin')
    await page.getByLabel('设置密码').fill('correct horse battery')
    await page.getByLabel('再次输入密码').fill('correct horse battery')
    await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
    await page.getByRole('button', { name: '创建加密云盘' }).click()
    await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
    await createFolder(page, 'container')
    await createFolder(page, 'outside')
    await page.getByRole('button', { name: 'container', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'container', exact: true })).toBeVisible()
    await createFolder(page, 'target')
    await page.getByRole('button', { name: 'target', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'target', exact: true })).toBeVisible()
    await uploadText(page, 'inside.txt')
    await page.locator('.breadcrumbs').getByRole('button', { name: 'container', exact: true }).click()

    const other = await secondary.newPage()
    await other.goto('/login')
    await other.getByLabel('管理员用户名').fill('admin')
    await other.getByLabel('密码').fill('correct horse battery')
    await other.getByRole('button', { name: '解锁云盘' }).click()
    await expect(other.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })

    const attempts: { expectedGlobalRevision: number; finalizeTombstoneBuildId?: string }[] = []
    const statuses: number[] = []
    let movedAncestor = false
    const relocateContainer = async () => {
      await other.getByRole('button', { name: '移动 container', exact: true }).click()
      const dialog = other.getByRole('dialog', { name: '移动 container', exact: true })
      await dialog.getByRole('button', { name: 'outside', exact: true }).click()
      await dialog.getByRole('button', { name: '移动到此文件夹', exact: true }).click()
      await expect(dialog).toHaveCount(0, { timeout: 30_000 })
      await other.getByRole('button', { name: 'outside', exact: true }).click()
      other.once('dialog', (renameDialog) => void renameDialog.accept('renamed-container'))
      await other.getByRole('button', { name: '重命名 container', exact: true }).click()
      await expect(other.getByRole('button', { name: 'renamed-container', exact: true })).toBeVisible({ timeout: 30_000 })
    }
    page.on('response', (response) => {
      if (response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/metadata/transactions') statuses.push(response.status())
    })
    await page.route('**/api/v1/metadata/transactions', async (route) => {
      const body = route.request().postDataJSON() as { expectedGlobalRevision: number; finalizeTombstoneBuildId?: string }
      if (!body.finalizeTombstoneBuildId) { await route.continue(); return }
      attempts.push(body)
      if (!movedAncestor) {
        movedAncestor = true
        await relocateContainer()
      }
      await route.continue()
    })

    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('button', { name: '移到回收站 target', exact: true }).click()
    await expect(page.getByText('已移到回收站。')).toBeVisible({ timeout: 30_000 })
    expect(attempts).toHaveLength(2)
    expect(attempts[1]!.expectedGlobalRevision).toBeGreaterThan(attempts[0]!.expectedGlobalRevision)
    expect(statuses).toEqual([409, 200])

    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的文件', exact: true }).click()
    await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible()
    await page.getByRole('button', { name: 'outside', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'outside', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'renamed-container', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'renamed-container', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'target', exact: true })).toHaveCount(0)

    await page.getByRole('button', { name: '回收站', exact: true }).click()
    await expect(page.getByRole('button', { name: '恢复 target', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '恢复 target', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('项目已恢复。', { timeout: 30_000 })
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的文件', exact: true }).click()
    await page.getByRole('button', { name: 'outside', exact: true }).click()
    await page.getByRole('button', { name: 'renamed-container', exact: true }).click()
    await expect(page.getByRole('button', { name: 'target', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'target', exact: true }).click()
    await expect(page.getByRole('button', { name: 'inside.txt', exact: true })).toBeVisible()
    await other.close()
  } finally { await primary.close(); await secondary.close(); await server.close() }
})

test('deletion rebuilds membership after a child file moves out of the subtree', async ({ browser }) => {
  test.setTimeout(120_000)
  const server = await startIsolatedServer()
  const primary = await browser.newContext({ ignoreHTTPSErrors: testUsesHTTPS(), baseURL: server.baseURL })
  const secondary = await browser.newContext({ ignoreHTTPSErrors: testUsesHTTPS(), baseURL: server.baseURL })
  await selectListPreference(primary)
  await selectListPreference(secondary)
  try {
    const page = await primary.newPage()
    await page.goto(`/setup#${server.token}`)
    await page.getByLabel('管理员用户名').fill('admin')
    await page.getByLabel('设置密码').fill('correct horse battery')
    await page.getByLabel('再次输入密码').fill('correct horse battery')
    await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
    await page.getByRole('button', { name: '创建加密云盘' }).click()
    await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
    await createFolder(page, 'container')
    await createFolder(page, 'destination')
    await page.getByRole('button', { name: 'container', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'container', exact: true })).toBeVisible()
    await createFolder(page, 'tree')
    await page.getByRole('button', { name: 'tree', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'tree', exact: true })).toBeVisible()
    await uploadText(page, 'move-out.txt')
    await page.locator('.breadcrumbs').getByRole('button', { name: 'container', exact: true }).click()

    const other = await secondary.newPage()
    await other.goto('/login')
    await other.getByLabel('管理员用户名').fill('admin')
    await other.getByLabel('密码').fill('correct horse battery')
    await other.getByRole('button', { name: '解锁云盘' }).click()
    await expect(other.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })

    const attempts: { expectedGlobalRevision: number; finalizeTombstoneBuildId?: string }[] = []
    const statuses: number[] = []
    let movedChild = false
    const relocateChildOut = async () => {
      await other.getByRole('button', { name: 'container', exact: true }).click()
      await other.getByRole('button', { name: 'tree', exact: true }).click()
      await other.getByRole('checkbox', { name: '选择 move-out.txt', exact: true }).check()
      await other.getByRole('button', { name: '批量移动', exact: true }).click()
      const dialog = other.getByRole('dialog', { name: '移动 move-out.txt', exact: true })
      await dialog.getByRole('button', { name: '我的文件', exact: true }).click()
      await dialog.getByRole('button', { name: 'destination', exact: true }).click()
      await dialog.getByRole('button', { name: '移动到此文件夹', exact: true }).click()
      await expect(dialog).toHaveCount(0, { timeout: 30_000 })
    }
    page.on('response', (response) => {
      if (response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/metadata/transactions') statuses.push(response.status())
    })
    await page.route('**/api/v1/metadata/transactions', async (route) => {
      const body = route.request().postDataJSON() as { expectedGlobalRevision: number; finalizeTombstoneBuildId?: string }
      if (!body.finalizeTombstoneBuildId) { await route.continue(); return }
      attempts.push(body)
      if (!movedChild) {
        movedChild = true
        await relocateChildOut()
      }
      await route.continue()
    })

    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('button', { name: '移到回收站 tree', exact: true }).click()
    await expect(page.getByText('已移到回收站。')).toBeVisible({ timeout: 30_000 })
    expect(attempts).toHaveLength(2)
    expect(attempts[1]!.expectedGlobalRevision).toBeGreaterThan(attempts[0]!.expectedGlobalRevision)
    expect(statuses).toEqual([409, 200])

    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的文件', exact: true }).click()
    await page.getByRole('button', { name: 'destination', exact: true }).click()
    await expect(page.getByRole('button', { name: 'move-out.txt', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'move-out.txt', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '预览 move-out.txt', exact: true })).toContainText('bytes for move-out.txt')
    await page.getByRole('button', { name: '关闭预览', exact: true }).click()
    await page.getByRole('button', { name: '回收站', exact: true }).click()
    await page.getByRole('button', { name: 'tree', exact: true }).click()
    await expect(page.getByRole('button', { name: 'move-out.txt', exact: true })).toHaveCount(0)
    await other.close()
  } finally { await primary.close(); await secondary.close(); await server.close() }
})

async function createFolder(page: Page, name: string): Promise<void> {
  page.once('dialog', (dialog) => void dialog.accept(name))
  await page.getByRole('button', { name: '新建文件夹' }).click()
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible({ timeout: 30_000 })
}

async function uploadText(page: Page, name: string): Promise<void> {
  await expect(page.getByRole('button', { name: '\u4e0a\u4f20', exact: true })).toBeEnabled()
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(`bytes for ${name}`) })
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible({ timeout: 30_000 })
}
