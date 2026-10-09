import { expect, test, type Page } from './legacy-list-test'
import { startIsolatedServer } from './isolated-server'

for (const mobile of [false, true]) test(`move and trash folded paths return to the named encrypted ancestor and cancel abandoned reads (${mobile ? 'mobile' : 'desktop'})`, async ({ page }, testInfo) => {
  test.setTimeout(120000)
  if (mobile) await page.setViewportSize({ width: 390, height: 844 })
  const server = await startIsolatedServer()
  const names = ['scope-A', 'scope-B', 'scope-C', 'scope-D', 'scope-E']
  const ids: string[] = []
  const releases: (() => void)[] = []
  async function heldRead(id: string) {
    let reach!: () => void, release!: () => void, finish!: () => void, fail!: () => void
    const reached = new Promise<void>(resolve => { reach = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const finished = new Promise<void>(resolve => { finish = resolve })
    const failed = new Promise<void>(resolve => { fail = resolve })
    const url = `**/api/v1/metadata/${id}`
    const handler = async (route: Parameters<Parameters<Page['route']>[1]>[0]) => {
      const response = await route.fetch(); reach(); await gate
      await route.fulfill({ response }).catch(() => undefined); finish()
    }
    const onFailed = (request: Parameters<Parameters<Page['on']>[1]>[0]) => {
      if ('url' in request && typeof request.url === 'function' && request.url().endsWith(`/metadata/${id}`)) fail()
    }
    page.on('requestfailed', onFailed)
    await page.route(url, handler)
    releases.push(release)
    return { reached, failed, release, done: async () => { release(); await finished; await page.unroute(url, handler); page.off('requestfailed', onFailed) } }
  }
  try {
    await page.goto(`${server.baseURL}/setup#${server.token}`)
    await page.getByLabel('设置密码').fill('correct horse battery')
    await page.getByLabel('再次输入密码').fill('correct horse battery')
    await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
    await page.getByRole('button', { name: '创建加密云盘' }).click()
    for (const name of names) {
      await expect(page.getByRole('button', { name: '新建文件夹', exact: true })).toBeEnabled()
      page.once('dialog', dialog => void dialog.accept(name))
      await page.getByRole('button', { name: '新建文件夹', exact: true }).click()
      await expect(page.getByRole('status')).toContainText('文件夹已创建。')
      await page.getByRole('button', { name, exact: true }).click()
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: '上传', exact: true })).toBeEnabled()
      ids.push(page.url().split('/').at(-1)!)
    }
    await page.getByRole('navigation', { name: '文件夹路径', exact: true }).getByRole('button', { name: '我的文件', exact: true }).click()
    await expect(page.getByRole('button', { name: '上传', exact: true })).toBeEnabled()
    await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'move-source.txt', mimeType: 'text/plain', buffer: Buffer.from('scope navigation actual encrypted file') })
    await expect(page.getByRole('status')).toContainText('上传完成。')
    const move = page.getByRole('dialog', { name: '移动 move-source.txt', exact: true })
    const openMove = async () => {
      if (mobile) {
        await page.getByRole('button', { name: '更多操作 move-source.txt', exact: true }).click()
        await page.getByRole('dialog', { name: '项目操作 move-source.txt', exact: true }).getByRole('button', { name: '移动 move-source.txt', exact: true }).click()
      } else await page.getByRole('button', { name: '移动 move-source.txt', exact: true }).click()
    }
    await openMove()
    for (const name of names.slice(0, -1)) await move.getByRole('button', { name, exact: true }).click()
    const pendingMove = await heldRead(ids[4]!)
    await move.getByRole('button', { name: names[4], exact: true }).click(); await pendingMove.reached
    await move.getByRole('button', { name: '关闭移动对话框' }).click(); await pendingMove.failed
    await pendingMove.done(); await expect(move).toHaveCount(0)
    await openMove()
    for (const name of names) await move.getByRole('button', { name, exact: true }).click()
    const targetPath = move.getByRole('navigation', { name: '目标文件夹路径' })
    await targetPath.getByText('…', { exact: true }).click()
    await page.screenshot({ path: testInfo.outputPath('move-folded-path.png') })
    page.on('console', message => { if (message.text().startsWith('breadcrumb-focus:')) console.log(message.text()) })
    await page.evaluate(() => {
      document.addEventListener('focusout', event => {
        const target = event.target as HTMLElement
        if (target.closest('details')) console.log(`breadcrumb-focus:${target.tagName}:${(event.relatedTarget as HTMLElement | null)?.tagName ?? 'null'}`)
      }, { capture: true })
    })
    await targetPath.getByRole('button', { name: names[1], exact: true }).click()
    await expect(move.getByRole('button', { name: names[2], exact: true })).toBeVisible()
    await expect(move.getByRole('button', { name: '移动到此文件夹' })).toBeEnabled()
    await move.getByRole('button', { name: '移动到此文件夹' }).click(); await expect(move).toHaveCount(0)
    for (const name of names.slice(0, 2)) {
      await page.getByRole('button', { name, exact: true }).click()
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
    }
    await expect(page.getByRole('button', { name: 'move-source.txt', exact: true })).toBeVisible()
    await page.getByRole('navigation', { name: '文件夹路径', exact: true }).getByRole('button', { name: '我的文件', exact: true }).click()
    await page.getByRole('checkbox', { name: `选择 ${names[0]}`, exact: true }).check()
    await page.getByRole('button', { name: '移到回收站所选', exact: true }).click()
    await page.getByRole('button', { name: '确认移到回收站', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('button', { name: names[0], exact: true })).toHaveCount(0)
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '回收站', exact: true }).click()
    for (const name of names) {
      await page.getByRole('button', { name, exact: true }).click()
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
    }
    const trashPath = page.getByRole('navigation', { name: '回收站路径' })
    if (mobile) {
      const current = trashPath.locator('[aria-current="page"]')
      expect(await current.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await expect(page.getByRole('button', { name: '恢复', exact: true }).locator('svg')).toBeVisible()
      await expect(page.getByRole('button', { name: '永久删除', exact: true }).locator('svg')).toBeVisible()
    }
    await trashPath.getByText('…', { exact: true }).click()
    await page.screenshot({ path: testInfo.outputPath('trash-folded-path.png') })
    await trashPath.getByRole('button', { name: names[1], exact: true }).click()
    await expect(page.getByRole('heading', { name: names[1], exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'move-source.txt', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: names[2], exact: true })).toBeVisible()
    const pendingTrash = await heldRead(ids[2]!)
    await page.getByRole('button', { name: names[2], exact: true }).click(); await pendingTrash.reached
    await trashPath.getByRole('button', { name: '回收站', exact: true }).click(); await pendingTrash.failed
    await pendingTrash.done()
    await expect(page.getByRole('heading', { name: '回收站', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: names[2], exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: names[0], exact: true }).click()
    await expect(page.getByRole('button', { name: names[1], exact: true })).toBeVisible()
    const pendingLock = await heldRead(ids[1]!)
    await page.getByRole('button', { name: names[1], exact: true }).click(); await pendingLock.reached
    await page.getByRole('button', { name: '锁定云盘', exact: true }).click(); await pendingLock.failed
    await pendingLock.done()
    await expect(page.getByRole('heading', { name: '重新解锁云盘', exact: true })).toBeVisible()
    await expect(page.locator('body')).not.toContainText('scope-')
  } finally { for (const release of releases) release(); await server.close() }
})
