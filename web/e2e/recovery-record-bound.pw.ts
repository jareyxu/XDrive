import { expect, test, type Page } from '@playwright/test'
import { startIsolatedServer } from './isolated-server'

const password = 'correct horse battery'
const recordCount = 4097

async function setup(page: Page, baseURL: string, token: string) {
  await page.goto(`${baseURL}/setup#${token}`)
  await page.getByLabel('设置密码').fill(password)
  await page.getByLabel('再次输入密码').fill(password)
  await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
  await page.getByRole('button', { name: '创建加密云盘' }).click()
  await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 30_000 })
}

test('too many encrypted recovery rows are rejected before decryption in the real browser', async ({ page }) => {
  test.setTimeout(120_000)
  const server = await startIsolatedServer()
  try {
    await setup(page, server.baseURL, server.token)
    await page.getByRole('button', { name: '锁定云盘', exact: true }).click()
    await expect(page.getByRole('heading', { name: '重新解锁云盘', exact: true })).toBeVisible()

    const seeded = await page.evaluate(async (count) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('xdrive-local-v1', 1)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction('encrypted-records', 'readwrite')
          const store = transaction.objectStore('encrypted-records')
          for (let index = 0; index < count; index++) {
            store.put({
              id: `resume-fixture-${String(index).padStart(6, '0')}`,
              encrypted: 'A'.repeat(48),
            })
          }
          transaction.oncomplete = () => resolve()
          transaction.onabort = () => reject(transaction.error ?? new Error('fixture transaction aborted'))
          transaction.onerror = () => reject(transaction.error ?? new Error('fixture transaction failed'))
        })
        return count
      } finally {
        database.close()
      }
    }, recordCount)
    expect(seeded).toBe(recordCount)

    await page.evaluate(() => {
      const target = window as Window & { xdriveRecoveryCursorCounts?: number[] }
      target.xdriveRecoveryCursorCounts = []
      const originalOpenCursor = IDBObjectStore.prototype.openCursor
      IDBObjectStore.prototype.openCursor = function (query?: IDBValidKey | IDBKeyRange, direction?: IDBCursorDirection) {
        const request = originalOpenCursor.call(this, query, direction)
        if (this.transaction.db.name === 'xdrive-local-v1' && this.transaction.mode === 'readonly') {
          request.addEventListener('success', () => {
            if (request.result) target.xdriveRecoveryCursorCounts?.push(target.xdriveRecoveryCursorCounts.length + 1)
          })
        }
        return request
      }
    })

    await page.getByLabel('密码', { exact: true }).fill(password)
    await page.getByRole('button', { name: '解锁云盘' }).click()
    await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('alert')).toContainText('无法读取本地加密恢复记录', { timeout: 30_000 })
    await expect.poll(() => page.evaluate(() => (window as Window & { xdriveRecoveryCursorCounts?: number[] }).xdriveRecoveryCursorCounts ?? [])).toHaveLength(4097)
  } finally {
    await server.close()
  }
})
