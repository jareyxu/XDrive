import { expect, test } from './legacy-list-test'
import { ensureRelayControl } from './relay-control'

test('download relay tokens are one-use, bounded, uncached and invalid after owner cancellation or reload', async ({ page, context, browserName }) => {
  test.skip(browserName === 'firefox', 'Firefox uses the tested bounded download fallback; Gecko consumer-stream cancellation is not relayed reliably.');
  page.on('console', message => {
    if (message.text().startsWith('download-cancellation-stage:')) console.log(message.text())
  })
  await page.goto('/login')
  const register = async () => {
    await ensureRelayControl(page)
    return page.evaluate(async () => {
      const id = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
      const channel = new MessageChannel()
      let pulls = 0
      Object.assign(window, { relayLifecycleProbe: { pulls: 0, cancelled: false } })
      const ready = new Promise<void>((resolve) => {
        channel.port1.onmessage = (event) => {
          const probe = (window as Window & { relayLifecycleProbe: { pulls: number; cancelled: boolean } }).relayLifecycleProbe
          if (event.data.type === 'registered') resolve()
          if (event.data.type === 'cancelled') { probe.cancelled = true; window.dispatchEvent(new Event('download-owner-cancelled')) }
          if (event.data.type === 'pull') {
            probe.pulls = ++pulls
            if (pulls === 1) {
              const bytes = new Uint8Array(1024 ** 2).fill(19)
              channel.port1.postMessage({ type: 'window', readId: event.data.readId, bytes }, [bytes.buffer])
            } else window.dispatchEvent(new Event('download-owner-stalled'))
          }
        }
      })
      window.addEventListener('pagehide', () => { channel.port1.postMessage({ type: 'close' }); channel.port1.close() }, { once: true })
      navigator.serviceWorker.controller!.postMessage({ type: 'xdrive-download-register', sessionId: id, length: 2 * 1024 ** 2, filename: 'fixture.bin' }, [channel.port2])
      await ready
      return `/__xdrive_download/${id}`
    })
  }
  const url = await register()
  const other = await context.newPage()
  await other.goto('/login')
  await ensureRelayControl(other)
  expect(await other.evaluate(async (url) => (await fetch(url)).status, url)).toBe(403)
  const result = await page.evaluate(async (url) => {
    let stage = 'waiting_head', received = 0
    const diagnostic = window.setTimeout(() => console.error(`download-cancellation-stage:${stage}:${received}`), 5000)
    const head = await fetch(url, { method: 'HEAD' })
    stage = 'waiting_range'
    const ranged = await fetch(url, { headers: { Range: 'bytes=0-1' } })
    stage = 'waiting_response'
    const response = await fetch(url)
    stage = 'waiting_duplicate'
    const duplicate = await fetch(url)
    stage = 'reading_first_window'
    const reader = response.body!.getReader()
    while (received < 1024 ** 2) {
      const first = await reader.read()
      if (!first.value) throw new Error('first relay window missing')
      if (!first.value.every((byte) => byte === 19)) throw new Error('incorrect relay bytes')
      received += first.value.byteLength
    }
    const cancelled = new Promise<void>((resolve) => window.addEventListener('download-owner-cancelled', () => resolve(), { once: true }))
    stage = 'cancelling_reader'
    await reader.cancel()
    stage = 'reader_cancelled'
    await cancelled
    stage = 'cancel_relayed'
    const gone = await fetch(url, { method: 'HEAD' })
    window.clearTimeout(diagnostic)
    return { head: head.status, length: head.headers.get('Content-Length'), range: ranged.status, duplicate: duplicate.status, cache: response.headers.get('Cache-Control'), received, gone: gone.status, probe: (window as Window & { relayLifecycleProbe: { pulls: number; cancelled: boolean } }).relayLifecycleProbe }
  }, url)
  expect(result).toMatchObject({ head: 200, length: String(2 * 1024 ** 2), range: 416, duplicate: 410, cache: 'no-store', received: 1024 ** 2, gone: 410, probe: { cancelled: true } })
  expect(result.probe.pulls).toBeLessThanOrEqual(2)
  const oldURL = await register()
  await page.reload()
  await expect.poll(() => page.evaluate(async (url) => (await fetch(url, { method: 'HEAD' })).status, oldURL)).toBe(410)
  expect(await page.evaluate(async () => (await caches.keys()).length)).toBe(0)
  const hostile = await page.evaluate(async () => {
    const channel = new MessageChannel()
    const id = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
    let acknowledged = false
    channel.port1.onmessage = () => { acknowledged = true }
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt'])
    navigator.serviceWorker.controller!.postMessage({ type: 'xdrive-download-register', sessionId: id, length: 1, filename: 'test.bin', key }, [channel.port2])
    await new Promise((resolve) => setTimeout(resolve, 100))
    const status = (await fetch(`/__xdrive_download/${id}`, { method: 'HEAD' })).status
    channel.port1.close()
    return { acknowledged, status }
  })
  expect(hostile).toEqual({ acknowledged: false, status: 410 })
  await other.close()
})

test('concurrent download admission stays capped and abandoned owners do not exhaust the relay', async ({ page, context }) => {
  const owner = await context.newPage()
  await owner.goto('/login')
  const batch = async (target: typeof page, count: number) => {
    await ensureRelayControl(target)
    return target.evaluate(async (count) => {
      const channels: MessageChannel[] = []
      // Deliberately no pagehide/close notification: simulate an abandoned owner.
      Object.assign(window, { abandonedRelayChannels: channels })
      return Promise.all(Array.from({ length: count }, () => new Promise<{ token: string; admitted: boolean }>((resolve) => {
        const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
        const channel = new MessageChannel()
        channels.push(channel)
        const timeout = window.setTimeout(() => resolve({ token, admitted: false }), 1000)
        channel.port1.onmessage = (event) => {
          if (event.data.type === 'registered') { window.clearTimeout(timeout); resolve({ token, admitted: true }) }
        }
        navigator.serviceWorker.controller!.postMessage({ type: 'xdrive-download-register', sessionId: token, length: 0, filename: 'fixture.bin' }, [channel.port2])
      })))
    }, count)
  }
  const requests = await batch(owner, 8)
  expect(requests.filter((request) => request.admitted)).toHaveLength(4)
  await owner.close()
  await page.goto('/login')
  const recovered = await batch(page, 1)
  expect(recovered[0].admitted).toBe(true)
  for (const request of requests.filter((request) => request.admitted)) {
    expect(await page.evaluate(async (token) => (await fetch(`/__xdrive_download/${token}`, { method: 'HEAD' })).status, request.token)).toBe(410)
  }
  await page.evaluate(() => {
    for (const channel of (window as Window & { abandonedRelayChannels: MessageChannel[] }).abandonedRelayChannels) {
      channel.port1.postMessage({ type: 'close' })
      channel.port1.close()
    }
  })
})
