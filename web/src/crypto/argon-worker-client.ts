import { decodeBase64Strict, takeArrayBufferBytes, zeroArrayBuffer } from './encoding'
import { validateArgon2idParams } from './kdf'

interface WorkerReply {
  readonly id: number
  readonly key?: ArrayBuffer
  readonly error?: string
}

let nextId = 0

export async function derivePasswordKey(password: string, untrustedParams: unknown, signal?: AbortSignal): Promise<Uint8Array> {
  // Validate server-controlled parameters before creating WASM or a worker.
  const params = validateArgon2idParams(untrustedParams)
  signal?.throwIfAborted()
  let worker: Worker | undefined
  let salt: Uint8Array | undefined
  let detach = () => {}
  try {
    // Validate and allocate the transferred salt before creating a Worker.
    // Even this second decode can fail (for example, an allocation failure),
    // and must not leave an otherwise idle Worker behind.
    salt = decodeBase64Strict(params.salt)
    const workerSalt = salt
    const activeWorker = new Worker(new URL('../workers/argon.worker.ts', import.meta.url), { type: 'module' })
    worker = activeWorker
    const id = ++nextId
    return await new Promise<Uint8Array>((resolve, reject) => {
      const onMessage = (event: MessageEvent<WorkerReply>) => {
        if (event.data.id !== id) {
          // A stale or malformed reply is never adopted. It may still carry a
          // transferred raw key, so discard that buffer explicitly.
          if (event.data.key) zeroArrayBuffer(event.data.key)
          return
        }
        activeWorker.removeEventListener('message', onMessage)
        activeWorker.removeEventListener('error', onError)
        if (!event.data.key) { reject(new Error('key derivation failed')); return }
        const keyBuffer = event.data.key
        if (keyBuffer.byteLength !== 32) {
          zeroArrayBuffer(keyBuffer)
          reject(new Error('key derivation returned an invalid key length'))
          return
        }
        try {
          resolve(takeArrayBufferBytes(keyBuffer))
        } catch (error) {
          // The worker transferred ownership of this raw key to the main
          // thread. If a byte view cannot be allocated, clear the underlying
          // buffer and reject so the outer finally still terminates the worker.
          reject(error)
        }
      }
      const onError = () => {
        activeWorker.removeEventListener('message', onMessage)
        activeWorker.removeEventListener('error', onError)
        reject(new Error('key derivation worker failed'))
      }
      const onAbort = () => {
        detach()
        reject(new DOMException('Key derivation cancelled', 'AbortError'))
      }
      detach = () => {
        activeWorker.removeEventListener('message', onMessage)
        activeWorker.removeEventListener('error', onError)
        signal?.removeEventListener('abort', onAbort)
      }
      activeWorker.addEventListener('message', onMessage)
      activeWorker.addEventListener('error', onError)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) { onAbort(); return }
      activeWorker.postMessage({
        id,
        password,
        salt: workerSalt.buffer,
        memoryKiB: params.m,
        iterations: params.t,
        parallelism: params.p,
      }, { transfer: [workerSalt.buffer] })
    })
  } finally {
    detach()
    // postMessage transfers and detaches the salt buffer; the worker clears its
    // copy after derivation, while an untransferred local copy is cleared here.
    if (salt?.byteLength) salt.fill(0)
    worker?.terminate()
  }
}
