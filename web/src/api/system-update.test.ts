import { afterEach, expect, it, vi } from 'vitest'
import { fetchCurrentSession, fetchSystemUpdateInfo, startSystemUpdate } from './client'

afterEach(() => vi.unstubAllGlobals())

it('accepts only the project release page when checking for updates', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    currentVersion: 'v1.3.1', latestVersion: 'v1.4.0', name: 'XDrive 1.4.0',
    releaseUrl: 'https://github.com/jareyxu/XDrive/releases/tag/v1.4.0',
    publishedAt: '2026-10-09T00:00:00Z', releaseNotes: 'Stable release', updateAvailable: true, canInstall: true,
  }), { headers: { 'Content-Type': 'application/json' } })))
  await expect(fetchSystemUpdateInfo()).resolves.toMatchObject({ latestVersion: 'v1.4.0', updateAvailable: true, canInstall: true })
})

it('rejects a release URL outside the official GitHub repository', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    currentVersion: 'v1.3.1', latestVersion: 'v1.4.0', name: 'XDrive 1.4.0',
    releaseUrl: 'https://example.com/releases/v1.4.0', publishedAt: '', releaseNotes: '', updateAvailable: true, canInstall: true,
  }), { headers: { 'Content-Type': 'application/json' } })))
  await expect(fetchSystemUpdateInfo()).rejects.toThrow('更新信息格式无效')
})

it('sends update approval with the session CSRF token and protocol header', async () => {
  let observed: RequestInit | undefined
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/auth/session')) return new Response(JSON.stringify({ authenticated: true, username: 'admin', vaultConfig: { formatVersion: 2, revision: 1, slots: [] } }), { headers: { 'X-CSRF-Token': 'session-csrf' } })
    observed = init
    return new Response(JSON.stringify({ id: 'abcdefghijklmnopqrstu_', version: 'v1.4.0', state: 'queued', updatedAt: 1 }), { status: 202, headers: { 'Content-Type': 'application/json' } })
  }))
  await fetchCurrentSession()
  await startSystemUpdate('v1.4.0')
  const headers = new Headers(observed?.headers)
  expect(headers.get('X-CSRF-Token')).toBe('session-csrf')
  expect(headers.get('X-XDrive-Client-Protocol')).toBeTruthy()
  expect(observed?.method).toBe('POST')
  expect(observed?.body).toBe(JSON.stringify({ version: 'v1.4.0' }))
})
