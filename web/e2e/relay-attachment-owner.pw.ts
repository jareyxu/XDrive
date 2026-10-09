import { expect, test, type Page } from './legacy-list-test'
import { ensureRelayControl } from './relay-control'

async function register(owner: Page, stall: boolean) {
  await ensureRelayControl(owner)
  return owner.evaluate(async stall => {
    const id = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
    const channel = new MessageChannel()
    const probe = { reads: 0, stalled: false }
    Object.assign(window, { attachmentOwnerProbe: probe })
    await new Promise<void>(resolve => {
      channel.port1.onmessage = event => {
        const message = event.data
        if (message.type === 'registered') resolve()
        if (message.type !== 'pull') return
        probe.reads += 1
        if (stall && probe.reads === 2) { probe.stalled = true; return }
        if (probe.reads > 2) { channel.port1.postMessage({ type: 'window', readId: message.readId, done: true }); return }
        const bytes = new Uint8Array(1024 ** 2).fill(probe.reads === 1 ? 23 : 47)
        channel.port1.postMessage({ type: 'window', readId: message.readId, bytes }, [bytes.buffer])
      }
      navigator.serviceWorker.controller!.postMessage({ type: 'xdrive-download-register', sessionId: id, length: 2 * 1024 ** 2, filename: 'fixture.bin' }, [channel.port2])
    })
    // Deliberately no pagehide close handler: test real missing-owner discovery.
    return `/__xdrive_download/${id}`
  }, stall)
}

for (const closeOwner of [false, true]) test(`native attachment with a separate consumer ${closeOwner ? 'fails when its stalled owner closes' : 'completes exact windows while its owner lives'}`, async ({ page: owner, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Native attachments are currently validated only on desktop Chromium; this is not fallback or other-engine certification.')
  const consumer = await context.newPage()
  try {
    await owner.goto('/login'); await consumer.goto('/login'); await ensureRelayControl(consumer)
    const url = await register(owner, closeOwner)
    await consumer.evaluate(url => {
      const link = document.createElement('a'); link.href = url; link.textContent = 'Start relay attachment'; document.body.append(link)
    }, url)
    const started = consumer.waitForEvent('download')
    await consumer.getByRole('link', { name: 'Start relay attachment' }).click()
    const download = await started
    expect(download.suggestedFilename()).toBe('fixture.bin')
    if (closeOwner) {
      await expect.poll(() => owner.evaluate(() => (window as Window & { attachmentOwnerProbe: { stalled: boolean } }).attachmentOwnerProbe.stalled)).toBe(true)
      await owner.close()
      // No HEAD/pruning request, reader.cancel, download.cancel or cooperative
      // pagehide message before this actual download-manager terminal verdict.
      const terminal: { result?: { failure: string | null } } = {}
      void download.failure().then(failure => { terminal.result = { failure } })
      await expect.poll(() => terminal.result, { message: 'The surviving native consumer terminates after its owner closes, before the 30s read timeout' }).toBeDefined()
      expect(terminal.result!.failure).not.toBeNull()
      expect(consumer.isClosed()).toBe(false)
      expect(await consumer.evaluate(async url => (await fetch(url, { method: 'HEAD' })).status, url)).toBe(410)
    } else {
      const stream = await download.createReadStream(); expect(stream).not.toBeNull()
      let offset = 0
      for await (const chunk of stream!) {
        for (const byte of chunk as Buffer) {
          if (byte !== (offset++ < 1024 ** 2 ? 23 : 47)) throw new Error('Incorrect attachment byte')
        }
      }
      expect(offset).toBe(2 * 1024 ** 2); expect(await download.failure()).toBeNull()
    }
    expect(await consumer.evaluate(async () => (await caches.keys()).length)).toBe(0)
  } finally { await consumer.close() }
})
