import { readFileSync, writeFileSync } from 'node:fs'
import { expect, test, type Page } from './legacy-list-test'
import { EncryptedDirectoryFixture } from './encrypted-directory-fixture'

const statePath = process.env.XDRIVE_RESOURCE_STATE_PATH
if (!statePath) throw new TypeError('XDRIVE_RESOURCE_STATE_PATH is required')

test('1 GiB guest renders and rejects 1000/5000 encrypted entries with bounded virtual lists', async ({ page, context }, testInfo) => {
  test.setTimeout(20 * 60_000)
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as { password: string; baseURL: string }
  const baseURL = state.baseURL
  if (new URL(baseURL).hostname !== 'localhost') throw new TypeError('resource fixture is restricted to the task-owned localhost guest')
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`${baseURL}/drive`)
  await expect(page.getByRole('heading', { name: '重新解锁云盘' })).toBeVisible({ timeout: 60_000 })
  await page.getByLabel('密码').fill(state.password)
  await page.getByRole('button', { name: '解锁云盘' }).click()
  await expect(page.getByRole('button', { name: 'resource-quota-8g-zero.bin', exact: true })).toBeVisible({ timeout: 120_000 })
  await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()

  const cookie = (await context.cookies(baseURL)).find((item) => item.name === 'xdrive_session' && item.domain.replace(/^\./u, '') === 'localhost')
  if (!cookie) throw new Error('resource fixture browser session cookie missing')
  const fixture = await EncryptedDirectoryFixture.open(context.request, baseURL, state.password, `${cookie.name}=${cookie.value}`, true)
  const measurements: Record<string, unknown>[] = []

  for (const count of [1000, 5000]) {
    await page.getByRole('button', { name: '锁定云盘', exact: true }).click()
    const buildStarted = performance.now()
    const details = await fixture.growTo(count)
    const buildMilliseconds = performance.now() - buildStarted
    let metadataRequestAt = 0
    const observe = (request: { url(): string }) => {
      if (request.url().endsWith(`/api/v1/metadata/${fixture.rootId}`)) metadataRequestAt = performance.now()
    }
    page.on('request', observe)
    await page.getByLabel('密码', { exact: true }).fill(state.password)
    await page.getByRole('button', { name: '解锁云盘' }).click()
    await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 120_000 })
    await expect(page.locator('.item-count')).toHaveText(`${count} 项`)
    page.off('request', observe)
    if (!metadataRequestAt) throw new Error(`root metadata request was not observed for ${count} entries`)
    const firstInteractiveMilliseconds = performance.now() - metadataRequestAt
    if (count === 1000) expect(firstInteractiveMilliseconds).toBeLessThanOrEqual(1500)
    expect(details.rootEncryptedBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
    const first = page.locator('.virtual-entry-list [role="listitem"][aria-posinset="1"]')
    await first.focus()
    await first.press('End')
    const last = page.locator(`.virtual-entry-list [role="listitem"][aria-posinset="${count}"]`)
    await expect(last).toBeFocused()
    await expect(last).toHaveAttribute('aria-setsize', String(count))
    const list = await measureList(page)
    expect(list.rows).toBeLessThanOrEqual(list.rowBudget)
    measurements.push({ count, buildMilliseconds, firstInteractiveMilliseconds, rootEncryptedBytes: details.rootEncryptedBytes, globalRevision: details.globalRevision, ...list })

    if (count === 5000) {
      let writes = 0
      const countWrites = (request: { url(): string; method(): string }) => {
        if (request.method() === 'POST' && /\/api\/v1\/(uploads|metadata\/transactions)/u.test(request.url())) writes += 1
      }
      page.on('request', countWrites)
      page.once('dialog', (dialog) => void dialog.accept('capacity-excess'))
      await page.getByRole('button', { name: '新建文件夹' }).click()
      await expect(page.getByRole('alert')).toContainText('5000')
      page.off('request', countWrites)
      expect(writes).toBe(0)
    }
  }

  await page.getByRole('button', { name: '锁定云盘', exact: true }).click()
  await expect(page.getByRole('listitem')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('folder-00008')
  await expect(page.locator('body')).not.toContainText('folder-04999')
  const report = { guest: 'Debian 12 amd64, 1 vCPU, 1024 MiB RAM, 25 GiB disk', browser: 'Chromium', measurements, fixture: 'Production client crypto/envelope and public API; synthetic directories are removed by restoring the verified guest baseline after the run.' }
  const reportPath = testInfo.outputPath('resource-vps-directory-report.json')
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
  await testInfo.attach('resource-vps-directory-report.json', { path: reportPath, contentType: 'application/json' })
})

async function measureList(page: Page) {
  return page.locator('.virtual-entry-list').evaluate((list) => {
    const rowHeight = Number.parseFloat(getComputedStyle(list).getPropertyValue('--entry-row-height'))
    return { rows: list.querySelectorAll('[role="listitem"]').length, height: list.clientHeight, rowHeight, rowBudget: Math.ceil(list.clientHeight / rowHeight) + 16 }
  })
}
