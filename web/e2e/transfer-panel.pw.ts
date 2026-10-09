import { expect, test, type Page } from './legacy-list-test'
import { startIsolatedServer } from './isolated-server'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const password = 'correct horse battery'

async function setup(page: Page, baseURL: string, token: string) {
  await page.goto(`${baseURL}/setup#${token}`)
  await page.getByLabel('设置密码').fill(password)
  await page.getByLabel('再次输入密码').fill(password)
  await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
  await page.getByRole('button', { name: '创建加密云盘' }).click()
  await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 30_000 })
}

test('transfer panel shows live upload progress and a completed state for real encrypted uploads', async ({ page }) => {
  test.setTimeout(90_000)
  const server = await startIsolatedServer()
  try {
    await setup(page, server.baseURL, server.token)
    let putRequests = 0
    await page.route('**/api/v1/uploads/*/objects/*', async (route) => {
      putRequests += 1
      if (putRequests === 1) { await route.abort('failed'); return }
      await new Promise((resolve) => setTimeout(resolve, 700))
      await route.continue()
    })
    const picker = page.locator('input[type="file"]:not([webkitdirectory])').first()
    await picker.setInputFiles({ name: '传输面板验收.txt', mimeType: 'text/plain', buffer: Buffer.from('verified transfer progress') })
    const trigger = page.getByRole('button', { name: /1 项传输/ })
    await expect(trigger).toBeVisible({ timeout: 10_000 })
    await trigger.click()
    const panel = page.getByRole('region', { name: '上传和下载任务' })
    await expect(panel).toContainText('传输面板验收.txt')
    await expect(panel.getByRole('progressbar', { name: '传输面板验收.txt进度' })).toBeVisible()
    await expect(panel).toContainText('等待网络')
    await expect(panel).toContainText('正在提交')
    await expect(panel).toContainText('有传输进行时，不会自动锁定。')
    await expect(panel).toContainText('已完成', { timeout: 20_000 })
    expect(putRequests).toBeGreaterThanOrEqual(4)
    await page.unrouteAll()
  } finally { await server.close() }
})

test('receive timeout explains cleanup and resumes the encrypted task after selecting its original file', async ({ page }) => {
  test.setTimeout(90_000)
  const server = await startIsolatedServer()
  const sourceRoot = mkdtempSync(join(tmpdir(), 'xdrive-upload-recovery-source-'))
  try {
    await setup(page, server.baseURL, server.token)
    let failedFirstPut = false
    await page.route('**/api/v1/uploads/*/objects/*', async (route) => {
      if (!failedFirstPut && route.request().method() === 'PUT') {
        failedFirstPut = true
        await route.fulfill({ status: 408, contentType: 'application/json', body: JSON.stringify({ error: 'upload_receive_timeout' }) })
        return
      }
      await route.continue()
    })

    const originalFile = join(sourceRoot, 'timeout-recoverable.txt')
    writeFileSync(originalFile, 'original source retained for encrypted upload recovery')
    await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles(originalFile)
    await expect(page.getByRole('alert')).toContainText('上传接收超时，未完成对象已清理', { timeout: 20_000 })

    const panel = page.getByRole('region', { name: '可恢复的上传任务' })
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('timeout-recoverable.txt')
    await panel.getByRole('button', { name: '重新选择原文件并续传' }).click()
    await page.locator('input[type="file"][hidden]').nth(1).setInputFiles(originalFile)

    await expect(page.getByRole('button', { name: 'timeout-recoverable.txt', exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('status')).toContainText('续传完成。', { timeout: 30_000 })
    const usage = await page.evaluate(async () => await (await fetch('/api/v1/storage/usage')).json() as { uploadReservedBytes: number; usedBytes: number })
    expect(usage.uploadReservedBytes).toBe(0)
    expect(usage.usedBytes).toBeGreaterThan(0)
    expect(failedFirstPut).toBe(true)
    await page.unrouteAll()
  } finally { rmSync(sourceRoot, { recursive: true, force: true }); await server.close() }
})

test('invalid upload metadata explains the rejected write and can retry from the original file', async ({ page }) => {
  test.setTimeout(90_000)
  const server = await startIsolatedServer()
  const sourceRoot = mkdtempSync(join(tmpdir(), 'xdrive-upload-metadata-recovery-'))
  try {
    await setup(page, server.baseURL, server.token)
    let mutated = false
    await page.route('**/api/v1/uploads/*/objects/*', async (route) => {
      if (!mutated && route.request().method() === 'PUT') {
        mutated = true
        const headers = { ...route.request().headers(), 'x-xdrive-object-size': 'malformed-size' }
        const response = await route.fetch({ headers })
        expect(response.status()).toBe(400)
        expect(await response.json()).toMatchObject({ error: 'invalid_object_headers' })
        await route.fulfill({ response })
        return
      }
      await route.continue()
    })

    const originalFile = join(sourceRoot, 'metadata-recoverable.txt')
    writeFileSync(originalFile, 'recover after the server rejects malformed upload metadata')
    await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles(originalFile)
    const alert = page.getByRole('alert')
    await expect(alert).toContainText('上传请求信息无效，文件未保存', { timeout: 20_000 })
    await expect(alert).toContainText('重新选择原文件上传')
    await expect(alert.getByRole('textbox', { name: '请求编号' })).toHaveValue(/^[0-9a-f]{32}$/u)

    const panel = page.getByRole('region', { name: '可恢复的上传任务' })
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('metadata-recoverable.txt')
    await panel.getByRole('button', { name: '重新选择原文件并续传' }).click()
    await page.locator('input[type="file"][hidden]').nth(1).setInputFiles(originalFile)

    await expect(page.getByRole('button', { name: 'metadata-recoverable.txt', exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('status')).toContainText('续传完成。', { timeout: 30_000 })
    const usage = await page.evaluate(async () => await (await fetch('/api/v1/storage/usage')).json() as { uploadReservedBytes: number; usedBytes: number })
    expect(usage.uploadReservedBytes).toBe(0)
    expect(usage.usedBytes).toBeGreaterThan(0)
    expect(mutated).toBe(true)
    await page.unrouteAll()
  } finally { rmSync(sourceRoot, { recursive: true, force: true }); await server.close() }
})
