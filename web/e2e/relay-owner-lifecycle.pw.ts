import { expect, test, type Page } from './legacy-list-test'
import { ensureRelayControl } from './relay-control'

async function register(page: Page, kind: 'media' | 'download', cooperate: boolean) {
  await ensureRelayControl(page)
  return page.evaluate(async ({ kind, cooperate }) => {
    const id = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
    const channel = new MessageChannel()
    const probe = { reads: 0, firstBytes: 0, stalled: false }
    Object.assign(window, { ownerLifecycleProbe: probe })
    const ready = new Promise<void>(resolve => {
      channel.port1.onmessage = event => {
        const message = event.data
        if (message.type === 'registered') resolve()
        if (message.type === (kind === 'media' ? 'read' : 'pull')) {
          probe.reads += 1
          if (probe.reads === 1) {
            const bytes = new Uint8Array(1024 ** 2).fill(23)
            channel.port1.postMessage({ type: kind === 'media' ? 'read-result' : 'window', readId: message.readId, bytes }, [bytes.buffer])
          } else probe.stalled = true
        }
      }
    })
    // Reload exercises the production pagehide close protocol. The close case
    // deliberately omits it, exercising missing-owner pruning independently.
    if (cooperate) window.addEventListener('pagehide', () => {
      channel.port1.postMessage({ type: 'close' }); channel.port1.close()
    }, { once: true })
    navigator.serviceWorker.controller!.postMessage(kind === 'media'
      ? { type: 'xdrive-media-register', sessionId: id, length: 2 * 1024 ** 2, mime: 'video/mp4' }
      : { type: 'xdrive-download-register', sessionId: id, length: 2 * 1024 ** 2, filename: 'fixture.bin' }, [channel.port2])
    await ready
    return `/__xdrive_${kind}/${id}`
  }, { kind, cooperate })
}

for (const kind of ['media', 'download'] as const) for (const action of ['reload', 'close'] as const) {
  test(`${kind} old token is invalid after real owner ${action}, independently of reader cancellation`, async ({ page, context }) => {
    const observer = await context.newPage()
    try {
      await page.goto('/login'); await observer.goto('/login'); await ensureRelayControl(observer)
      const url = await register(page, kind, action === 'reload')
      const head = await page.evaluate(async url => {
        const response = await fetch(url, { method: 'HEAD' })
        return { status: response.status, length: response.headers.get('Content-Length'), cache: response.headers.get('Cache-Control') }
      }, url)
      expect(head).toEqual({ status: 200, length: String(2 * 1024 ** 2), cache: 'no-store' })
      expect(await observer.evaluate(async url => (await fetch(url, { method: 'HEAD' })).status, url)).toBe(403)
      await page.evaluate(url => {
        // Keep a genuinely started native response waiting on its second window.
        // Never reader.cancel or synthesize pagehide: those are separate triggers.
        void (async () => {
          const response = await fetch(url)
          const reader = response.body!.getReader()
          for (;;) {
            const part = await reader.read()
            if (part.done) break
            if (!part.value.every(byte => byte === 23)) throw new Error('incorrect relay bytes')
            const probe = (window as Window & { ownerLifecycleProbe: { firstBytes: number } }).ownerLifecycleProbe
            probe.firstBytes += part.value.byteLength
          }
        })().catch(() => {})
      }, url)
      await expect.poll(() => page.evaluate(() => {
        const probe = (window as Window & { ownerLifecycleProbe: { firstBytes: number; stalled: boolean } }).ownerLifecycleProbe
        return { firstBytes: probe.firstBytes, stalled: probe.stalled }
      })).toEqual({ firstBytes: 1024 ** 2, stalled: true })
      if (action === 'reload') {
        await page.reload(); await ensureRelayControl(page)
        await expect.poll(() => page.evaluate(async url => (await fetch(url, { method: 'HEAD' })).status, url)).toBe(410)
        const fresh = await register(page, kind, true)
        expect(fresh).not.toBe(url)
        expect(await page.evaluate(async url => (await fetch(url, { method: 'HEAD' })).status, fresh)).toBe(200)
      } else await page.close()
      await expect.poll(() => observer.evaluate(async url => (await fetch(url, { method: 'HEAD' })).status, url)).toBe(410)
      expect(await observer.evaluate(async () => (await caches.keys()).length)).toBe(0)
    } finally { await observer.close() }
  })
}
