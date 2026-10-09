import { expect, test } from '@playwright/test'
import { startIsolatedServer } from './isolated-server'

test('trash displays actual server retention and never assumes thirty days after policy failure', async ({ page }) => {
  const server = await startIsolatedServer({ trashRetention: '48h' })
  try {
    await page.goto(`${server.baseURL}/setup#${server.token}`)
    await page.getByLabel('设置密码').fill('correct horse battery')
    await page.getByLabel('再次输入密码').fill('correct horse battery')
    await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
    await page.getByRole('button', { name: '创建加密云盘' }).click()
    await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: '回收站', exact: true }).click()
    await expect(page.locator('.content-heading .eyebrow')).toHaveText('保留 2 天')
    await expect(page.locator('body')).not.toContainText('保留 30 天')
    await page.getByRole('button', { name: '我的文件', exact: true }).click()
    await page.route('**/api/v1/system/info', route => route.fulfill({ status: 200, json: { trashRetentionSeconds: 0 } }))
    await page.getByRole('button', { name: '回收站', exact: true }).click()
    await expect(page.locator('.content-heading .eyebrow')).toContainText('保留期读取失败')
    await expect(page.locator('body')).not.toContainText('保留 30 天')
  } finally { await server.close() }
})
