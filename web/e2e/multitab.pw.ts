import { expect, test, type Page } from './legacy-list-test'
import { startIsolatedServer } from './isolated-server'
import type { BrowserContext } from '@playwright/test'

async function recordCoordinationMessages(context: BrowserContext) {
  await context.addInitScript(() => {
    const target = window as Window & { __xdriveCoordinationMessages?: unknown[] }
    target.__xdriveCoordinationMessages = []
    const original = BroadcastChannel.prototype.postMessage
    BroadcastChannel.prototype.postMessage = function (message: unknown) {
      if (this.name === 'xdrive-mutations-v1') {
        try { target.__xdriveCoordinationMessages?.push(structuredClone(message)) }
        catch { target.__xdriveCoordinationMessages?.push({ captureError: true }) }
      }
      return original.call(this, message)
    }
  })
}

async function expectOpaqueCoordinationMessages(pages: Page[], privateNames: string[]) {
  const messages = (await Promise.all(pages.map((page) => page.evaluate(() => {
    const target = window as Window & { __xdriveCoordinationMessages?: unknown[] }
    return target.__xdriveCoordinationMessages ?? []
  })))).flat()
  expect(messages.length).toBeGreaterThan(0)
  for (const message of messages) {
    expect(message).toEqual(expect.objectContaining({
      kind: expect.stringMatching(/^(invalidate|owner-change)$/u),
      scope: expect.stringMatching(/^[A-Za-z0-9_-]{16,64}$/u),
    }))
    expect(Object.keys(message as Record<string, unknown>).sort()).toEqual(['kind', 'scope'])
  }
  const serialized = JSON.stringify(messages)
  for (const name of privateNames) expect(serialized).not.toContain(name)
}

async function setup(page: Page, url: string) {
  await page.goto(url)
  await page.getByLabel('设置密码').fill('correct horse battery')
  await page.getByLabel('再次输入密码').fill('correct horse battery')
  await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
  await page.getByRole('button', { name: '创建加密云盘' }).click()
  await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible({ timeout: 30_000 })
}
async function unlock(page: Page, url: string) {
  await page.goto(url)
  await page.getByLabel('密码', { exact: true }).fill('correct horse battery')
  await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
  await expect(page.getByRole('heading', { name: '我的文件' })).toBeVisible()
}
async function create(page: Page, name: string) {
  page.once('dialog', (dialog) => void dialog.accept(name))
  await page.getByRole('button', { name: '新建文件夹', exact: true }).click()
}
test('local tabs serialize full mutations and invalidate peer directory state', async ({ page, context }) => {
  test.setTimeout(120_000)
  await recordCoordinationMessages(context)
  const server = await startIsolatedServer()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  try {
    await setup(page, `${server.baseURL}/setup#${server.token}`)
    const peer = await context.newPage()
    await unlock(peer, `${server.baseURL}/login`)
    let arrived!: () => void
    const receiving = new Promise<void>((resolve) => { arrived = resolve })
    await page.route('**/api/v1/metadata/transactions', async (route) => { arrived(); await gate; await route.continue() })
    let peerCommits = 0
    peer.on('request', (request) => { if (request.url().endsWith('/api/v1/metadata/transactions')) peerCommits += 1 })
    await create(page, 'local-a')
    await receiving
    await create(peer, 'local-b')
    await expect.poll(() => page.evaluate(async () => (await navigator.locks.query()).pending?.filter((item) => item.name?.startsWith('xdrive:mutation:v1:')).length)).toBe(1)
    expect(peerCommits).toBe(0)
    release()
    await expect(peer.getByRole('button', { name: 'local-b', exact: true })).toBeVisible()
    await expect(peer.getByRole('button', { name: 'local-a', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'local-b', exact: true })).toBeVisible()
    expect(peerCommits).toBe(1)
    const messages = await page.evaluate(async () => {
      const request = indexedDB.open('xdrive-writer-v1', 1)
      return new Promise<boolean>((resolve) => { request.onupgradeneeded = () => { request.transaction?.abort(); resolve(false) }; request.onsuccess = () => { request.result.close(); resolve(true) } })
    })
    expect(messages).toBe(false) // Web Locks mode does not persist writer claims.
    await expectOpaqueCoordinationMessages([page, peer], ['local-a', 'local-b', 'correct horse battery'])
  } finally { release(); await server.close() }
})
test('without Web Locks IDB chooses one writer; explicit recovery revokes its prior owner', async ({ page, context }) => {
  test.setTimeout(120_000)
  await recordCoordinationMessages(context)
  await context.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true }))
  const server = await startIsolatedServer()
  try {
    await setup(page, `${server.baseURL}/setup#${server.token}`)
    await expect(page.getByRole('status').filter({ hasText: '当前标签页负责写入' })).toBeVisible()
    const peer = await context.newPage()
    await unlock(peer, `${server.baseURL}/login`)
    await expect(peer.getByRole('button', { name: '新建文件夹', exact: true })).toBeDisabled()
    await create(page, 'fallback-a')
    await expect(peer.getByRole('button', { name: 'fallback-a', exact: true })).toBeVisible()
    peer.once('dialog', (dialog) => void dialog.accept())
    await peer.getByRole('button', { name: '关闭其他标签页后接管写入', exact: true }).click()
    await expect(page.getByRole('button', { name: '新建文件夹', exact: true })).toBeDisabled()
    await create(peer, 'fallback-b')
    await expect(page.getByRole('button', { name: 'fallback-b', exact: true })).toBeVisible()
    await peer.getByRole('button', { name: '锁定云盘', exact: true }).click()
    // Graceful lock releases ownership; the former reader can claim it safely.
    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('button', { name: '关闭其他标签页后接管写入', exact: true }).click()
    await expect(page.getByRole('button', { name: '新建文件夹', exact: true })).toBeEnabled()
    await expectOpaqueCoordinationMessages([page, peer], ['fallback-a', 'fallback-b', 'correct horse battery'])
  } finally { await server.close() }
})
