import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { derivePasswordKey } from './argon-worker-client'

const params = { alg: 'argon2id', salt: 'AAECAwQFBgcICQoLDA0ODw==', m: 65536, t: 3, p: 1 }
let workers: TestWorker[] = []
const NativeUint8Array = globalThis.Uint8Array
class TestWorker extends EventTarget {
  id = 0
  terminate = vi.fn()
  postMessage = vi.fn((message: { id: number }) => { this.id = message.id })
  constructor() { super(); workers.push(this) }
  reply(key = new Uint8Array(32).fill(7)) { this.dispatchEvent(new MessageEvent('message', { data: { id: this.id, key: key.buffer } })); return key }
}
beforeEach(() => { workers = []; vi.stubGlobal('Worker', TestWorker) })
afterEach(() => vi.unstubAllGlobals())

function failUint8ArrayViewFor(buffer: ArrayBuffer): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Uint8Array')!
  const Native = descriptor.value as typeof Uint8Array
  const replacement = new Proxy(Native, {
    construct(target, args, newTarget) {
      if (args[0] === buffer) throw new Error('worker key view allocation failed')
      return Reflect.construct(target, args, newTarget)
    },
  })
  Object.defineProperty(globalThis, 'Uint8Array', { ...descriptor, value: replacement })
  return () => Object.defineProperty(globalThis, 'Uint8Array', descriptor)
}

test.each([
  { ...params, m: 131073 }, { ...params, m: 32767 },
  { ...params, t: NaN }, { ...params, p: 1.5 },
  { ...params, salt: 'AAECAwQ' }, { ...params, salt: 'AAECAwR=' },
])('rejects untrusted bounds/encoding before allocating any Worker: %j', async candidate => {
  await expect(derivePasswordKey('synthetic fixture password', candidate)).rejects.toThrow()
  expect(workers).toHaveLength(0)
})

test('an already-cancelled derivation creates no Worker', async () => {
  const controller = new AbortController(); controller.abort()
  await expect(derivePasswordKey('synthetic fixture password', params, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(workers).toHaveLength(0)
})

test('a failure while preparing the transferred salt happens before Worker allocation', async () => {
  const nativeAtob = globalThis.atob.bind(globalThis)
  let calls = 0
  const atobSpy = vi.spyOn(globalThis, 'atob').mockImplementation((input: string) => {
    calls += 1
    if (calls === 2) throw new Error('transfer salt decode failed')
    return nativeAtob(input)
  })
  try {
    await expect(derivePasswordKey('synthetic fixture password', params)).rejects.toThrow('invalid base64 encoding')
    expect(calls).toBe(2)
    expect(workers).toHaveLength(0)
  } finally { atobSpy.mockRestore() }
})

test('abort terminates an in-flight Worker once, rejects immediately and detaches reply listeners', async () => {
  const controller = new AbortController()
  const result = derivePasswordKey('synthetic fixture password', params, controller.signal)
  const worker = workers[0]!
  controller.abort()
  // A queued reply must not win a cancellation that already occurred.
  worker.reply()
  await expect(result).rejects.toMatchObject({ name: 'AbortError' })
  expect(worker.terminate).toHaveBeenCalledTimes(1)
  worker.reply()
  expect(worker.terminate).toHaveBeenCalledTimes(1)
})

test('success preserves the 32-byte result and terminates once; later abort cannot affect it', async () => {
  const controller = new AbortController()
  const result = derivePasswordKey('synthetic fixture password', params, controller.signal)
  workers[0]!.reply()
  expect(await result).toEqual(new Uint8Array(32).fill(7))
  controller.abort()
  expect(workers[0]!.terminate).toHaveBeenCalledTimes(1)
})

test('a transferred worker key is cleared and rejected when its view cannot be allocated', async () => {
  const buffer = new NativeUint8Array(32).fill(0x73).buffer
  const result = derivePasswordKey('synthetic fixture password', params)
  const restoreConstructor = failUint8ArrayViewFor(buffer)
  try {
    workers[0]!.dispatchEvent(new MessageEvent('message', { data: { id: workers[0]!.id, key: buffer } }))
    await expect(result).rejects.toThrow('worker key view allocation failed')
    expect(new NativeUint8Array(buffer)).toEqual(new NativeUint8Array(32))
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1)
  } finally { restoreConstructor() }
})

test('a worker result with an invalid key length is cleared and rejected', async () => {
  const key = new NativeUint8Array(31).fill(0x73)
  const result = derivePasswordKey('synthetic fixture password', params)
  workers[0]!.reply(key)
  await expect(result).rejects.toThrow('invalid key length')
  expect(key).toEqual(new NativeUint8Array(31))
  expect(workers[0]!.terminate).toHaveBeenCalledTimes(1)
})

test('a key in a stale reply is cleared while the matching derivation remains active', async () => {
  const staleBuffer = new NativeUint8Array(32).fill(0x4d).buffer
  const result = derivePasswordKey('synthetic fixture password', params)
  const worker = workers[0]!
  worker.dispatchEvent(new MessageEvent('message', { data: { id: worker.id + 1, key: staleBuffer } }))
  expect(new NativeUint8Array(staleBuffer)).toEqual(new NativeUint8Array(32))
  expect(worker.terminate).not.toHaveBeenCalled()
  worker.reply()
  expect(await result).toEqual(new NativeUint8Array(32).fill(7))
  expect(worker.terminate).toHaveBeenCalledTimes(1)
})

test('worker failure terminates and removes cancellation/reply listeners', async () => {
  const controller = new AbortController()
  const result = derivePasswordKey('synthetic fixture password', params, controller.signal)
  workers[0]!.dispatchEvent(new Event('error'))
  await expect(result).rejects.toThrow('worker failed')
  controller.abort()
  expect(workers[0]!.terminate).toHaveBeenCalledTimes(1)
})
