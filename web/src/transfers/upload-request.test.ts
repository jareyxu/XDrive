import { afterEach, expect, test, vi } from 'vitest'
import { uploadRequest } from './upload-request'
import { networkBytes } from './network-meter'
class XHR {
 static instance: XHR
 upload = { onprogress: null as ((event: { loaded: number }) => void) | null }
 onload: (() => void) | null = null
 onerror: (() => void) | null = null
 onabort: (() => void) | null = null
 ontimeout: (() => void) | null = null
 responseText = ''
 status = 204
 timeout = 0
 constructor() { XHR.instance = this }
 open = vi.fn()
 setRequestHeader = vi.fn()
 send = vi.fn()
 abort() { this.onabort?.() }
 getAllResponseHeaders() { return 'Retry-After: 1\r\n' }
}
afterEach(() => vi.unstubAllGlobals())
test('upload progress counts bytes during a request, not just after confirmation', async () => {
 vi.stubGlobal('XMLHttpRequest', XHR)
 const before = networkBytes().upload
 const result = uploadRequest('/object', { 'X-CSRF-Token': 'test' }, new Uint8Array(100))
 XHR.instance.upload.onprogress!({ loaded: 40 })
 expect(networkBytes().upload - before).toBe(40)
 XHR.instance.upload.onprogress!({ loaded: 100 })
 expect(networkBytes().upload - before).toBe(100)
 XHR.instance.onload!()
 expect((await result).status).toBe(204)
 expect(XHR.instance.upload.onprogress).toBe(null)
})
test('abort stops upload and detaches all callbacks', async () => {
 vi.stubGlobal('XMLHttpRequest', XHR)
 const controller = new AbortController()
 const result = uploadRequest('/object', {}, new Uint8Array(10), controller.signal)
 controller.abort()
 await expect(result).rejects.toMatchObject({ name: 'AbortError' })
 expect(XHR.instance.onload).toBe(null)
 expect(XHR.instance.upload.onprogress).toBe(null)
})
