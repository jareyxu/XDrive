import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'

export interface MediaResourceTarget {
  baseURL: string
  password: string
}

/**
 * An opt-in target for media resource tests against an already provisioned,
 * isolated Linux validation guest. The default E2E path remains self-contained.
 */
export function loadMediaResourceTarget(): MediaResourceTarget | undefined {
  const statePath = process.env.XDRIVE_MEDIA_RESOURCE_STATE_PATH
  if (!statePath) return undefined

  const parsed: unknown = JSON.parse(readFileSync(statePath, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) throw new TypeError('media resource state must be a JSON object')
  const state = parsed as Record<string, unknown>
  if (typeof state.baseURL !== 'string' || typeof state.password !== 'string' || state.password.length === 0) {
    throw new TypeError('media resource state must contain baseURL and password')
  }

  const url = new URL(state.baseURL)
  if (url.protocol !== 'https:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new TypeError('media resource target must be an HTTPS loopback URL')
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('media resource target must contain only an HTTPS loopback origin')
  }

  return { baseURL: url.origin, password: state.password }
}

export async function unlockMediaResourceTarget(page: Page, target: MediaResourceTarget) {
  await page.goto(`${target.baseURL}/drive`)
  const password = page.getByLabel('密码', { exact: true })
  await expect(password).toBeVisible({ timeout: 30_000 })
  const username = page.locator('#login-username')
  if (await username.count()) {
    await username.fill('admin')
    await expect(username).toHaveValue('admin')
  }
  await password.fill(target.password)
  await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
  await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 30_000 })
}
