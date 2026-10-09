// Isolated transport investigation: no XDrive state, crypto, keys or caches.
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()))
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (url.pathname !== '/sw-stream') return
  const id = url.searchParams.get('id')
  const report = (stage, detail = null) => {
    // Pull/cancel may run after dispatch; waitUntil is invalid once that event
    // lifetime has ended. Reporting must not throw into the source callback.
    void self.clients.get(event.clientId).then(client => client?.postMessage({ id, stage, detail })).catch(() => {})
    // Independent network witness distinguishes an absent source callback from
    // a callback whose owner MessageEvent did not arrive.
    void fetch('/worker-event', { method: 'POST', body: JSON.stringify({ id, stage, detail }) }).catch(() => {})
  }
  event.request.signal.addEventListener('abort', () => report('request-aborted'), { once: true })
  let pulls = 0
  const body = new ReadableStream({
    start(controller) {
      if (url.searchParams.get('source') === 'sync') {
        controller.enqueue(new Uint8Array(1024 ** 2).fill(19))
        report('first-enqueued')
      }
    },
    pull(controller) {
      pulls++
      report('source-pull', pulls)
      if (url.searchParams.get('source') !== 'sync' && pulls === 1) {
        return Promise.resolve().then(() => {
          controller.enqueue(new Uint8Array(1024 ** 2).fill(19))
          report('first-enqueued')
        })
      }
      report('source-stalled')
      return new Promise(() => {})
    },
    cancel(reason) { report('source-cancelled', String(reason)) },
  }, { highWaterMark: Number(url.searchParams.get('hwm')) })
  const headers = { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' }
  if (url.searchParams.get('known') === '1') headers['Content-Length'] = String(2 * 1024 ** 2)
  event.respondWith(new Response(body, { headers }))
})
