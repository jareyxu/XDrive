import { startTLSProxy, testUsesHTTPS } from './tls-proxy.mjs'
import { selectListPreference } from './legacy-list-test'
import { expect, test } from './legacy-list-test'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('full-quota overwrite preserves the old file, then succeeds after cleaning another item', async ({ browser }) => {
  test.setTimeout(120_000)
  const root = mkdtempSync(join(tmpdir(), 'xdrive-quota-e2e-'))
  const projectRoot = join(import.meta.dirname, '..', '..')
  const binary = join(root, 'xdrive-quota-test')
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const address = probe.address()
  if (!address || typeof address === 'string') throw new Error('test port unavailable')
  const port = address.port
  probe.close()
  await once(probe, 'close')
  const environment = {
    ...process.env,
    XDRIVE_DATABASE_PATH: join(root, 'drive.db'),
    XDRIVE_STORAGE_PATH: join(root, 'objects'),
    XDRIVE_SECRET_PATH: join(root, 'server.secret'),
    XDRIVE_USERNAME: 'admin',
    XDRIVE_QUOTA_BYTES: String(Math.ceil(50 * 1024 * 4 / 3)), // Preserve 50 KiB ordinary capacity after precharged maintenance.,
    XDRIVE_DISK_SAFETY_BYTES: '0',
    XDRIVE_LISTEN_ADDR: `127.0.0.1:${port}`,
  }
  let server: ReturnType<typeof spawn> | undefined
  let tlsProxy: Awaited<ReturnType<typeof startTLSProxy>> | undefined
  try {
    execFileSync('go', ['build', '-o', binary, './cmd/xdrive'], { cwd: projectRoot, env: environment })
    const initOutput = execFileSync(binary, ['init'], { cwd: projectRoot, env: environment, encoding: 'utf8' })
    const token = initOutput.match(/\/setup#([A-Za-z0-9_-]+)/u)?.[1]
    if (!token) throw new Error('setup token missing')
    server = spawn(binary, ['serve'], { cwd: projectRoot, env: environment, stdio: 'pipe' })
    const upstreamURL = `http://127.0.0.1:${port}`
    await expect.poll(async () => { try { return (await fetch(`${upstreamURL}/readyz`)).status } catch { return 0 } }, { timeout: 30_000 }).toBe(200)
    if (testUsesHTTPS()) tlsProxy = await startTLSProxy(upstreamURL)
    const baseURL = tlsProxy?.baseURL ?? upstreamURL
    const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: testUsesHTTPS() })
      await selectListPreference(context)
    try {
      const page = await context.newPage()
      const browserDiagnostics: string[] = []
      page.on('pageerror', (error) => browserDiagnostics.push(`pageerror: ${error.message}`))
      page.on('requestfailed', (request) => browserDiagnostics.push(`requestfailed: ${request.method()} ${new URL(request.url()).pathname} (${request.failure()?.errorText ?? 'unknown'})`))
      page.on('request', (request) => browserDiagnostics.push(`request: ${request.method()} ${new URL(request.url()).pathname}`))
      await page.addInitScript(() => {
        const testWindow = window as Window & {
          __xdriveTestClicks?: { tag: string; label: string | null }[]
          __xdriveTestInputs?: { files: number; disabled: boolean; connected: boolean }[]
        }
        testWindow.__xdriveTestClicks = []
        testWindow.__xdriveTestInputs = []
        document.addEventListener('click', (event) => {
          const target = event.target instanceof Element ? event.target.closest('button') : null
          if (target) testWindow.__xdriveTestClicks?.push({ tag: target.tagName, label: target.getAttribute('aria-label') ?? target.textContent?.trim().slice(0, 80) ?? null })
        }, true)
        document.addEventListener('change', (event) => {
          if (!(event.target instanceof HTMLInputElement) || event.target.type !== 'file') return
          testWindow.__xdriveTestInputs?.push({ files: event.target.files?.length ?? 0, disabled: event.target.disabled, connected: event.target.isConnected })
        }, true)
      })
      const attachBrowserDiagnostics = async () => {
        let pageState: unknown
        try {
          let timer: ReturnType<typeof setTimeout> | undefined
          const statePromise = page.evaluate(() => {
            const testWindow = window as Window & {
              __xdriveTestClicks?: { tag: string; label: string | null }[]
              __xdriveTestInputs?: { files: number; disabled: boolean; connected: boolean }[]
            }
            return {
              readyState: document.readyState,
              dialogs: [...document.querySelectorAll('dialog')].map((dialog) => ({ label: dialog.getAttribute('aria-label'), open: dialog.open })),
              alerts: [...document.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent),
              status: [...document.querySelectorAll('[role="status"]')].map((item) => item.textContent),
              clicks: testWindow.__xdriveTestClicks?.slice(-8),
              fileInputChanges: testWindow.__xdriveTestInputs?.slice(-8),
              fileInputs: [...document.querySelectorAll('input[type="file"]')].map((input) => ({ disabled: (input as HTMLInputElement).disabled, connected: input.isConnected, hasWebkitdirectory: input.hasAttribute('webkitdirectory'), files: (input as HTMLInputElement).files?.length ?? 0 })),
            }
          })
          try {
            pageState = await Promise.race([
              statePromise,
              new Promise((resolve) => { timer = setTimeout(() => resolve({ evaluationTimeout: 'page.evaluate did not return within 5 seconds' }), 5_000) }),
            ])
          } finally { if (timer) clearTimeout(timer) }
        } catch (evaluationError) {
          pageState = { evaluationError: evaluationError instanceof Error ? evaluationError.message : String(evaluationError) }
        }
        await test.info().attach('quota-overwrite-browser-diagnostics.json', {
          body: JSON.stringify({ pageState, events: browserDiagnostics.slice(-40) }, null, 2),
          contentType: 'application/json',
        })
      }
      await page.goto(`/setup#${token}`)
      await page.getByLabel('管理员用户名').fill('admin')
      await page.getByLabel('设置密码').fill('correct horse battery')
      await page.getByLabel('再次输入密码').fill('correct horse battery')
      await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
      await page.getByRole('button', { name: '创建加密云盘' }).click()
      await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
      const input = page.locator('input[type="file"]:not([webkitdirectory])').first()
      await input.setInputFiles({ name: 'quota-overwrite.txt', mimeType: 'text/plain', buffer: Buffer.alloc(10 * 1024, 65) })
      await expect(page.getByRole('button', { name: 'quota-overwrite.txt', exact: true })).toBeVisible({ timeout: 30_000 })
      await input.setInputFiles({ name: 'other.txt', mimeType: 'text/plain', buffer: Buffer.alloc(20 * 1024, 67) })
      await expect(page.getByRole('button', { name: 'other.txt', exact: true })).toBeVisible({ timeout: 30_000 })
      page.once('dialog', (dialog) => void dialog.accept())
      await page.getByRole('button', { name: '移到回收站 other.txt' }).click()
      await expect(page.getByRole('button', { name: 'other.txt', exact: true })).toHaveCount(0)
      await input.setInputFiles({ name: 'quota-overwrite.txt', mimeType: 'text/plain', buffer: Buffer.alloc(30 * 1024, 66) })
      const initialConflictDialog = page.getByRole('dialog', { name: '同名文件冲突' })
      try {
        await expect(initialConflictDialog).toBeVisible({ timeout: 30_000 })
      } catch (cause) {
        await attachBrowserDiagnostics()
        throw cause
      }
      await initialConflictDialog.getByRole('button', { name: '覆盖并移入回收站' }).click()
      await expect(page.getByRole('alert')).toContainText('空间不足', { timeout: 30_000 })
      await expect(page.getByRole('alert')).toContainText('缺少')
      await page.getByRole('button', { name: '前往回收站清理' }).click()
      await expect(page.getByRole('button', { name: 'other.txt', exact: true })).toBeVisible()
      page.once('dialog', (dialog) => void dialog.accept())
      await page.getByRole('button', { name: '永久删除 other.txt' }).click()
      await expect(page.getByText('回收站为空')).toBeVisible()
      await page.getByRole('button', { name: '我的文件', exact: true }).click()
      const uploadButton = page.getByRole('button', { name: '上传', exact: true })
      await expect(uploadButton).toBeEnabled({ timeout: 30_000 })
      await page.getByRole('button', { name: 'quota-overwrite.txt', exact: true }).click()
      await expect(page.getByRole('dialog', { name: '预览 quota-overwrite.txt' })).toContainText('AAAAAAAAAA', { timeout: 10_000 })
      await page.getByRole('button', { name: '关闭预览' }).click()
      await expect(uploadButton).toBeEnabled({ timeout: 30_000 })
      await input.setInputFiles({ name: 'quota-overwrite.txt', mimeType: 'text/plain', buffer: Buffer.alloc(30 * 1024, 66) })
      const conflictDialog = page.getByRole('dialog', { name: '同名文件冲突' })
      try {
        await expect(conflictDialog).toBeVisible({ timeout: 30_000 })
      } catch (cause) {
        await attachBrowserDiagnostics()
        throw cause
      }
      try {
        await conflictDialog.getByRole('button', { name: '覆盖并移入回收站' }).click({ timeout: 30_000 })
      } catch (cause) {
        await attachBrowserDiagnostics()
        throw cause
      }
      await expect(page.getByText('上传完成。')).toBeVisible({ timeout: 30_000 })
      await page.getByRole('button', { name: 'quota-overwrite.txt', exact: true }).click()
      await expect(page.getByRole('dialog', { name: '预览 quota-overwrite.txt' })).toContainText('BBBBBBBBBB', { timeout: 10_000 })
      await page.getByRole('button', { name: '关闭预览' }).click()
      await page.getByRole('button', { name: '回收站', exact: true }).click()
      await page.getByRole('button', { name: 'quota-overwrite.txt', exact: true }).click()
      await expect(page.getByRole('dialog', { name: '预览 quota-overwrite.txt' })).toContainText('AAAAAAAAAA', { timeout: 10_000 })
      await page.getByRole('button', { name: '关闭预览' }).click()
      const usage = await page.evaluate(async () => (await (await fetch('/api/v1/storage/usage')).json()) as { quotaBytes: number; usedBytes: number; reservedBytes: number })
      expect(usage.usedBytes + usage.reservedBytes).toBeLessThanOrEqual(usage.quotaBytes)
    } finally { await context.close() }
  } finally {
    await tlsProxy?.close()
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM')
      await once(server, 'exit').catch(() => undefined)
    }
    rmSync(root, { recursive: true, force: true })
  }
})
