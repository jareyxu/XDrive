import setupArgon2idWasm from 'argon2id/lib/setup.js'
import simdWasmUrl from 'argon2id/dist/simd.wasm?url'
import nonSimdWasmUrl from 'argon2id/dist/no-simd.wasm?url'

interface DeriveMessage {
  readonly id: number
  readonly password: string
  readonly salt: ArrayBuffer
  readonly memoryKiB: number
  readonly iterations: number
  readonly parallelism: number
}

let wasmPromise: ReturnType<typeof setupArgon2idWasm> | undefined

self.addEventListener('message', (event: MessageEvent<DeriveMessage>) => {
  void derive(event.data)
})

async function derive(message: DeriveMessage): Promise<void> {
  const password = new TextEncoder().encode(message.password)
  const salt = new Uint8Array(message.salt)
  try {
    wasmPromise ??= setupArgon2idWasm(
      (imports) => instantiateWasm(simdWasmUrl, imports),
      (imports) => instantiateWasm(nonSimdWasmUrl, imports),
    )
    const argon2id = await wasmPromise
    const key = argon2id({
      password,
      salt,
      memorySize: message.memoryKiB,
      passes: message.iterations,
      parallelism: message.parallelism,
      tagLength: 32,
    })
    const output = key instanceof Uint8Array ? key : new Uint8Array(key)
    self.postMessage({ id: message.id, key: output.buffer }, { transfer: [output.buffer] })
  } catch {
    self.postMessage({ id: message.id, error: 'key_derivation_failed' })
  } finally {
    password.fill(0)
    salt.fill(0)
  }
}

async function instantiateWasm(url: string, imports: WebAssembly.Imports): Promise<WebAssembly.WebAssemblyInstantiatedSource> {
  const response = await fetch(url)
  if (!response.ok) throw new Error('argon2_wasm_unavailable')
  const bytes = await response.arrayBuffer()
  return WebAssembly.instantiate(bytes, imports)
}
