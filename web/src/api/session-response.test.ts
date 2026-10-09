import { afterEach, expect, test, vi } from 'vitest'
import { fetchCurrentSession, fetchStatus, logout } from './client'
afterEach(() => vi.unstubAllGlobals())

test('a parallel status response cannot replace the authenticated session response CSRF token', async () => {
  let release!: () => void, reached!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const reading = new Promise<void>(resolve => { reached = resolve })
  const session = { authenticated: true, username: 'test-admin', vaultConfig: { slots: [] }, vaultMutationRevision: 1 }
  const response = new Response(JSON.stringify(session), { headers: { 'X-CSRF-Token': 'session-only-test-token' } })
  response.json = async () => { reached(); await gate; return session }
  let mutationToken: string | null = null
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/auth/session')) return response
    if (url.endsWith('/auth/logout')) {
      mutationToken = new Headers(init?.headers).get('X-CSRF-Token')
      return new Response(null, { status: 204 })
    }
    return new Response(JSON.stringify({ setupRequired: false, accountState: 'active' }))
  }))
  const pending = fetchCurrentSession()
  await reading
  await fetchStatus()
  release()
  const result = await pending
  expect(result.authenticated).toBe(true)
  if (result.authenticated) expect(result.csrfToken).toBe('session-only-test-token')
  await logout()
  expect(mutationToken).toBe('session-only-test-token')
})
