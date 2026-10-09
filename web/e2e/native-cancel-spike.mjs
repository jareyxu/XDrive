// Standalone real-browser measurement. Original application assertions/deadlines stay unchanged.
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { chromium, firefox, webkit } from '@playwright/test'
import { startTLSProxy } from './tls-proxy.mjs'

const engine = process.argv[2]
const output = process.argv[3]
if (!['chromium', 'firefox', 'webkit'].includes(engine) || !output) throw new TypeError('usage: node e2e/native-cancel-spike.mjs ENGINE OUTPUT.json')
const worker = readFileSync(new URL('./native-cancel-worker.js', import.meta.url))
const sockets = new Set(), httpEvents = new Map(), workerEvents = new Map()
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  if (url.pathname === '/worker-event' && request.method === 'POST') {
    let body = ''
    request.on('data', chunk => { body += chunk; if (body.length > 1024) request.destroy() })
    request.on('end', () => {
      const data = JSON.parse(body)
      const events = workerEvents.get(data.id) ?? []
      events.push({ ...data, time: Date.now() }); workerEvents.set(data.id, events)
      response.writeHead(204).end()
    })
  } else if (url.pathname === '/worker.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }).end(worker)
  } else if (url.pathname === '/http-stream') {
    const events = []
    httpEvents.set(url.searchParams.get('id'), events)
    response.on('close', () => events.push({ stage: 'http-response-close', finished: response.writableFinished, time: Date.now() }))
    request.on('aborted', () => events.push({ stage: 'http-request-aborted', time: Date.now() }))
    const headers = { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' }
    if (url.searchParams.get('known') === '1') headers['Content-Length'] = String(2 * 1024 ** 2)
    response.writeHead(200, headers)
    response.write(Buffer.alloc(1024 ** 2, 19))
    events.push({ stage: 'http-first-written', time: Date.now() })
    // Deliberately stall until native consumer cancellation; no timer substitutes for it.
  } else response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }).end('<!doctype html><title>Native stream cancellation probe</title>')
})
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let tls, browser
const results = []
try {
  tls = await startTLSProxy(`http://127.0.0.1:${server.address().port}`)
  browser = await ({ chromium, firefox, webkit })[engine].launch()
  const variants = []
  for (const known of [false, true]) {
    for (const source of ['sync', 'async']) for (const hwm of [0, 1]) variants.push({ transport: 'sw', known, source, hwm, mode: 'reader' })
    variants.push({ transport: 'http', known, source: 'network', hwm: null, mode: 'reader' })
    variants.push({ transport: 'http', known, source: 'network', hwm: null, mode: 'abort' })
    variants.push({ transport: 'sw', known, source: 'async', hwm: 0, mode: 'abort' })
    variants.push({ transport: 'sw', known, source: 'async', hwm: 0, mode: 'tee' })
  }
  // Separate contexts/origins of ownership; no app or concurrent build is involved.
  await Promise.all(variants.map(async (variant, index) => {
    const id = `${engine}-${index}`
    const context = await browser.newContext({ ignoreHTTPSErrors: true })
    const page = await context.newPage()
    try {
      // Match the existing test harness: Chromium loopback HTTP is a secure
      // context; its SW script fetch does not accept this ephemeral TLS cert.
      await page.goto(engine === 'chromium' ? `http://127.0.0.1:${server.address().port}` : tls.baseURL)
      await page.evaluate(async () => {
        await navigator.serviceWorker.register('/worker.js')
        await navigator.serviceWorker.ready
        if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }))
      })
      const measured = await page.evaluate(async ({ variant, id }) => {
        const events = [], started = performance.now()
        const record = (stage, detail = null) => events.push({ stage, detail, ms: performance.now() - started })
        navigator.serviceWorker.addEventListener('message', event => {
          if (event.data?.id === id) record(event.data.stage, event.data.detail)
        })
        const controller = new AbortController()
        const params = new URLSearchParams({ id, source: variant.source, hwm: String(variant.hwm), known: variant.known ? '1' : '0' })
        const response = await fetch(`/${variant.transport}-stream?${params}`, { signal: controller.signal })
        record('fetch-resolved', response.status)
        let readers = [response.body.getReader()]
        if (variant.mode === 'tee') {
          readers[0].releaseLock()
          readers = response.body.tee().map(branch => branch.getReader())
        }
        for (const reader of readers) {
          let received = 0
          while (received < 1024 ** 2) {
            const part = await reader.read()
            if (part.done || !part.value?.length || !part.value.every(byte => byte === 19)) throw new Error('invalid first window')
            received += part.value.length
          }
          if (received !== 1024 ** 2) throw new Error('unbounded first window')
          record('first-window-read', received)
          void reader.read().then(value => record('pending-read-settled', value.done), error => record('pending-read-error', error.name))
        }
        // Wait for the independent SW-side stall measurement, not a delay heuristic.
        if (variant.transport === 'sw') {
          const deadline = performance.now() + 5000
          while (!events.some(e => e.stage === 'source-stalled')) {
            if (performance.now() > deadline) throw new Error('source did not stall')
            await new Promise(resolve => setTimeout(resolve, 10))
          }
        }
        record('cancel-called', variant.mode)
        const cancelledAt = performance.now()
        if (variant.mode === 'abort') { controller.abort(); record('abort-returned') }
        else for (const reader of readers) void reader.cancel().then(() => record('reader-cancel-settled'), error => record('reader-cancel-error', error.name))
        // Preserve the original30-second observation budget; no relay timeout exists here.
        while (performance.now() - cancelledAt < 30000) {
          const observed = events.some(e => e.stage === 'source-cancelled' || e.stage === 'request-aborted')
          const settled = variant.mode === 'abort' || events.filter(e => e.stage === 'reader-cancel-settled').length === readers.length
          if (variant.transport === 'sw' && observed && settled) break
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        return { events, observationMs: performance.now() - cancelledAt }
      }, { variant, id })
      // Capture before context cleanup so cleanup cannot manufacture a cancellation success.
      const result = { id, ...variant, ...measured, httpEvents: (httpEvents.get(id) ?? []).slice(), workerEvents: (workerEvents.get(id) ?? []).slice() }
      results.push(result)
      console.log(JSON.stringify({ id, mode: variant.mode, transport: variant.transport, source: variant.source, known: variant.known, hwm: variant.hwm, stages: measured.events.map(e => e.stage), workerStages: result.workerEvents.map(e => e.stage), httpEvents: result.httpEvents, observationMs: measured.observationMs }))
    } catch (error) { results.push({ id, ...variant, error: String(error) }); console.error(id, error) }
    finally { await context.close() }
  }))
  writeFileSync(output, JSON.stringify({ engine, browserVersion: browser.version(), originTransport: engine === 'chromium' ? 'loopback-http-secure-context' : 'loopback-https-test-certificate', observationBudgetMs: 30000, applicationAssertionsModified: false, results: results.sort((a, b) => a.id.localeCompare(b.id)) }, null, 2) + '\n')
  if (results.some(result => result.error)) process.exitCode = 1
} finally {
  await browser?.close()
  await tls?.close()
  const closed = new Promise(resolve => server.close(resolve))
  for (const socket of sockets) socket.destroy()
  await closed
}
