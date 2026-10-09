import { expect, test, type Page } from './legacy-list-test'
import { startIsolatedServer } from './isolated-server'

async function setup(page: Page, baseURL: string, token: string) {
  await page.goto(`${baseURL}/setup#${token}`)
  await page.getByLabel('设置密码').fill('correct horse battery')
  await page.getByLabel('再次输入密码').fill('correct horse battery')
  await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
  await page.getByRole('button', { name: '创建加密云盘' }).click()
  await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 30_000 })
}

test('records directory acquisition APIs on the real secure browser origin', async ({ page }, testInfo) => {
  const server = await startIsolatedServer()
  try {
    await page.goto(server.baseURL)
    const capabilities = await page.evaluate(() => {
      const input = document.createElement('input')
      const transferItem = typeof DataTransferItem === 'undefined' ? null : DataTransferItem.prototype
      return {
        secureContext: window.isSecureContext,
        showDirectoryPicker: typeof (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function',
        webkitDirectoryInput: 'webkitdirectory' in input,
        directoryInput: 'directory' in input,
        fileSystemDragHandle: transferItem !== null && 'getAsFileSystemHandle' in transferItem,
        webkitDragEntry: transferItem !== null && 'webkitGetAsEntry' in transferItem,
      }
    })
    await testInfo.attach('s5-folder-api-capabilities', { body: JSON.stringify(capabilities, null, 2), contentType: 'application/json' })
    console.info(`S5 folder APIs (${process.env.XDRIVE_E2E_BROWSER ?? testInfo.project.name ?? 'unknown'}): ${JSON.stringify(capabilities)}`)
    expect(capabilities.secureContext).toBe(true)
  } finally { await server.close() }
})

test('injected directory picker handle preserves hierarchy through encrypted upload and preview', async ({ page }) => {
  test.setTimeout(90_000)
  const server = await startIsolatedServer()
  try {
    await setup(page, server.baseURL, server.token)
    await page.evaluate(() => {
      Object.defineProperty(window, 'showDirectoryPicker', {
        configurable: true,
        value: async () => ({
          kind: 'directory', name: 'picked-bundle',
          async *values() {
            yield {
              kind: 'directory', name: 'nested',
              async *values() {
                yield { kind: 'file', name: 'picked.txt', getFile: async () => new File(['native picker bytes'], 'picked.txt', { type: 'text/plain' }) }
              },
            }
          },
        }),
      })
    })
    await page.getByRole('button', { name: '上传文件夹', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: '文件夹上传完成，共 1 个文件。' })).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: 'picked-bundle', exact: true }).click()
    await page.getByRole('button', { name: 'nested', exact: true }).click()
    await page.getByRole('button', { name: 'picked.txt', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '预览 picked.txt' })).toContainText('native picker bytes')
  } finally { await server.close() }
})

test('cancelling the directory picker is silent and starts no upload', async ({ page }) => {
  test.setTimeout(90_000)
  const server = await startIsolatedServer()
  try {
    await page.addInitScript(() => {
      const testWindow = window as Window & { __xdrivePickerCancelled?: boolean }
      Object.defineProperty(testWindow, 'showDirectoryPicker', {
        configurable: true,
        value: async () => {
          testWindow.__xdrivePickerCancelled = true
          throw new DOMException('User cancelled the directory picker.', 'AbortError')
        },
      })
    })
    await setup(page, server.baseURL, server.token)
    const writes: string[] = []
    page.on('request', request => {
      if (['POST', 'PUT', 'DELETE'].includes(request.method()) && /\/api\/v1\/(uploads|metadata\/transactions)/u.test(new URL(request.url()).pathname)) {
        writes.push(`${request.method()} ${new URL(request.url()).pathname}`)
      }
    })
    await page.getByRole('button', { name: '上传文件夹', exact: true }).click()
    await page.waitForFunction(() => (window as Window & { __xdrivePickerCancelled?: boolean }).__xdrivePickerCancelled === true)
    await page.evaluate(() => new Promise<void>(resolve => window.setTimeout(resolve, 0)))
    await expect(page.getByRole('alert')).toHaveCount(0)
    expect(writes).toEqual([])
  } finally { await server.close() }
})

test('external folder drop shows a copy target and uploads the dropped tree encrypted', async ({ page }) => {
  test.setTimeout(90_000)
  const server = await startIsolatedServer()
  try {
    await setup(page, server.baseURL, server.token)
    await page.locator('.drive-main').evaluate((target) => {
      const item = {
        kind: 'file',
        getAsFileSystemHandle: async () => ({
          kind: 'directory', name: 'dropped-bundle',
          async *values() {
            yield {
              kind: 'directory', name: 'nested',
              async *values() {
                yield { kind: 'file', name: 'dropped.txt', getFile: async () => new File(['external folder bytes'], 'dropped.txt', { type: 'text/plain' }) }
              },
            }
          },
        }),
        webkitGetAsEntry: () => null,
        getAsFile: () => null,
      }
      const transfer = { types: ['Files'], items: [item], files: [] }
      ;(window as Window & { __xdriveFolderDrop?: typeof transfer }).__xdriveFolderDrop = transfer
      for (const type of ['dragenter', 'dragover']) {
        const event = new Event(type, { bubbles: true, cancelable: true })
        Object.defineProperty(event, 'dataTransfer', { value: transfer })
        target.dispatchEvent(event)
      }
    })
    await expect(page.getByRole('status').filter({ hasText: '放开以加密上传文件或文件夹' })).toBeVisible()
    const prevented = await page.locator('.drive-main').evaluate((target) => {
      const event = new Event('drop', { bubbles: true, cancelable: true })
      const transfer = (window as Window & { __xdriveFolderDrop?: DataTransfer }).__xdriveFolderDrop
      Object.defineProperty(event, 'dataTransfer', { value: transfer })
      target.dispatchEvent(event)
      return event.defaultPrevented
    })
    expect(prevented).toBe(true)
    await expect(page.getByRole('status').filter({ hasText: '文件夹上传完成，共 1 个文件。' })).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: 'dropped-bundle', exact: true }).click()
    await page.getByRole('button', { name: 'nested', exact: true }).click()
    await page.getByRole('button', { name: 'dropped.txt', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '预览 dropped.txt' })).toContainText('external folder bytes')
  } finally { await server.close() }
})

test('empty native directory explains the limitation without starting an upload', async ({ page }) => {
  test.setTimeout(90_000)
  const server = await startIsolatedServer()
  try {
    await page.addInitScript(() => Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: async () => ({ kind: 'directory', name: 'empty-folder', async *values() {} }),
    }))
    await setup(page, server.baseURL, server.token)
    const writes: string[] = []
    page.on('request', request => {
      if (['POST', 'PUT', 'DELETE'].includes(request.method()) && /\/api\/v1\/(uploads|metadata\/transactions)/u.test(new URL(request.url()).pathname)) {
        writes.push(`${request.method()} ${new URL(request.url()).pathname}`)
      }
    })
    await page.getByRole('button', { name: '上传文件夹', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('浏览器不会提供空目录条目')
    expect(writes).toEqual([])
  } finally { await server.close() }
})
