import { expect, test } from './legacy-list-test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startIsolatedServer } from './isolated-server'

test('setup reports storage and object conflicts accurately and can retry with the same token', async ({ page }) => {
  test.setTimeout(120_000)
  const server = await startIsolatedServer()
  const fixtures: string[] = []
  const errors: string[] = []
  let attempt = 0

  try {
    await page.route('**/api/v1/setup', async (route) => {
      if (attempt >= 5) {
        await route.continue()
        return
      }

      const currentAttempt = attempt++
      const payload = route.request().postDataJSON() as {
        token: string
        rootIndex: { encryptedObject: string; objectId: string }
        trashIndex: { encryptedObject: string; objectId: string }
      }
      if (currentAttempt === 0) {
        // Invalid setup tokens must not consume the real one or be mislabeled
        // as expired when the server may also report an already-complete setup.
        payload.token = 'invalid-setup-token'
      } else if (currentAttempt === 1) {
        // Exercise the real setup validator and verify the setup screen keeps
        // the safe, actionable server catalog message.
        payload.rootIndex.encryptedObject = 'eA=='
      } else if (currentAttempt === 2) {
        // The initial trash index is independently validated and must not
        // activate setup when its encrypted envelope is malformed.
        payload.trashIndex.encryptedObject = 'eA=='
      }
      const objectId = payload.rootIndex.objectId
      const shard = join(server.dataRoot, 'objects', objectId.slice(0, 2))
      if (currentAttempt === 3) {
        // MkdirAll on this shard fails, so setup must preserve its token and
        // report storage_unavailable rather than a state conflict.
        fixtures.push(shard)
        writeFileSync(shard, 'blocked object shard')
      } else if (currentAttempt === 4) {
        // Atomic publication must reject an existing object path without
        // replacing it and report setup_conflict.
        fixtures.push(shard)
        mkdirSync(shard, { recursive: true })
        const collision = join(shard, objectId)
        fixtures.push(collision)
        writeFileSync(collision, 'existing setup object')
      }

      try {
        const response = await route.fetch({ postData: JSON.stringify(payload) })
        const body = await response.json() as { error?: string }
        if (response.status() >= 400 && body.error) errors.push(body.error)
        await route.fulfill({ response })
      } finally {
        rmSync(shard, { recursive: true, force: true })
      }
    })

    await page.goto(`${server.baseURL}/setup#${server.token}`)
    await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()

    const submit = page.getByRole('button', { name: '创建加密云盘' })
    const submitWithPassword = async () => {
      await page.getByLabel('管理员用户名').fill('admin')
      await page.getByLabel('设置密码').fill('correct horse battery')
      await page.getByLabel('再次输入密码').fill('correct horse battery')
      await submit.click()
    }
    const expectPendingSetup = async () => {
      expect(await (await page.request.get(`${server.baseURL}/api/v1/status`)).json()).toMatchObject({ accountState: 'pending_setup' })
    }

    await submitWithPassword()
    await expect(page.getByRole('alert')).toContainText('设置链接可能无效、已过期或设置已完成', { timeout: 30_000 })
    await expect(page.getByRole('alert')).toContainText('请刷新确认账号状态')
    await expectPendingSetup()

    await submitWithPassword()
    await expect(page.getByRole('alert')).toContainText('首次设置数据未通过校验', { timeout: 30_000 })
    await expect(page.getByRole('alert')).not.toContainText('检查服务状态后重试')
    await expectPendingSetup()

    await submitWithPassword()
    await expect(page.getByRole('alert')).toContainText('首次设置中的回收站数据未通过校验', { timeout: 30_000 })
    await expectPendingSetup()

    await submitWithPassword()
    await expect(page.getByRole('alert')).toContainText('首次设置数据暂时无法写入', { timeout: 30_000 })
    await expectPendingSetup()

    await submitWithPassword()
    await expect(page.getByRole('alert')).toContainText('首次设置发生冲突，尚未完成', { timeout: 30_000 })
    await expect(page.getByRole('alert')).toContainText('仍显示未初始化，可重新提交')
    await expectPendingSetup()

    await submitWithPassword()
    await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 30_000 })
    expect(errors).toEqual(['setup_unavailable', 'invalid_root_index', 'invalid_trash_index', 'storage_unavailable', 'setup_conflict'])
    expect(await (await page.request.get(`${server.baseURL}/api/v1/status`)).json()).toMatchObject({ accountState: 'active' })
  } finally {
    for (const path of fixtures) rmSync(path, { recursive: true, force: true })
    await server.close()
  }
})
