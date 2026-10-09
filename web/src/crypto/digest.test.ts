import { expect, it, vi } from 'vitest'
import { sha256Hex } from './digest'

it('clears the temporary Web Crypto digest input and result buffers', async () => {
  const originalDigest = crypto.subtle.digest.bind(crypto.subtle)
  let digestInput: Uint8Array | undefined
  let digestOutput: Uint8Array | undefined
  const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
    if (data instanceof ArrayBuffer) digestInput = new Uint8Array(data)
    const result = await originalDigest(algorithm, data)
    digestOutput = new Uint8Array(result)
    return result
  })
  const source = new Uint8Array([88, 68, 82, 86, 69])

  try {
    const hash = await sha256Hex(source)
    expect(hash).toMatch(/^[0-9a-f]{64}$/u)
    expect(source).toEqual(new Uint8Array([88, 68, 82, 86, 69]))
    expect(digestInput).toEqual(new Uint8Array(5))
    expect(digestOutput).toEqual(new Uint8Array(32))
  } finally { spy.mockRestore() }
})

it('clears the raw digest result and input when creating a result view fails', async () => {
  const digestBuffer = new ArrayBuffer(32)
  new Uint8Array(digestBuffer).fill(0x6a)
  const NativeUint8Array = globalThis.Uint8Array
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Uint8Array')!
  const replacement = new Proxy(NativeUint8Array, {
    construct(target, args, newTarget) {
      if (args[0] === digestBuffer) throw new Error('digest view allocation failed')
      return Reflect.construct(target, args, newTarget)
    },
  })
  let digestInput: Uint8Array | undefined
  const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation((_algorithm, data) => {
    digestInput = data instanceof ArrayBuffer
      ? new NativeUint8Array(data)
      : new NativeUint8Array(data.buffer, data.byteOffset, data.byteLength)
    return Promise.resolve(digestBuffer)
  })
  Object.defineProperty(globalThis, 'Uint8Array', { ...descriptor, value: replacement })

  try {
    await expect(sha256Hex(new NativeUint8Array([4, 5, 6]))).rejects.toThrow('digest view allocation failed')
    expect(digestInput).toEqual(new NativeUint8Array(3))
    expect(new NativeUint8Array(digestBuffer)).toEqual(new NativeUint8Array(32))
  } finally {
    Object.defineProperty(globalThis, 'Uint8Array', descriptor)
    spy.mockRestore()
  }
})
