import { afterEach, describe, expect, it, vi } from 'vitest'
import workerSource from '../../public/media-sw.js?raw'

// Exercise the actual standalone worker script, with a deterministic clock and
// client inventory. Native stream and encrypted file behavior have E2E tests.
function workerHarness() {
  const handlers = new Map<string, ((event: unknown) => void)[]>()
  const owners = new Set(['owner'])
  const scope = {
    location: { origin: 'https://xdrive.test' },
    clients: { get: async (id: string) => owners.has(id) ? { id } : undefined, claim: vi.fn().mockResolvedValue(undefined) },
    addEventListener(type: string, handler: (event: unknown) => void) {
      handlers.set(type, [...handlers.get(type) ?? [], handler])
    },
  }
  new Function('self', workerSource)(scope)
  const dispatch = (type: string, event: unknown) => { for (const handler of handlers.get(type) ?? []) handler(event) }
  const admit = (id: number, owner = 'owner') => {
    const messages: { type: string; reason?: string }[] = []
    const port = { postMessage: (message: { type: string; reason?: string }) => messages.push(message), close: vi.fn(), start: vi.fn(), onmessage: undefined, onmessageerror: undefined }
    let done = Promise.resolve()
    const token = id.toString().padStart(32, '0')
    dispatch('message', {
      data: { type: 'xdrive-download-register', sessionId: token, length: 0, filename: 'fixture.bin' },
      source: { id: owner }, ports: [port], waitUntil: (promise: Promise<void>) => { done = promise },
    })
    return { token, port, messages, done: () => done }
  }
  const status = async (token: string) => {
    let response!: Promise<Response>
    dispatch('fetch', {
      request: new Request(`https://xdrive.test/__xdrive_download/${token}`, { method: 'HEAD' }), clientId: 'owner',
      respondWith: (result: Promise<Response>) => { response = result },
    })
    return (await response).status
  }
  return { owners, admit, status, dispatch, claim: scope.clients.claim }
}

afterEach(() => vi.useRealTimers())

describe('worker download admission and expiry', () => {
  it('serializes concurrent admissions and never admits a fifth session', async () => {
    const worker = workerHarness()
    const requests = Array.from({ length: 8 }, (_, index) => worker.admit(index))
    await Promise.all(requests.map((request) => request.done()))
    expect(requests.filter((request) => request.messages.some((message) => message.type === 'registered'))).toHaveLength(4)
    expect(requests.slice(4).every((request) => request.port.close.mock.calls.length === 1)).toBe(true)
    expect(await worker.status(requests[0].token)).toBe(200)
    expect(await worker.status(requests[4].token)).toBe(410)
  })

  it('reclaims disappeared owners even when no pagehide message arrives', async () => {
    const worker = workerHarness()
    const requests = Array.from({ length: 4 }, (_, index) => worker.admit(index))
    await Promise.all(requests.map((request) => request.done()))
    worker.owners.delete('owner')
    worker.owners.add('new-owner')
    const next = worker.admit(9, 'new-owner')
    await next.done()
    expect(next.messages).toEqual([{ type: 'registered', sessionId: next.token }])
    expect(requests.every((request) => request.port.close.mock.calls.length === 1)).toBe(true)
    expect(await worker.status(requests[0].token)).toBe(410)
  })

  it('expires unclaimed credentials after ten minutes without extending them on HEAD', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const worker = workerHarness()
    const first = worker.admit(1)
    await first.done()
    vi.setSystemTime(10 * 60_000 - 1)
    expect(await worker.status(first.token)).toBe(200)
    vi.setSystemTime(10 * 60_000)
    expect(await worker.status(first.token)).toBe(410)
    expect(first.port.close).toHaveBeenCalledOnce()
    expect(first.messages.at(-1)).toEqual({ type: 'cancelled', reason: 'start_expired' })
    const next = worker.admit(2)
    await next.done()
    expect(await worker.status(next.token)).toBe(200)
  })

  it('prunes expired sessions before admission and rejects absent registrants', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const worker = workerHarness()
    const requests = Array.from({ length: 4 }, (_, index) => worker.admit(index))
    await Promise.all(requests.map((request) => request.done()))
    vi.setSystemTime(10 * 60_000)
    const next = worker.admit(5)
    await next.done()
    expect(next.messages[0]?.type).toBe('registered')
    expect(requests.every((request) => request.port.close.mock.calls.length === 1)).toBe(true)
    const absent = worker.admit(6, 'absent')
    await absent.done()
    expect(absent.messages).toEqual([])
    expect(absent.port.close).toHaveBeenCalledOnce()
  })
})


it('only a live same-origin client with the exact key-free claim message can request control', async () => {
  const worker = workerHarness()
  const request = async (data: unknown, owner = 'owner', ports: unknown[] = []) => {
    let done = Promise.resolve()
    worker.dispatch('message', { data, source: { id: owner }, ports, waitUntil: (pending: Promise<void>) => { done = pending } })
    await done
  }
  await request({ type: 'xdrive-relay-claim' }, 'absent')
  await request({ type: 'xdrive-relay-claim', key: {} })
  await request({ type: 'xdrive-relay-claim' }, 'owner', [{}])
  expect(worker.claim).not.toHaveBeenCalled()
  await request({ type: 'xdrive-relay-claim' })
  expect(worker.claim).toHaveBeenCalledOnce()
})
