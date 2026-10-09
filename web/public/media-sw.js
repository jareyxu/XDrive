/* XDrive stream relay: no keys, no Cache API or persistent plaintext storage. */
const PREFIX = '/__xdrive_media/'
const WINDOW_BYTES = 1024 * 1024
const READ_TIMEOUT_MS = 30000
const MAX_SESSIONS = 8
const OWNER_CHECK_MS = 1000
const sessions = new Map()
let nextReadId = 1

function clearPendingTimers(pending) {
  clearTimeout(pending.timeout)
  clearTimeout(pending.ownerTimeout)
}

// A browser attachment can outlive its supplying page. Check only while a
// window is pending, with one lookup at a time; cancellation during await must
// neither revive the timer nor act on a replacement window.
function watchPendingOwner(session, pending, isCurrent, close) {
  const check = async () => {
    if (!isCurrent()) return
    let owner
    try { owner = await self.clients.get(session.ownerId) } catch { owner = undefined }
    if (!isCurrent()) return
    if (!owner) { close(); return }
    pending.ownerTimeout = setTimeout(check, OWNER_CHECK_MS)
  }
  pending.ownerTimeout = setTimeout(check, OWNER_CHECK_MS)
}

self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()))
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

// An already activated registration does not imply this page is controlled.
// Same-origin pages can explicitly request claim before creating a relay.
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'xdrive-relay-claim' || Object.keys(event.data).length !== 1 ||
      event.ports.length !== 0 || !event.source || typeof event.source.id !== 'string') return
  event.waitUntil((async () => {
    if (await self.clients.get(event.source.id)) await self.clients.claim()
  })())
})

const DOWNLOAD_PREFIX = '/__xdrive_download/'
const downloads = new Map()
const DOWNLOAD_START_TIMEOUT_MS = 10 * 60 * 1000
let downloadRegistrationQueue = Promise.resolve()

async function pruneDownloads() {
  for (const session of downloads.values()) {
    if (!session.claimed && Date.now() - session.createdAt >= DOWNLOAD_START_TIMEOUT_MS || !await self.clients.get(session.ownerId)) {
      closeDownload(session, false, 'owner_missing')
    }
  }
}

function closeDownload(session, successful = false, reason = 'cancelled') {
  if (downloads.get(session.id) !== session) return
  downloads.delete(session.id)
  session.removeAbortListener?.()
  session.removeAbortListener = undefined
  if (!successful) {
    try { session.port.postMessage({ type: 'cancelled', reason }) } catch { /* Owner may be gone. */ }
    const error = new DOMException('Download owner disappeared or cancelled', 'AbortError')
    session.controller?.error(error)
    session.pending?.reject(error)
  }
  if (session.pending) clearPendingTimers(session.pending)
  session.pending = undefined
  session.controller = undefined
  session.port.close()
}

self.addEventListener('message', (event) => {
  const data = event.data
  const port = event.ports[0]
  if (!data || data.type !== 'xdrive-download-register' || !port || !event.source || typeof event.source.id !== 'string') return
  if (typeof data.sessionId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(data.sessionId) ||
      data.length !== null && (!Number.isSafeInteger(data.length) || data.length < 0) ||
      typeof data.filename !== 'string' || data.filename.length > 8192 || !/^(?:[A-Za-z0-9._~-]|%[0-9A-F]{2})+$/.test(data.filename) ||
      Object.keys(data).some((key) => !['type', 'sessionId', 'length', 'filename'].includes(key))) {
    port.close(); return
  }
  // Serialize admission across asynchronous owner checks; concurrent messages
  // must not all observe a free slot before any of them registers its session.
  downloadRegistrationQueue = downloadRegistrationQueue.catch(() => undefined).then(async () => {
    await pruneDownloads()
    if (!await self.clients.get(event.source.id) || downloads.has(data.sessionId) || downloads.size >= 4) { port.close(); return }
    const session = { id: data.sessionId, ownerId: event.source.id, createdAt: Date.now(), length: data.length, filename: data.filename, received: 0, claimed: false, port, pending: undefined, controller: undefined }
    downloads.set(session.id, session)
    port.onmessage = (event) => {
      const reply = event.data
      if (reply?.type === 'close') { closeDownload(session, false, 'owner_closed'); return }
      const pending = session.pending
      if (!pending || reply?.type !== 'window' || reply.readId !== pending.id) {
        if (reply?.bytes instanceof Uint8Array) reply.bytes.fill(0)
        return
      }
      session.pending = undefined; clearPendingTimers(pending)
      if (reply.done === true && !reply.bytes) pending.resolve(null)
      else if (reply.bytes instanceof Uint8Array && reply.bytes.byteLength > 0 && reply.bytes.byteLength <= WINDOW_BYTES) pending.resolve(reply.bytes)
      else { if (reply.bytes instanceof Uint8Array) reply.bytes.fill(0); pending.reject(new TypeError('Invalid download window')); closeDownload(session) }
    }
    port.onmessageerror = () => closeDownload(session)
    port.start()
    port.postMessage({ type: 'registered', sessionId: session.id })
  }).catch(() => { port.close() })
  event.waitUntil(downloadRegistrationQueue)
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin || !url.pathname.startsWith(DOWNLOAD_PREFIX)) return
  event.respondWith((async () => {
    const headers = new Headers({ 'Cache-Control': 'no-store', 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment', 'X-Content-Type-Options': 'nosniff' })
    if (!['GET', 'HEAD'].includes(event.request.method)) return new Response(null, { status: 405, headers })
    const session = downloads.get(url.pathname.slice(DOWNLOAD_PREFIX.length))
    if (!session || url.search) return new Response(null, { status: 410, headers })
    if (!session.claimed && Date.now() - session.createdAt >= DOWNLOAD_START_TIMEOUT_MS) { closeDownload(session, false, 'start_expired'); return new Response(null, { status: 410, headers }) }
    // Browser attachment navigation may omit clientId. Its unguessable one-use
    // capability still requires the owner to be alive and supply every window.
    if (event.clientId && event.clientId !== session.ownerId && event.request.mode !== 'navigate') return new Response(null, { status: 403, headers })
    if (!await self.clients.get(session.ownerId)) { closeDownload(session); return new Response(null, { status: 410, headers }) }
    if (event.request.method === 'HEAD') {
      if (session.length !== null) headers.set('Content-Length', String(session.length))
      return new Response(null, { headers })
    }
    if (session.claimed) return new Response(null, { status: 410, headers })
    if (event.request.headers.has('Range')) return new Response(null, { status: 416, headers })
    session.claimed = true
    headers.set('Content-Disposition', `attachment; filename="XDrive-download"; filename*=UTF-8''${session.filename}`)
    const onAbort = () => closeDownload(session, false, 'request_aborted')
    session.removeAbortListener = () => event.request.signal.removeEventListener('abort', onAbort)
    let pulling = false
    const body = new ReadableStream({
      start(controller) {
        session.controller = controller
        event.request.signal.addEventListener('abort', onAbort, { once: true })
        if (event.request.signal.aborted) onAbort()
      },
      pull(controller) {
        if (pulling || downloads.get(session.id) !== session) return
        pulling = true
        // Do not leave the stream's pull algorithm pending while the page
        // supplies bytes. Some engines defer the source cancel() callback
        // until pull settles, which otherwise deadlocks consumer cancellation.
        void (async () => {
          try {
            const owner = await self.clients.get(session.ownerId)
            if (downloads.get(session.id) !== session) return
            if (!owner) { closeDownload(session, false, 'owner_missing'); return }
            const id = nextReadId++
            const bytes = await new Promise((resolve, reject) => {
              const timeout = setTimeout(() => { reject(new DOMException('Download page did not respond', 'TimeoutError')); closeDownload(session) }, READ_TIMEOUT_MS)
              const pending = { id, resolve, reject, timeout }
              session.pending = pending
              watchPendingOwner(session, pending, () => session.pending === pending && downloads.get(session.id) === session, () => closeDownload(session, false, 'owner_missing'))
              session.port.postMessage({ type: 'pull', readId: id })
            })
            if (downloads.get(session.id) !== session) { bytes?.fill(0); return }
            if (bytes === null) {
              if (session.length !== null && session.received !== session.length) throw new TypeError('Download ended before declared length')
              controller.close()
              session.port.postMessage({ type: 'ack', readId: id })
              session.port.postMessage({ type: 'complete' })
              closeDownload(session, true)
            } else {
              session.received += bytes.byteLength
              if (!Number.isSafeInteger(session.received) || session.length !== null && session.received > session.length) { bytes.fill(0); throw new TypeError('Download exceeded declared length') }
              controller.enqueue(bytes)
              session.port.postMessage({ type: 'ack', readId: id })
            }
          } catch {
            if (downloads.get(session.id) === session) closeDownload(session, false, 'stream_failed')
          } finally {
            pulling = false
          }
        })()
      },
      cancel() { closeDownload(session, false, 'consumer_cancelled') },
    }, { highWaterMark: 0 })
    return new Response(body, { headers })
  })())
})

function closeSession(session) {
  if (sessions.get(session.id) !== session) return
  sessions.delete(session.id)
  for (const pending of session.pending.values()) {
    clearPendingTimers(pending)
    pending.reject(new DOMException('Media owner disappeared', 'AbortError'))
  }
  session.pending.clear()
  session.port.close()
}

self.addEventListener('message', (event) => {
  const data = event.data
  const port = event.ports[0]
  if (!data || data.type !== 'xdrive-media-register' || !port || !event.source || typeof event.source.id !== 'string') return
  if (typeof data.sessionId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(data.sessionId) ||
      !Number.isSafeInteger(data.length) || data.length < 0 ||
      typeof data.mime !== 'string' || !/^video\/[A-Za-z0-9.+-]{1,80}$/.test(data.mime) ||
      Object.keys(data).some((key) => !['type', 'sessionId', 'length', 'mime'].includes(key))) {
    port.close()
    return
  }
  if (sessions.has(data.sessionId)) { port.close(); return }
  if (sessions.size >= MAX_SESSIONS) closeSession(sessions.values().next().value)
  const session = { id: data.sessionId, length: data.length, mime: data.mime, ownerId: event.source.id, port, pending: new Map() }
  sessions.set(session.id, session)
  port.onmessage = (replyEvent) => {
    const reply = replyEvent.data
    if (!reply || typeof reply !== 'object') return
    const discardReplyBytes = () => {
      const bytes = reply.bytes
      try {
        if (ArrayBuffer.isView(bytes)) new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).fill(0)
        else if (bytes instanceof ArrayBuffer || typeof SharedArrayBuffer !== 'undefined' && bytes instanceof SharedArrayBuffer) new Uint8Array(bytes).fill(0)
      } catch { /* A detached buffer has no remaining bytes accessible here. */ }
    }
    if (reply.type === 'close') { discardReplyBytes(); closeSession(session); return }
    if (reply.type !== 'read-result' || !Number.isSafeInteger(reply.readId)) { discardReplyBytes(); return }
    const pending = session.pending.get(reply.readId)
    if (!pending) { discardReplyBytes(); return }
    session.pending.delete(reply.readId)
    clearPendingTimers(pending)
    if (reply.bytes instanceof Uint8Array && reply.bytes.byteLength === pending.length && reply.bytes.byteLength <= WINDOW_BYTES) {
      pending.resolve(reply.bytes)
    } else {
      discardReplyBytes()
      pending.reject(new TypeError('Media page returned an invalid byte window'))
    }
  }
  port.onmessageerror = () => closeSession(session)
  port.start()
  port.postMessage({ type: 'registered', sessionId: session.id })
})

function parseRange(header, length) {
  if (header === null) return { start: 0, end: length - 1, partial: false }
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header)
  if (!match || match[1] === '' && match[2] === '' || length === 0) return null
  let start
  let end
  if (match[1] === '') {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null
    start = Math.max(0, length - suffix)
    end = length - 1
  } else {
    start = Number(match[1])
    end = match[2] === '' ? length - 1 : Number(match[2])
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= length || end < start) return null
    end = Math.min(end, length - 1)
  }
  return { start, end, partial: true }
}

function requestWindow(session, begin, end) {
  const readId = nextReadId++
  const promise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const pending = session.pending.get(readId)
      if (pending) clearPendingTimers(pending)
      session.pending.delete(readId)
      session.port.postMessage({ type: 'cancel-read', readId })
      reject(new DOMException('Media page did not respond', 'TimeoutError'))
      closeSession(session)
    }, READ_TIMEOUT_MS)
    const pending = { resolve, reject, timeout, length: end - begin }
    session.pending.set(readId, pending)
    watchPendingOwner(session, pending, () => session.pending.get(readId) === pending && sessions.get(session.id) === session, () => closeSession(session))
    session.port.postMessage({ type: 'read', readId, begin, end })
  })
  return { readId, promise }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin || !url.pathname.startsWith(PREFIX)) return
  event.respondWith((async () => {
    if (event.request.method !== 'GET' && event.request.method !== 'HEAD') return new Response(null, { status: 405 })
    const sessionId = url.pathname.slice(PREFIX.length)
    const session = sessions.get(sessionId)
    if (!session || url.search) return new Response(null, { status: 410, headers: { 'Cache-Control': 'no-store' } })
    const owner = await self.clients.get(session.ownerId)
    if (!owner) { closeSession(session); return new Response(null, { status: 410, headers: { 'Cache-Control': 'no-store' } }) }
    if (!event.clientId || event.clientId !== session.ownerId) return new Response(null, { status: 403, headers: { 'Cache-Control': 'no-store' } })
    const range = parseRange(event.request.headers.get('Range'), session.length)
    if (!range) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${session.length}`, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' } })
    const headers = new Headers({
      'Content-Type': session.mime,
      'Content-Length': String(range.end - range.start + 1),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    if (range.partial) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${session.length}`)
    const status = range.partial ? 206 : 200
    if (event.request.method === 'HEAD' || session.length === 0) return new Response(null, { status, headers })
    let offset = range.start
    let activeReadId = 0
    let stopped = false
    let pulling = false
    let responseController
    const detach = () => event.request.signal.removeEventListener('abort', onAbort)
    const cancelRead = () => {
      if (!activeReadId) return
      const pending = session.pending.get(activeReadId)
      if (pending) {
        session.pending.delete(activeReadId)
        clearPendingTimers(pending)
        pending.reject(new DOMException('Media fetch was cancelled', 'AbortError'))
        session.port.postMessage({ type: 'cancel-read', readId: activeReadId })
      }
      activeReadId = 0
    }
    const stop = () => {
      if (stopped) return
      stopped = true
      detach()
      cancelRead()
    }
    const onAbort = () => {
      stop()
      responseController?.error(new DOMException('Media fetch was cancelled', 'AbortError'))
    }
    const body = new ReadableStream({
      start(controller) {
        responseController = controller
        event.request.signal.addEventListener('abort', onAbort, { once: true })
        if (event.request.signal.aborted) onAbort()
      },
      pull(controller) {
        if (stopped || pulling) return
        pulling = true
        // Settle the stream pull algorithm before awaiting the page-owned read
        // so consumer cancel() can run immediately even while a window is in flight.
        void (async () => {
          try {
            const currentOwner = await self.clients.get(session.ownerId)
            if (stopped) return
            if (!currentOwner || sessions.get(session.id) !== session) {
              closeSession(session)
              stop()
              controller.error(new DOMException('Media owner disappeared', 'AbortError'))
              return
            }
            const end = Math.min(range.end + 1, offset + WINDOW_BYTES)
            const read = requestWindow(session, offset, end)
            activeReadId = read.readId
            const bytes = await read.promise
            activeReadId = 0
            if (stopped) { bytes.fill(0); return }
            offset = end
            controller.enqueue(bytes)
            if (offset > range.end) { stop(); controller.close() }
          } catch (error) {
            activeReadId = 0
            if (stopped) return
            stop()
            controller.error(error)
          } finally {
            pulling = false
          }
        })()
      },
      cancel() { stop() },
    }, { highWaterMark: 0 })
    return new Response(body, { status, headers })
  })())
})
