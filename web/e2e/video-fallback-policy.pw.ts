import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { startIsolatedServer } from './isolated-server'

test('video Blob fallback uses actual policy, allows exact boundary and refuses excess or invalid policy before object reads', async ({ page, browserName }, testInfo) => {
  test.setTimeout(120_000)
  const source = readFileSync(join(import.meta.dirname, '..', '..', 'tests', 'testdata', 'media', 'front-moov.mp4'))
  const server = await startIsolatedServer({ videoBlobFallbackLimit: source.length })
  try {
    await page.addInitScript(() => {
      Object.defineProperty(navigator.serviceWorker, 'register', { value: () => Promise.reject(new TypeError('Unavailable test relay')) })
      const state = window as Window & { videoBlobDigests?: string[] }
      state.videoBlobDigests = []
      const original = URL.createObjectURL.bind(URL)
      URL.createObjectURL = object => {
        if (object instanceof Blob && object.type === 'video/mp4') {
          void object.arrayBuffer().then(bytes => crypto.subtle.digest('SHA-256', bytes)).then(digest => {
            state.videoBlobDigests!.push(Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''))
          })
        }
        return original(object)
      }
    })
    await page.goto(`${server.baseURL}/setup#${server.token}`)
    await page.getByLabel('设置密码').fill('correct horse battery')
    await page.getByLabel('再次输入密码').fill('correct horse battery')
    await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
    await page.getByRole('button', { name: '创建加密云盘' }).click()
    await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 30_000 })
    for (const [name, buffer] of [['exact.mp4', source], ['over.mp4', Buffer.concat([source, Buffer.from([0])])]] as const) {
      await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name, mimeType: 'video/mp4', buffer })
      await expect(page.getByRole('button', { name, exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(page.locator('input[type="file"]:not([webkitdirectory])').first()).toBeEnabled()
    }
    let reads = 0
    page.on('request', request => { if (request.method() === 'GET' && /\/api\/v1\/objects\//u.test(request.url())) reads++ })
    await page.getByRole('button', { name: 'over.mp4', exact: true }).click()
    await expect(page.locator('.video-preview-area [role="alert"]')).toContainText('内存播放上限')
    expect(reads).toBe(0)
    await page.keyboard.press('Escape')
    await page.evaluate(() => { (window as Window & { videoBlobDigests?: string[] }).videoBlobDigests = [] })
    await page.getByRole('button', { name: 'exact.mp4', exact: true }).click()
    const video = page.locator('.preview-video')
    if (browserName === 'firefox') {
      await expect(video).toHaveAttribute('src', /^blob:/u)
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(1)
      expect(reads).toBeGreaterThan(0)
      await expect.poll(() => page.evaluate(() => (window as Window & { videoBlobDigests?: string[] }).videoBlobDigests))
        .toContain(createHash('sha256').update(source).digest('hex'))
      await testInfo.attach('firefox-video-fallback', { body: JSON.stringify({ browserName, sourceBytes: source.length, exactBoundaryAllowed: true, digestMatches: true, boundedByServerPolicy: true }, null, 2), contentType: 'application/json' })
    } else {
      await expect(video).toHaveAttribute('src', /^blob:/u)
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(1)
      await expect.poll(() => page.evaluate(() => (window as Window & { videoBlobDigests?: string[] }).videoBlobDigests))
        .toContain(createHash('sha256').update(source).digest('hex'))
      expect(reads).toBeGreaterThan(0)
    }
    for (const policy of [undefined, 0, -1, 1.5, 536870913, '1024']) {
      await page.keyboard.press('Escape')
      await page.route('**/api/v1/system/info', route => route.fulfill({ status: 200, json: { videoBlobFallbackLimit: policy } }))
      reads = 0
      await page.getByRole('button', { name: 'exact.mp4', exact: true }).click()
      await expect(page.locator('.video-preview-area [role="alert"]')).toContainText('无法读取有效的视频内存播放上限')
      await expect(page.locator('.preview-video')).toHaveCount(0)
      expect(reads).toBe(0)
      await page.unroute('**/api/v1/system/info')
    }
    await page.keyboard.press('Escape')
    await page.route('**/api/v1/system/info', route => route.fulfill({ status: 503, json: { error: 'unavailable' } }))
    reads = 0
    await page.getByRole('button', { name: 'exact.mp4', exact: true }).click()
    await expect(page.locator('.video-preview-area [role="alert"]')).toBeVisible()
    await expect(page.locator('.preview-video')).toHaveCount(0)
    expect(reads).toBe(0)
  } finally { await server.close() }
})
