import { NetworkUnavailableError } from '../api/network-retry'
import { recordNetworkBytes } from './network-meter'
import { uploadAdaptive, observeTransfer } from './policy'

/** Same-origin XHR exposes wire progress without changing the object protocol. */
export function uploadRequest(path: string, headers: Record<string, string>, body: Uint8Array, signal?: AbortSignal): Promise<Response> {
  signal?.throwIfAborted()
  if (typeof XMLHttpRequest === 'undefined') return fetch(path, { method: 'PUT', credentials: 'same-origin', cache: 'no-store', headers, body: body.slice().buffer, signal }).then(response => {
    recordNetworkBytes('upload', body.byteLength)
    return response
  })
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    let sent = 0
    const abort = () => { xhr.abort(); finish(signal?.reason ?? new DOMException('Cancelled', 'AbortError')) }
    let settled = false
    const finish = (error?: unknown, response?: Response) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      xhr.onload = xhr.onerror = xhr.onabort = xhr.ontimeout = null
      xhr.upload.onprogress = null
      if (error) reject(error); else resolve(response!)
    }
    xhr.open('PUT', path)
    xhr.timeout = 10 * 60_000 // Match the server receiver budget for slow connections.
    Object.entries(headers).forEach(([name, value]) => xhr.setRequestHeader(name, value))
    xhr.upload.onprogress = event => {
      const count = Math.max(0, Math.min(body.byteLength, event.loaded) - sent)
      sent += count
      recordNetworkBytes('upload', count)
      observeTransfer('upload', count)
    }
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status > 599) { finish(new NetworkUnavailableError()); return }
      const responseHeaders = new Headers()
      for (const line of xhr.getAllResponseHeaders().trim().split(/[\r\n]+/u)) {
        const colon = line.indexOf(':')
        if (colon > 0) responseHeaders.append(line.slice(0, colon), line.slice(colon + 1).trim())
      }
      finish(undefined, new Response([204, 205, 304].includes(xhr.status) ? null : xhr.responseText, { status: xhr.status, headers: responseHeaders }))
    }
    xhr.onerror = xhr.ontimeout = () => { uploadAdaptive.congested(); finish(new NetworkUnavailableError()) }
    xhr.onabort = () => finish(signal?.reason ?? new DOMException('Cancelled', 'AbortError'))
    signal?.addEventListener('abort', abort, { once: true })
    try {
      signal?.throwIfAborted()
      // The producer owns this encrypted view until the request settles.
      // Preserve byteOffset/byteLength and avoid an extra whole-chunk JS copy.
      xhr.send(body.buffer instanceof ArrayBuffer ? body as Uint8Array<ArrayBuffer> : body.slice().buffer)
    } catch (error) { finish(error) }
  })
}
