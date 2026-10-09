import { expect, test } from './legacy-list-test'
import { startIsolatedServer } from './isolated-server'
const password = 'correct horse battery'
for (const action of ['storage', 'lock'] as const) test(`real directory AEAD finishing after ${action} skips plaintext parsing and revision observation`, async ({ page }) => {
  test.setTimeout(90000)
  const server = await startIsolatedServer()
  try {
    await page.goto(`${server.baseURL}/setup#${server.token}`)
    await page.getByLabel('设置密码').fill(password); await page.getByLabel('再次输入密码').fill(password)
    await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
    await page.getByRole('button', { name: '创建加密云盘' }).click()
    await expect(page.getByRole('button', { name: '新建文件夹', exact: true })).toBeEnabled()
    page.once('dialog', dialog => void dialog.accept('late-index-parent'))
    await page.getByRole('button', { name: '新建文件夹', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('文件夹已创建。')
    await page.getByRole('button', { name: 'late-index-parent', exact: true }).click()
    await expect(page.getByRole('button', { name: '新建文件夹', exact: true })).toBeEnabled()
    const id = page.url().split('/').at(-1)!
    page.once('dialog', dialog => void dialog.accept('private-late-metadata'))
    await page.getByRole('button', { name: '新建文件夹', exact: true }).click()
    await expect(page.getByRole('button', { name: 'private-late-metadata', exact: true })).toBeVisible()
    await page.getByRole('navigation', { name: '文件夹路径', exact: true }).getByRole('button', { name: '我的文件', exact: true }).click()
    await expect(page.getByRole('button', { name: 'late-index-parent', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '上传', exact: true })).toBeEnabled()
    await page.evaluate(id => {
      const probe = { reached: false, finished: false, ended: false, positive: false, parses: 0, baselineReads: 0, positiveParses: 0, positiveReads: 0, plaintext: null as Uint8Array | null, release: () => {} }
      const gate = new Promise<void>(resolve => { probe.release = resolve })
      const decrypt = crypto.subtle.decrypt.bind(crypto.subtle)
      let held = false
      crypto.subtle.decrypt = async (...args: Parameters<SubtleCrypto['decrypt']>) => {
        const result = await decrypt(...args)
        if (!held && new TextDecoder().decode(result).includes(`"indexId":"${id}"`)) {
          held = true; probe.plaintext = new Uint8Array(result); probe.reached = true; await gate; probe.finished = true
        }
        return result
      }
      const parse = JSON.parse
      JSON.parse = (...args: Parameters<typeof JSON.parse>) => {
        if (args[0].includes(`"indexId":"${id}"`)) {
          if (probe.ended) probe.parses++
          if (probe.positive) probe.positiveParses++
        }
        return parse(...args)
      }
      const get = IDBObjectStore.prototype.get
      IDBObjectStore.prototype.get = function (key) {
        if (this.name === 'maxima' && typeof key === 'string' && key.endsWith(`:metadata:${id}`)) {
          if (probe.ended) probe.baselineReads++
          if (probe.positive) probe.positiveReads++
        }
        return get.call(this, key)
      }
      Object.assign(window, { metadataAEADProbe: probe })
    }, id)
    await page.getByRole('button', { name: 'late-index-parent', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (window as Window & { metadataAEADProbe: { reached: boolean } }).metadataAEADProbe.reached)).toBe(true)
    if (action === 'lock') {
      await page.getByRole('button', { name: '锁定云盘', exact: true }).click()
      await expect(page.getByRole('heading', { name: '重新解锁云盘', exact: true })).toBeVisible()
    } else {
      await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '存储空间', exact: true }).click()
      await expect(page.getByRole('heading', { name: '存储空间', exact: true })).toBeVisible()
    }
    await page.evaluate(() => {
      const probe = (window as Window & { metadataAEADProbe: { ended: boolean; release: () => void } }).metadataAEADProbe
      probe.ended = true; probe.release()
    })
    await expect.poll(() => page.evaluate(() => {
      const probe = (window as Window & { metadataAEADProbe: { finished: boolean; plaintext: Uint8Array | null } }).metadataAEADProbe
      return probe.finished && probe.plaintext !== null && probe.plaintext.length > 0 && probe.plaintext.every(byte => byte === 0)
    })).toBe(true)
    expect(await page.evaluate(() => {
      const probe = (window as Window & { metadataAEADProbe: { parses: number; baselineReads: number } }).metadataAEADProbe
      return { parses: probe.parses, baselineReads: probe.baselineReads }
    })).toEqual({ parses: 0, baselineReads: 0 })
    await expect(page.locator('body')).not.toContainText('private-late-metadata')
    await page.evaluate(() => {
      const probe = (window as Window & { metadataAEADProbe: { ended: boolean; positive: boolean } }).metadataAEADProbe
      probe.ended = false; probe.positive = true
    })
    if (action === 'lock') {
      await page.getByLabel('密码', { exact: true }).fill(password)
      await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
    } else {
      await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的文件', exact: true }).click()
      await page.getByRole('button', { name: 'late-index-parent', exact: true }).click()
    }
    await expect(page.getByRole('button', { name: 'private-late-metadata', exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(() => {
      const probe = (window as Window & { metadataAEADProbe: { positiveParses: number; positiveReads: number } }).metadataAEADProbe
      return probe.positiveParses > 0 && probe.positiveReads > 0
    })).toBe(true)
  } finally {
    await page.evaluate(() => (window as Window & { metadataAEADProbe?: { release: () => void } }).metadataAEADProbe?.release()).catch(() => undefined)
    await server.close()
  }
})
