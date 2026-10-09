import { expect, test } from './legacy-list-test'
import { ensureRelayControl } from './relay-control'

for (const kind of ['media', 'download'] as const) test(`${kind} native registration rejects key and malformed fields independently of cancellation`, async ({ page }) => {
  await page.goto('/login'); await ensureRelayControl(page)
  const result = await page.evaluate(async kind => {
    const worker = navigator.serviceWorker.controller!
    const token = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
    const message = (sessionId: string) => kind === 'media'
      ? { type: 'xdrive-media-register', sessionId, length: 2, mime: 'video/mp4' }
      : { type: 'xdrive-download-register', sessionId, length: 2, filename: 'fixture.bin' }
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt'])
    const probes: { id: string; channel: MessageChannel; ack: boolean; label: string }[] = []
    const patches: [string, Record<string, unknown>][] = [
      ['CryptoKey', { key }], ['unknown field', { unexpected: true }],
      ['fractional length', { length: 1.5 }],
      [kind === 'media' ? 'MIME newline' : 'filename newline', kind === 'media' ? { mime: 'video/mp4\n' } : { filename: 'fixture.bin\n' }],
      ['token newline', { sessionId: token() + '\n' }],
    ]
    for (const [label, patch] of patches) {
      const id = token(), channel = new MessageChannel()
      const probe = { id, channel, ack: false, label }; probes.push(probe)
      channel.port1.onmessage = () => { probe.ack = true }
      worker.postMessage({ ...message(id), ...patch }, [channel.port2])
    }
    const valid = token(), channel = new MessageChannel()
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('valid registration not acknowledged')), 5000)
      channel.port1.onmessage = event => {
        if (event.data.type === 'registered') { window.clearTimeout(timeout); resolve() }
      }
    })
    try {
      // The real valid registration is also a worker-processing control. No
      // synthetic ACK and no reader.cancel precedes these schema assertions.
      worker.postMessage(message(valid), [channel.port2]); await ready
      const invalid = []
      for (const probe of probes) {
        const response = await fetch(`/__xdrive_${kind}/${probe.id}`, { method: 'HEAD' })
        invalid.push({ label: probe.label, ack: probe.ack, status: response.status })
      }
      const response = await fetch(`/__xdrive_${kind}/${valid}`, { method: 'HEAD' })
      return { invalid, valid: { status: response.status, cache: response.headers.get('Cache-Control'), length: response.headers.get('Content-Length') }, caches: await caches.keys() }
    } finally {
      channel.port1.postMessage({ type: 'close' }); channel.port1.close()
      for (const probe of probes) probe.channel.port1.close()
    }
  }, kind)
  expect(result.invalid).toHaveLength(5)
  for (const probe of result.invalid) expect(probe, probe.label).toMatchObject({ ack: false, status: 410 })
  expect(result.valid).toEqual({ status: 200, cache: 'no-store', length: '2' })
  expect(result.caches).toEqual([])
})
