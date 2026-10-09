import { expect, test, type Page } from './legacy-list-test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startIsolatedServer } from './isolated-server'

test.use({ actionTimeout: 10_000 })
const password = 'correct horse battery'
const nav = (page: Page, name: string) => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true })
async function setup(page: Page, baseURL: string, token: string) {
  await page.goto(`${baseURL}/setup#${token}`)
  await page.getByLabel('设置密码').fill(password)
  await page.getByLabel('再次输入密码').fill(password)
  await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
  await page.getByRole('button', { name: '创建加密云盘' }).click()
  await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 30_000 })
}
async function upload(page: Page, name: string, bytes: Buffer) {
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name, mimeType: 'text/plain', buffer: bytes })
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
  await expect(page.getByRole('status')).toContainText('上传完成。')
}
async function fillReservation(page: Page) {
  return page.evaluate(async () => {
    const session = await fetch('/api/v1/auth/session')
    const csrf = session.headers.get('X-CSRF-Token')!
    const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'X-XDrive-Client-Protocol': '1' }
    const usage = await (await fetch('/api/v1/storage/usage')).json()
    const created = await (await fetch('/api/v1/uploads', { method: 'POST', headers, body: '{}' })).json()
    const response = await fetch(`/api/v1/uploads/${created.uploadId}/reserve`, { method: 'POST', headers, body: JSON.stringify({ reservedBytes: usage.availableBytes }) })
    if (!response.ok) throw new Error(`reservation failed ${response.status}`)
    return { id: created.uploadId as string, reserved: usage.availableBytes as number, used: usage.usedBytes as number }
  })
}
const usage = (page: Page): Promise<{ usedBytes: number; reservedBytes: number; uploadReservedBytes: number; quotaBytes: number; availableBytes: number; trashBytes: number; pendingBytes: number }> => page.evaluate(async () => (await fetch('/api/v1/storage/usage')).json())

for (const mode of ['all', 'single'] as const) test(`full quota ${mode} purge admits an encrypted index only with atomic purge credit and replays a lost response`, async ({ page }) => {
  test.setTimeout(120_000)
  const server = await startIsolatedServer({ quotaBytes: 100 * 1024 }), backup = mkdtempSync(join(tmpdir(), 'xdrive-maintenance-backup-'))
  try {
    await setup(page, server.baseURL, server.token)
    await upload(page, 'survivor.txt', Buffer.from('surviving encrypted bytes'))
    await upload(page, 'remove.txt', Buffer.alloc(32 * 1024, 65))
    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('button', { name: '移到回收站 remove.txt' }).click()
    await expect(page.getByRole('button', { name: 'remove.txt', exact: true })).toHaveCount(0)
    const filler = await fillReservation(page), before = await usage(page)
    expect(before.usedBytes + before.reservedBytes).toBe(before.quotaBytes)
    expect(before.availableBytes).toBe(0)
    await nav(page, '回收站').click()
    let putRequests = 0, attempts = 0
    const keys: string[] = [], bodies: string[] = []
    page.on('request', (request) => { if (request.method() === 'PUT') putRequests++ })
    await page.route('**/api/v1/metadata/maintenance-purge', async (route) => {
      attempts++
      keys.push(route.request().headers()['idempotency-key']!)
      bodies.push(route.request().postData()!)
      if (attempts === 1) {
        const response = await route.fetch()
        expect(response.status()).toBe(200)
        await route.abort('failed') // Real server committed; owner did not receive it.
      } else await route.continue()
    })
    if (mode === 'all') {
      await page.getByRole('button', { name: '清空回收站', exact: true }).click()
      await page.getByRole('button', { name: '永久删除这 1 项', exact: true }).click()
    } else {
      page.once('dialog', (dialog) => void dialog.accept())
      await page.getByRole('button', { name: '永久删除 remove.txt', exact: true }).click()
    }
    await expect(page.getByRole('status')).toContainText(mode === 'all' ? '回收站已清空' : '项目已永久删除')
    expect(attempts).toBe(2); expect(new Set(keys).size).toBe(1); expect(new Set(bodies).size).toBe(1); expect(putRequests).toBe(0)
    const after = await usage(page)
    expect(after.uploadReservedBytes).toBe(filler.reserved); expect(after.pendingBytes).toBe(0); expect(after.trashBytes).toBe(0)
    expect(after.usedBytes).toBe(before.usedBytes - before.trashBytes + Buffer.from(JSON.parse(bodies[0]!).encryptedObject as string, 'base64').byteLength)
    expect(after.usedBytes + after.reservedBytes).toBeLessThanOrEqual(after.quotaBytes)
    await nav(page, '我的文件').click()
    await page.getByRole('button', { name: 'survivor.txt', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('surviving encrypted bytes')
    await page.getByRole('button', { name: '关闭预览' }).click()
    server.backupTo(backup)
    // New schema backup includes only admitted objects, never a maintenance candidate.
    await page.reload()
    await page.getByLabel('密码', { exact: true }).fill(password)
    await page.getByRole('button', { name: '解锁云盘' }).click()
    await expect(page.getByRole('button', { name: 'survivor.txt', exact: true })).toBeVisible()
    await nav(page, '回收站').click(); await expect(page.getByRole('button', { name: 'remove.txt', exact: true })).toHaveCount(0)
  } finally { await server.close(); rmSync(backup, { recursive: true, force: true }) }
})

test('locking while a full quota maintenance request waits prevents late sensitive state revival', async ({ page }) => {
  test.setTimeout(120_000)
  const server = await startIsolatedServer({ quotaBytes: 100 * 1024 })
  let release = () => {}
  try {
    await setup(page, server.baseURL, server.token)
    await upload(page, 'locked-remove.txt', Buffer.alloc(4096, 66))
    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('button', { name: '移到回收站 locked-remove.txt' }).click()
    await expect(page.getByRole('button', { name: 'locked-remove.txt', exact: true })).toHaveCount(0)
    await fillReservation(page)
    await nav(page, '回收站').click()
    let reached = () => {}
    const waiting = new Promise<void>((resolve) => { reached = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    await page.route('**/api/v1/metadata/maintenance-purge', async (route) => { reached(); await held; await route.continue().catch(() => {}) })
    await page.getByRole('button', { name: '清空回收站', exact: true }).click()
    await page.getByRole('button', { name: '永久删除这 1 项', exact: true }).click()
    await waiting
    await page.getByRole('button', { name: '锁定云盘', exact: true }).click()
    await expect(page.getByRole('button', { name: '解锁云盘' })).toBeVisible()
    release()
    await expect(page.getByText('locked-remove.txt', { exact: true })).toHaveCount(0)
    await page.getByLabel('密码', { exact: true }).fill(password)
    await page.getByRole('button', { name: '解锁云盘' }).click()
    await expect(page.getByRole('button', { name: 'locked-remove.txt', exact: true })).toBeVisible()
    expect((await usage(page)).pendingBytes).toBe(0)
  } finally { release(); await server.close() }
})
