import { expect, test, type Page } from './legacy-list-test'
import { startIsolatedServer } from './isolated-server'

const password = 'correct horse battery'
async function setup(page: Page, baseURL: string, token: string) {
  await page.goto(`${baseURL}/setup#${token}`)
  await page.getByLabel('设置密码').fill(password)
  await page.getByLabel('再次输入密码').fill(password)
  await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
  await page.getByRole('button', { name: '创建加密云盘' }).click()
  await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'auth-private.txt', mimeType: 'text/plain', buffer: Buffer.from('actual encrypted authentication fixture') })
  await expect(page.getByRole('status')).toContainText('上传完成。')
  await page.getByRole('button', { name: '锁定云盘', exact: true }).click()
  await expect(page.getByRole('heading', { name: '重新解锁云盘', exact: true })).toBeVisible()
}

test('logout during real Argon2 WASM loading terminates its Worker and cannot continue authentication', async ({ page, context }) => {
  const server = await startIsolatedServer()
  let release!: () => void, reached!: () => void, handled!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const waiting = new Promise<void>(resolve => { reached = resolve })
  const finished = new Promise<void>(resolve => { handled = resolve })
  try {
    await setup(page, server.baseURL, server.token)
    let unlocks = 0, metadataReads = 0
    page.on('request', request => {
      if (request.url().endsWith('/auth/unlock')) unlocks++
      if (request.url().includes('/api/v1/metadata/')) metadataReads++
    })
    await context.route('**/assets/*.wasm', async route => {
      reached(); await gate
      await route.continue().catch(() => undefined)
      handled()
    })
    await page.getByLabel('密码', { exact: true }).fill(password)
    await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
    await waiting
    expect(page.workers()).toHaveLength(1)
    await page.getByRole('button', { name: '退出此会话', exact: true }).click()
    await expect(page.getByRole('heading', { name: '欢迎回来', exact: true })).toBeVisible()
    await expect.poll(() => page.workers().length).toBe(0)
    release(); await finished
    expect(unlocks).toBe(0); expect(metadataReads).toBe(0)
    expect(await page.evaluate(async () => (await (await fetch('/api/v1/auth/session')).json()).authenticated)).toBe(false)
    await expect(page.locator('body')).not.toContainText('auth-private.txt')
    await context.unroute('**/assets/*.wasm')
    await page.getByLabel('管理员用户名').fill('admin')
    await page.getByLabel('密码', { exact: true }).fill(password)
    await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
    await expect(page.getByRole('button', { name: 'auth-private.txt', exact: true })).toBeVisible()
  } finally { release(); await server.close() }
})

test('a real successful unlock response delivered after logout cannot recreate plaintext state', async ({ page }) => {
  const server = await startIsolatedServer()
  let release!: () => void, reached!: () => void, handled!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const waiting = new Promise<void>(resolve => { reached = resolve })
  const finished = new Promise<void>(resolve => { handled = resolve })
  try {
    await setup(page, server.baseURL, server.token)
    let metadataReads = 0
    page.on('request', request => { if (request.url().includes('/api/v1/metadata/')) metadataReads++ })
    await page.route('**/api/v1/auth/unlock', async route => {
      const response = await route.fetch()
      expect(response.status()).toBe(200)
      reached(); await gate
      await route.fulfill({ response }).catch(() => undefined)
      handled()
    })
    await page.getByLabel('密码', { exact: true }).fill(password)
    await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
    await waiting
    await page.getByRole('button', { name: '退出此会话', exact: true }).click()
    await expect(page.getByRole('heading', { name: '欢迎回来', exact: true })).toBeVisible()
    release(); await finished
    expect(metadataReads).toBe(0)
    await expect(page.getByRole('heading', { name: '欢迎回来', exact: true })).toBeVisible()
    await expect(page.locator('body')).not.toContainText('auth-private.txt')
    expect(await page.evaluate(async () => (await (await fetch('/api/v1/auth/session')).json()).authenticated)).toBe(false)
  } finally { release(); await server.close() }
})

test('logout removes local plaintext before a blocked network request and remains locked after failure', async ({ page }) => {
  const server = await startIsolatedServer()
  let release!: () => void, reached!: () => void, handled!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const waiting = new Promise<void>(resolve => { reached = resolve })
  const finished = new Promise<void>(resolve => { handled = resolve })
  try {
    await setup(page, server.baseURL, server.token)
    await page.getByLabel('密码', { exact: true }).fill(password)
    await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
    await expect(page.getByRole('button', { name: 'auth-private.txt', exact: true })).toBeVisible()
    await page.route('**/api/v1/auth/logout', async route => {
      reached(); await gate
      await route.abort('failed'); handled()
    })
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await waiting
    await expect(page.getByRole('heading', { name: '欢迎回来', exact: true })).toBeVisible()
    await expect(page.locator('body')).not.toContainText('auth-private.txt')
    expect(page.workers()).toHaveLength(0)
    release(); await finished
    await expect(page.getByRole('alert')).toContainText('本地云盘已锁定')
    await expect(page.locator('body')).not.toContainText('auth-private.txt')
    // Failed server logout is not falsely reported as session revocation.
    expect(await page.evaluate(async () => (await (await fetch('/api/v1/auth/session')).json()).authenticated)).toBe(true)
    await page.unroute('**/api/v1/auth/logout')
    await page.reload()
    await expect(page.getByRole('heading', { name: '重新解锁云盘', exact: true })).toBeVisible()
    await expect(page.locator('body')).not.toContainText('auth-private.txt')
  } finally { release(); await server.close() }
})
