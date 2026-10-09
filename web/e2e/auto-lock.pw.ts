import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from './legacy-list-test'
import { startIsolatedServer } from './isolated-server'

const password = 'correct horse battery'
const minute = 60_000
async function setup(page: Page, url: string, token: string) {
  await page.clock.install()
  await page.goto(`${url}/setup#${token}`)
  await page.getByLabel('设置密码').fill(password)
  await page.getByLabel('再次输入密码').fill(password)
  await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
  await page.getByRole('button', { name: '创建加密云盘' }).click()
  await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 30_000 })
}
async function upload(page: Page, name = 'idle-secret.txt', buffer = Buffer.from('encrypted idle fixture')) {
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name, mimeType: name.endsWith('.mp4') ? 'video/mp4' : 'text/plain', buffer })
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('status')).toContainText('上传完成。')
}
async function unlocked(page: Page) { await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible() }
async function locked(page: Page) {
  await expect(page.getByRole('heading', { name: '重新解锁云盘', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'idle-secret.txt', exact: true })).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
}
async function unlock(page: Page) {
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
  await unlocked(page)
}
async function freshDeadline(page: Page) {
  await page.clock.fastForward(9 * minute)
  await unlocked(page)
  await page.clock.fastForward(minute + 1000)
  await locked(page)
}

test('idle lock renews on trusted input, clears plaintext, retains session and requires password authentication', async ({ page }) => {
  test.setTimeout(90_000)
  const server = await startIsolatedServer()
  try {
    await setup(page, server.baseURL, server.token)
    await upload(page)
    await page.getByRole('button', { name: 'idle-secret.txt', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('encrypted idle fixture')
    await page.clock.fastForward(9 * minute)
    await page.keyboard.press('Tab')
    await page.clock.fastForward(9 * minute)
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.clock.fastForward(minute + 1000)
    await locked(page)
    await expect(page.getByText('encrypted idle fixture', { exact: true })).toHaveCount(0)
    expect(await page.evaluate(async () => (await (await fetch('/api/v1/auth/session')).json()).authenticated)).toBe(true)
    await page.getByLabel('密码', { exact: true }).fill('wrong password value')
    const failure = page.waitForResponse((response) => response.url().endsWith('/auth/unlock'))
    await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
    expect((await failure).status()).toBe(401)
    await locked(page)
    await unlock(page)
    await page.getByRole('button', { name: 'idle-secret.txt', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('encrypted idle fixture')
  } finally { await server.close() }
})

test('an expired background clock rejects the first trusted input before any rename mutation', async ({ page }) => {
  const server = await startIsolatedServer()
  try {
    await setup(page, server.baseURL, server.token)
    await upload(page)
    const row = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'idle-secret.txt', exact: true }) })
    await row.focus()
    let dialogs = 0, writes = 0
    page.on('dialog', (dialog) => { dialogs += 1; void dialog.dismiss() })
    // Positive control: F2 on the row normally opens the rename prompt. Child
    // buttons intentionally have their own keyboard behavior and are unsuitable.
    await page.keyboard.press('F2')
    await expect.poll(() => dialogs).toBe(1)
    dialogs = 0
    page.on('request', (request) => { if (['POST', 'PUT', 'DELETE'].includes(request.method())) writes += 1 })
    // setSystemTime deliberately leaves scheduled timers pending, modeling a
    // suspended page whose first event must inspect elapsed time before reset.
    await page.clock.setSystemTime(new Date(await page.evaluate(() => Date.now()) + 11 * minute))
    await page.keyboard.press('F2')
    await locked(page)
    expect(dialogs).toBe(0)
    expect(writes).toBe(0)
    await unlock(page)
    await expect(page.getByRole('button', { name: 'idle-secret.txt', exact: true })).toBeVisible()
  } finally { await server.close() }
})

test('a pending real upload pauses idle lock and starts a fresh deadline after commit', async ({ page }) => {
  test.setTimeout(90_000)
  const server = await startIsolatedServer()
  let release = () => {}, notify = () => {}, intercepted = false
  const gate = new Promise<void>((resolve) => { release = resolve }), held = new Promise<void>((resolve) => { notify = resolve })
  try {
    await setup(page, server.baseURL, server.token)
    await page.route('**/api/v1/uploads/*/objects/*', async (route) => {
      if (!intercepted && route.request().method() === 'PUT') { intercepted = true; notify(); await gate }
      await route.continue().catch(() => {})
    })
    await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'idle-secret.txt', mimeType: 'text/plain', buffer: Buffer.alloc(128 * 1024, 42) })
    await held
    await page.clock.fastForward(11 * minute)
    await unlocked(page)
    release()
    await expect(page.getByRole('button', { name: 'idle-secret.txt', exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('status')).toContainText('上传完成。')
    await freshDeadline(page)
  } finally { release(); await server.close() }
})

for (const kind of ['download', 'zip'] as const) test(`a ${kind} stream pauses idle lock under browser backpressure and releases it on completion`, async ({ page }) => {
  test.setTimeout(90_000)
  const server = await startIsolatedServer()
  try {
    await setup(page, server.baseURL, server.token)
    await upload(page, 'idle-secret.txt', Buffer.alloc(128 * 1024, 65))
    await page.evaluate(() => {
      const state = { held: false, bytes: 0, closed: false }
      const target = window as Window & { idleSink?: typeof state; releaseIdleSink?: () => void }
      target.idleSink = state
      let release = () => {}
      const gate = new Promise<void>((resolve) => { release = resolve })
      target.releaseIdleSink = release
      Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: async () => ({
        createWritable: async () => new WritableStream<Uint8Array>({
          async write(bytes) { state.bytes += bytes.byteLength; if (!state.held && bytes.byteLength >= 64 * 1024) { state.held = true; await gate } },
          close() { state.closed = true },
        }),
      }) })
    })
    await page.getByRole('button', { name: kind === 'zip' ? '下载为 ZIP' : '下载 idle-secret.txt', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (window as Window & { idleSink?: { held: boolean } }).idleSink?.held)).toBe(true)
    await page.clock.fastForward(11 * minute)
    await unlocked(page)
    await page.evaluate(() => (window as Window & { releaseIdleSink?: () => void }).releaseIdleSink?.())
    await expect.poll(() => page.evaluate(() => (window as Window & { idleSink?: { closed: boolean } }).idleSink?.closed)).toBe(true)
    await expect(page.getByRole('status')).toContainText(kind === 'zip' ? 'ZIP 文件已保存。' : '文件已保存。')
    await freshDeadline(page)
  } finally { await page.evaluate(() => (window as Window & { releaseIdleSink?: () => void }).releaseIdleSink?.()).catch(() => {}); await server.close() }
})

test('waiting for a folder conflict decision does not prevent locking and releases the mutation queue', async ({ page }) => {
  test.setTimeout(90_000)
  const server = await startIsolatedServer(), root = mkdtempSync(join(tmpdir(), 'xdrive-idle-folder-')), bundle = join(root, 'bundle')
  mkdirSync(bundle); writeFileSync(join(bundle, 'idle-secret.txt'), 'folder idle fixture')
  try {
    await setup(page, server.baseURL, server.token)
    await page.locator('input[webkitdirectory]').setInputFiles(bundle)
    await expect(page.getByRole('status')).toContainText('文件夹上传完成，共 1 个文件。')
    await page.locator('input[webkitdirectory]').setInputFiles(bundle)
    await expect(page.getByRole('dialog', { name: '文件夹上传冲突' })).toBeVisible()
    await page.clock.fastForward(10 * minute + 1000)
    await locked(page)
    await expect.poll(() => page.evaluate(async () => (await navigator.locks.query()).held?.filter((lock) => lock.name?.startsWith('xdrive')).length)).toBe(0)
    await unlock(page)
    await page.locator('input[webkitdirectory]').setInputFiles(bundle)
    const dialog = page.getByRole('dialog', { name: '文件夹上传冲突' })
    await dialog.getByRole('button', { name: '全部跳过', exact: true }).click()
    await dialog.getByRole('button', { name: '确认处理并上传' }).click()
    await expect(page.getByRole('status')).toContainText('文件夹上传完成，共 0 个文件，跳过 1 个。')
  } finally { await server.close(); rmSync(root, { recursive: true, force: true }) }
})

test('video playback suspends idle lock, pause restarts it and locking revokes its local session', async ({ page, browserName }) => {
  test.setTimeout(90_000)
  const server = await startIsolatedServer()
  try {
    await setup(page, server.baseURL, server.token)
    await upload(page, 'idle-video.mp4', readFileSync(join(import.meta.dirname, '..', '..', 'tests', 'testdata', 'media', 'front-moov.mp4')))
    await page.getByRole('button', { name: 'idle-video.mp4', exact: true }).click()
    const video = page.locator('video')
    await expect(video).toHaveAttribute('src', browserName === 'firefox' ? /^blob:/u : /^\/__xdrive_media\//u, { timeout: 30_000 })
    const url = await video.getAttribute('src')
    await video.evaluate(async (element: HTMLVideoElement) => { element.muted = true; element.loop = true; await element.play() })
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0)
    await video.evaluate((element: HTMLVideoElement) => { element.currentTime = 2 })
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => !element.seeking && element.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA)).toBe(true)
    await page.clock.fastForward(11 * minute)
    await expect(video).toBeVisible()
    expect(await video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false)
    await video.evaluate((element: HTMLVideoElement) => element.pause())
    await page.clock.fastForward(9 * minute)
    await expect(video).toBeVisible()
    await page.clock.fastForward(minute + 1000)
    await locked(page)
    await expect(video).toHaveCount(0)
    if (browserName === 'firefox') {
      await expect.poll(() => page.evaluate(async (blobURL) => {
        try { await fetch(blobURL!); return 'readable' } catch { return 'revoked' }
      }, url)).toBe('revoked')
    } else {
      await expect.poll(() => page.evaluate(async (mediaURL) => (await fetch(mediaURL!, { headers: { Range: 'bytes=0-127' } })).status, url)).toBe(410)
    }
  } finally { await server.close() }
})
