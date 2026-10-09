import { expect, test, vi } from 'vitest'
import source from '../../public/media-sw.js?raw'

async function register(data: Record<string, unknown>) {
  const handlers: ((event: any) => void)[] = []
  new Function('self', source)({ location: { origin: 'https://xdrive.test' }, clients: { get: async () => ({ id: 'owner' }) }, addEventListener(type: string, handler: (event: any) => void) { if (type === 'message') handlers.push(handler) } })
  const port = { close: vi.fn(), start() {}, postMessage: vi.fn() }
  let done = Promise.resolve()
  for (const handler of handlers) handler({ data, source: { id: 'owner' }, ports: [port], waitUntil: (promise: Promise<void>) => { done = promise } })
  await done
  return port
}
const media = { type: 'xdrive-media-register', sessionId: 'a'.repeat(32), length: 2, mime: 'video/mp4' }
const download = { type: 'xdrive-download-register', sessionId: 'a'.repeat(32), length: 2, filename: 'valid%20name.bin' }

for (const [name, valid] of [['media', media], ['download', download]] as const) {
  test.each([
    ['token newline', { sessionId: valid.sessionId + '\n' }],
    ['token short', { sessionId: 'a'.repeat(31) }],
    ['negative length', { length: -1 }],
    ['fractional length', { length: 1.5 }],
    ['unsafe length', { length: Number.MAX_SAFE_INTEGER + 1 }],
    ['unknown key field', { key: {} }],
  ])(`${name} registration rejects %s without acknowledgement`, async (_label, patch) => {
    const port = await register({ ...valid, ...patch })
    expect(port.close).toHaveBeenCalledOnce(); expect(port.postMessage).not.toHaveBeenCalled()
  })
  test(`${name} exact valid registration still acknowledges its opaque token`, async () => {
    const port = await register(valid)
    expect(port.close).not.toHaveBeenCalled(); expect(port.postMessage).toHaveBeenCalledWith({ type: 'registered', sessionId: valid.sessionId })
  })
}
test('media MIME newline cannot register a response-header value', async () => {
  const port = await register({ ...media, mime: 'video/mp4\n' })
  expect(port.close).toHaveBeenCalledOnce(); expect(port.postMessage).not.toHaveBeenCalled()
})
test('download filename newline cannot register an attachment-header value', async () => {
  const port = await register({ ...download, filename: 'fixture.bin\n' })
  expect(port.close).toHaveBeenCalledOnce(); expect(port.postMessage).not.toHaveBeenCalled()
})
