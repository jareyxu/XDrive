import { expect, test } from './legacy-list-test'
import { ensureRelayControl } from './relay-control'

test('explicit fetch abort relays the exact pending media read cancellation before body bytes', async ({ page }) => {
  await page.goto('/login')
  await ensureRelayControl(page)
  const result = await page.evaluate(async () => {
    const sessionId = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
    const channel = new MessageChannel()
    let registered!: () => void
    let started!: (id: number) => void
    let cancelled!: (id: number) => void
    const registration = new Promise<void>(resolve => { registered = resolve })
    const readStarted = new Promise<number>(resolve => { started = resolve })
    const readCancelled = new Promise<number>(resolve => { cancelled = resolve })
    let reads = 0
    channel.port1.onmessage = event => {
      if (event.data?.type === 'registered') registered()
      if (event.data?.type === 'read') { reads += 1; started(event.data.readId) }
      if (event.data?.type === 'cancel-read') cancelled(event.data.readId)
    }
    channel.port1.start()
    navigator.serviceWorker.controller!.postMessage({ type: 'xdrive-media-register', sessionId, length: 2_000_000, mime: 'video/mp4' }, [channel.port2])
    try {
      await registration
      const controller = new AbortController()
      const fetched = fetch(`/__xdrive_media/${sessionId}`, {
        headers: { Range: 'bytes=1000000-1001023' }, signal: controller.signal,
      }).then(async response => { await response.arrayBuffer(); return 'resolved' }, error => error.name)
        .catch(error => error.name)
      const readId = await readStarted
      controller.abort()
      // This ACK must originate from the worker, not the page abort handler.
      const cancelledId = await readCancelled
      const outcome = await fetched
      const head = await fetch(`/__xdrive_media/${sessionId}`, { method: 'HEAD' })
      return { matchingReadId: cancelledId === readId, outcome, reads, sessionStatus: head.status }
    } finally {
      channel.port1.postMessage({ type: 'close' })
      channel.port1.close()
    }
  })
  expect(result).toEqual({ matchingReadId: true, outcome: 'AbortError', reads: 1, sessionStatus: 200 })
})

test('Service Worker relays bounded explicit, open, suffix and HEAD video ranges to its owner', async ({ page, context, browserName }) => {
  test.skip(browserName === 'firefox', 'Firefox playback uses the tested bounded Blob fallback; Gecko consumer-stream cancellation is not relayed reliably.');
  await page.goto('/login')
  const { url, length } = await page.evaluate(async () => {
    await navigator.serviceWorker.register('/media-sw.js', { scope: '/' })
    await navigator.serviceWorker.ready
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('SW did not claim page')), 10000)
        navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(timeout); resolve() }, { once: true })
      })
    }
    const sessionId = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
    const length = 2 * 1024 * 1024 * 1024 + 37
    const channel = new MessageChannel()
    const registered = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('SW did not register media session')), 10000)
      channel.port1.onmessage = (event) => {
        const message = event.data
        if (message.type === 'registered') { clearTimeout(timeout); resolve(); return }
        if (message.type === 'cancel-read') { window.dispatchEvent(new CustomEvent('xdrive-test-cancel', { detail: message.readId })); return }
        if (message.type !== 'read') return
        if (message.begin === 50_000_000) { window.dispatchEvent(new CustomEvent('xdrive-test-stall', { detail: message.readId })); return }
        const bytes = new Uint8Array(message.end - message.begin)
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = (message.begin + index) % 251
        channel.port1.postMessage({ type: 'read-result', readId: message.readId, bytes }, [bytes.buffer])
      }
    })
    window.addEventListener('pagehide', () => { channel.port1.postMessage({ type: 'close' }); channel.port1.close() }, { once: true })
    navigator.serviceWorker.controller!.postMessage({ type: 'xdrive-media-register', sessionId, length, mime: 'video/mp4' }, [channel.port2])
    await registered
    return { url: `/__xdrive_media/${sessionId}`, length }
  })

  const results = await page.evaluate(async ({ url, length }) => {
    const explicit = await fetch(url, { headers: { Range: 'bytes=10-19' } })
    const explicitBytes = [...new Uint8Array(await explicit.arrayBuffer())]
    const open = await fetch(url, { headers: { Range: `bytes=${length - 5}-` } })
    const openBytes = [...new Uint8Array(await open.arrayBuffer())]
    const suffix = await fetch(url, { headers: { Range: 'bytes=-7' } })
    const suffixBytes = [...new Uint8Array(await suffix.arrayBuffer())]
    const head = await fetch(url, { method: 'HEAD', headers: { Range: 'bytes=100-199' } })
    const invalid = await fetch(url, { headers: { Range: `bytes=${length}-` } })
    const reversed = await fetch(url, { headers: { Range: 'bytes=20-10' } })
    const multiple = await fetch(url, { headers: { Range: 'bytes=0-1,4-5' } })
    const huge = await fetch(url)
    const reader = huge.body!.getReader()
    const first = await reader.read()
    await reader.cancel()
    return {
      explicit: { status: explicit.status, range: explicit.headers.get('Content-Range'), bytes: explicitBytes },
      open: { status: open.status, range: open.headers.get('Content-Range'), bytes: openBytes },
      suffix: { status: suffix.status, range: suffix.headers.get('Content-Range'), bytes: suffixBytes },
      head: { status: head.status, range: head.headers.get('Content-Range'), length: head.headers.get('Content-Length'), bodyLength: (await head.arrayBuffer()).byteLength },
      invalid: { status: invalid.status, range: invalid.headers.get('Content-Range') },
      reversed: reversed.status, multiple: multiple.status,
      huge: { status: huge.status, length: huge.headers.get('Content-Length'), firstWindow: first.value?.byteLength ?? 0 },
    }
  }, { url, length })
  expect(results.explicit).toEqual({ status: 206, range: `bytes 10-19/${length}`, bytes: Array.from({ length: 10 }, (_, index) => (index + 10) % 251) })
  expect(results.open).toEqual({ status: 206, range: `bytes ${length - 5}-${length - 1}/${length}`, bytes: Array.from({ length: 5 }, (_, index) => (length - 5 + index) % 251) })
  expect(results.suffix).toEqual({ status: 206, range: `bytes ${length - 7}-${length - 1}/${length}`, bytes: Array.from({ length: 7 }, (_, index) => (length - 7 + index) % 251) })
  expect(results.head).toEqual({ status: 206, range: `bytes 100-199/${length}`, length: '100', bodyLength: 0 })
  expect(results.invalid).toEqual({ status: 416, range: `bytes */${length}` })
  expect(results.reversed).toBe(416)
  expect(results.multiple).toBe(416)
  expect(results.huge.status).toBe(200)
  expect(results.huge.length).toBe(String(length))
  expect(results.huge.firstWindow).toBeGreaterThan(0)
  expect(results.huge.firstWindow).toBeLessThanOrEqual(1024 * 1024)

  const cancellationRelayed = await page.evaluate(async (url) => {
    let stage = 'waiting_for_response', seen = 0
    const diagnostic = window.setTimeout(() => console.error(`range-cancellation-stage:${stage}:${seen}`), 5000)
    const started = new Promise<number>((resolve) => window.addEventListener('xdrive-test-stall', event => resolve((event as CustomEvent<number>).detail), { once: true }))
    // Gecko may not resolve fetch until the first response body bytes arrive.
    // Supply one bounded window, then stall the next pull and cancel the reader.
    const response = await fetch(url, { headers: { Range: `bytes=${50_000_000 - 1024 * 1024}-50001023` } })
    stage = 'response_received'
    const stream = response.body!.getReader()
    let firstWindow = 0
    // A browser may split a transferred 1MiB SW window into smaller Fetch chunks.
    while (firstWindow < 1024 * 1024) {
      const part = await stream.read()
      if (part.done || !part.value?.byteLength) throw new Error('Range ended before initial window')
      firstWindow += part.value.byteLength
      seen = firstWindow
    }
    const pendingRead = stream.read().catch(() => undefined)
    const readId = await started
    stage = 'read_started'
    const cancelled = new Promise<void>((resolve) => {
      const onCancel = (event: Event) => {
        if ((event as CustomEvent<number>).detail !== readId) return
        window.removeEventListener('xdrive-test-cancel', onCancel); resolve()
      }
      window.addEventListener('xdrive-test-cancel', onCancel)
    })
    await stream.cancel()
    stage = 'reader_cancelled'
    await cancelled
    stage = 'cancel_relayed'
    await pendingRead
    window.clearTimeout(diagnostic)
    return { cancelled: true, firstWindow }
  }, url)
  expect(cancellationRelayed).toEqual({ cancelled: true, firstWindow: 1024 * 1024 })

  const fetchAbortRelayed = await page.evaluate(async url => {
    const controller = new AbortController()
    const started = new Promise<number>(resolve => window.addEventListener('xdrive-test-stall', event => resolve((event as CustomEvent<number>).detail), { once: true }))
    const fetched = fetch(url, { headers: { Range: 'bytes=50000000-50001023' }, signal: controller.signal })
      .then(async response => { await response.arrayBuffer(); return 'resolved' }, error => error.name)
      .catch(error => error.name)
    const readId = await started
    const cancelled = new Promise<void>(resolve => {
      const onCancel = (event: Event) => {
        if ((event as CustomEvent<number>).detail !== readId) return
        window.removeEventListener('xdrive-test-cancel', onCancel); resolve()
      }
      window.addEventListener('xdrive-test-cancel', onCancel)
    })
    controller.abort()
    await cancelled
    return fetched
  }, url)
  expect(fetchAbortRelayed).toBe('AbortError')

  const keyRegistrationRejected = await page.evaluate(async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt'])
    const sessionId = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
    const channel = new MessageChannel()
    navigator.serviceWorker.controller!.postMessage({ type: 'xdrive-media-register', sessionId, length: 1024, mime: 'video/mp4', key }, [channel.port2])
    channel.port1.close()
    const response = await fetch(`/__xdrive_media/${sessionId}`, { method: 'HEAD' })
    return response.status
  })
  expect(keyRegistrationRejected).toBe(410)

  const otherPage = await context.newPage()
  await otherPage.goto('/login')
  expect(await otherPage.evaluate(async (url) => (await fetch(url, { method: 'HEAD' })).status, url)).toBe(403)
  await page.reload()
  await expect.poll(() => page.evaluate(async (url) => (await fetch(url, { method: 'HEAD' })).status, url)).toBe(410)

  const activeReadClosed = await page.evaluate(async () => {
    const sessionId = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
    const channel = new MessageChannel()
    let resolveRegistered!: () => void
    let resolveReadStarted!: () => void
    const registered = new Promise<void>((resolve) => { resolveRegistered = resolve })
    const readStarted = new Promise<void>((resolve) => { resolveReadStarted = resolve })
    channel.port1.onmessage = (event) => {
      if (event.data?.type === 'registered') resolveRegistered()
      if (event.data?.type === 'read') resolveReadStarted()
    }
    channel.port1.start()
    window.addEventListener('pagehide', () => {
      channel.port1.postMessage({ type: 'close' })
      channel.port1.close()
    }, { once: true })
    const worker = navigator.serviceWorker.controller
    if (!worker) throw new Error('Service Worker is not controlling the reloaded page')
    worker.postMessage({ type: 'xdrive-media-register', sessionId, length: 2_000_000, mime: 'video/mp4' }, [channel.port2])
    await registered

    const mediaURL = `/__xdrive_media/${sessionId}`
    const response = await fetch(mediaURL, { headers: { Range: 'bytes=1000000-1001023' } })
    const bodyRead = response.body!.getReader().read().then(() => 'resolved', () => 'rejected')
    await readStarted
    window.dispatchEvent(new Event('pagehide'))
    let timeout = 0
    const bodyReadResult = await Promise.race([
      bodyRead,
      new Promise<string>((resolve) => { timeout = window.setTimeout(() => resolve('timeout'), 5000) }),
    ])
    window.clearTimeout(timeout)
    const sessionStatus = await fetch(mediaURL, { method: 'HEAD' }).then((result) => result.status)
    return { bodyReadResult, sessionStatus }
  })
  expect(activeReadClosed).toEqual({ bodyReadResult: 'rejected', sessionStatus: 410 })

  await otherPage.close()
})

test('native Service Worker eviction rejects its active stream and invalidates the old media session', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Forced native Worker eviction requires Chromium CDP; other engines remain unverified for this fault path.')
  await page.goto('/login')
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/media-sw.js', { scope: '/' })
    await navigator.serviceWorker.ready
    if (!navigator.serviceWorker.controller) await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('SW did not claim page')), 10000)
      navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(timeout); resolve() }, { once: true })
    })
  })
  await page.evaluate(() => {
    const sessionId = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
    const channel = new MessageChannel()
    let resolveRegistered!: () => void
    let resolveReadStarted!: () => void
    const registered = new Promise<void>((resolve) => { resolveRegistered = resolve })
    const readStarted = new Promise<void>((resolve) => { resolveReadStarted = resolve })
    const state = window as Window & { __evictionProbe?: { sessionId: string; readStarted: boolean; completed: Promise<string> } }
    channel.port1.onmessage = (event) => {
      if (event.data?.type === 'registered') resolveRegistered()
      if (event.data?.type === 'read') resolveReadStarted()
    }
    channel.port1.start()
    navigator.serviceWorker.controller!.postMessage({ type: 'xdrive-media-register', sessionId, length: 2_000_000, mime: 'video/mp4' }, [channel.port2])
    state.__evictionProbe = { sessionId, readStarted: false, completed: Promise.resolve('not_started') }
    state.__evictionProbe.completed = (async () => {
      await registered
      const response = await fetch(`/__xdrive_media/${sessionId}`, { headers: { Range: 'bytes=1000000-1001023' } })
      const read = response.body!.getReader().read().then(() => 'resolved', () => 'rejected')
      await readStarted
      state.__evictionProbe!.readStarted = true
      let timeout = 0
      const result = await Promise.race([read, new Promise<string>((resolve) => { timeout = window.setTimeout(() => resolve('timeout'), 5000) })])
      window.clearTimeout(timeout)
      return result
    })()
  })
  await page.waitForFunction(() => (window as Window & { __evictionProbe?: { readStarted: boolean } }).__evictionProbe?.readStarted === true)
  const devtools = await context.newCDPSession(page)
  await devtools.send('ServiceWorker.enable')
  await devtools.send('ServiceWorker.stopAllWorkers')
  await devtools.detach()
  const evictionResult = await page.evaluate(async () => {
    const probe = (window as Window & { __evictionProbe?: { sessionId: string; completed: Promise<string> } }).__evictionProbe!
    const bodyReadResult = await probe.completed
    const sessionStatus = await fetch(`/__xdrive_media/${probe.sessionId}`, { method: 'HEAD' }).then((result) => result.status)
    return { bodyReadResult, sessionStatus }
  })
  expect(evictionResult.bodyReadResult).toBe('rejected')
  expect(evictionResult.sessionStatus).toBe(410)
})
