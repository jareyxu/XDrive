// Test-only fixture builder. Uses production cryptographic formats and public APIs;
// no server hooks, database writes, app key inspection or synthetic directory responses.
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import setupArgon2idWasm from 'argon2id/lib/setup.js'
import type { APIRequestContext } from '@playwright/test'
import { CLIENT_PROTOCOL_VERSION } from '../src/api/protocol'
import { indexAAD } from '../src/crypto/aad'
import { decryptObject, encryptObject } from '../src/crypto/envelope'
import { decodeBase64Strict, utf8Strict } from '../src/crypto/encoding'
import { validateArgon2idParams } from '../src/crypto/kdf'
import { deriveIndexId, deriveVaultKey, unwrapVaultKey } from '../src/crypto/keys'
import type { VaultConfigV1 } from '../src/crypto/keys'
import type { Argon2idParams } from '../src/crypto/constants'

const require = createRequire(import.meta.url)
let wasm: ReturnType<typeof setupArgon2idWasm> | undefined
export async function fixtureKEK(password: string, untrustedKDF: Argon2idParams): Promise<CryptoKey> {
  const kdf = validateArgon2idParams(untrustedKDF)
  const passwordBytes = utf8Strict(password), salt = decodeBase64Strict(kdf.salt)
  const instantiate = (name: string, imports: WebAssembly.Imports) => {
    const bytes = new Uint8Array(readFileSync(require.resolve(`argon2id/dist/${name}.wasm`)))
    return WebAssembly.instantiate(bytes.buffer as ArrayBuffer, imports)
  }
  wasm ??= setupArgon2idWasm((imports) => instantiate('simd', imports), (imports) => instantiate('no-simd', imports))
  let passwordKey: Uint8Array | undefined
  try {
    const argon2 = await wasm
    passwordKey = argon2({ password: passwordBytes, salt, memorySize: kdf.m, passes: kdf.t, parallelism: kdf.p, tagLength: 32 })
    const material = await crypto.subtle.importKey('raw', passwordKey.slice().buffer as ArrayBuffer, 'HKDF', false, ['deriveKey'])
    return await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: utf8Strict('xdrive/v1/kek').buffer as ArrayBuffer }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  } finally { passwordBytes.fill(0); salt.fill(0); passwordKey?.fill(0) }
}
function opaqueId(): string { return randomBytes(24).toString('base64url') }
export class EncryptedDirectoryFixture {
  private entries: unknown[] = []
  private revision = 1
  private globalRevision = 1
  private readonly api: APIRequestContext
  private readonly baseURL: string
  private readonly csrf: string
  readonly rootId: string
  private readonly key: CryptoKey
  private readonly cookie: string
  private constructor(api: APIRequestContext, baseURL: string, csrf: string, rootId: string, key: CryptoKey, cookie: string) {
    this.api = api; this.baseURL = baseURL; this.csrf = csrf; this.rootId = rootId; this.key = key; this.cookie = cookie
  }
  static async open(api: APIRequestContext, baseURL: string, password: string, cookie: string, allowExisting = false): Promise<EncryptedDirectoryFixture> {
    if (!['127.0.0.1', 'localhost'].includes(new URL(baseURL).hostname) || !/^xdrive_session=[A-Za-z0-9_-]{16,128}$/u.test(cookie)) throw new Error('fixture requires an authenticated loopback server')
    // Chromium sends Secure cookies on trustworthy loopback HTTP; Node's API
    // request jar does not. Explicitly forward only this test browser's session.
    const get = (path: string) => api.get(`${baseURL}${path}`, { headers: { Cookie: cookie }, maxRedirects: 0 })
    const configResponse = await get(`/api/v1/vault/config`)
    if (!configResponse.ok()) throw new Error(`fixture config failed: ${configResponse.status()}`)
    const configuration = await configResponse.json() as VaultConfigV1
    const sessionResponse = await get(`/api/v1/auth/session`)
    const session = await sessionResponse.json() as { authenticated: boolean }
    const csrfToken = sessionResponse.headers()['x-csrf-token']
    if (!sessionResponse.ok() || !session.authenticated || !csrfToken) throw new Error('fixture session unavailable')
    const kek = await fixtureKEK(password, configuration.slots[0]!.kdf)
    const vaultKey = await unwrapVaultKey(kek, configuration)
    const rootId = await deriveIndexId(vaultKey, 'root')
    const key = await deriveVaultKey(vaultKey, 'xdrive/v1/meta')
    const stateResponse = await get(`/api/v1/vault/state`)
    const pointerResponse = await get(`/api/v1/metadata/${rootId}`)
    if (!stateResponse.ok() || !pointerResponse.ok()) throw new Error('fixture initial revision unavailable')
    const state = await stateResponse.json() as { vaultMutationRevision: number }
    const pointer = await pointerResponse.json() as { revision: number; objectId: string; sha256: string }
    let initialEntries: unknown[] = []
    const objectResponse = await get(`/api/v1/objects/${pointer.objectId}`)
    if (!objectResponse.ok()) throw new Error("fixture root object unavailable")
    const encrypted = new Uint8Array(await objectResponse.body())
    if (createHash("sha256").update(encrypted).digest("hex") !== pointer.sha256) throw new Error("fixture root digest mismatch")
    const plaintext = await decryptObject(key, encrypted, indexAAD(rootId, pointer.revision))
    try {
      const root = JSON.parse(new TextDecoder().decode(plaintext)) as { version: number; indexId: string; entries: unknown[] }
      if (root.version !== 1 || root.indexId !== rootId || !Array.isArray(root.entries) || (!allowExisting && root.entries.length !== 0)) throw new Error("fixture requires a valid root and, unless explicitly allowed, an empty root")
      initialEntries = root.entries
    } finally { plaintext.fill(0); encrypted.fill(0) }
    const fixture = new EncryptedDirectoryFixture(api, baseURL, csrfToken, rootId, key, cookie)
    fixture.entries = initialEntries
    fixture.globalRevision = state.vaultMutationRevision
    fixture.revision = pointer.revision
    return fixture
  }
  private async post<T>(path: string, data: unknown, idempotencyKey?: string): Promise<T> {
    const response = await this.api.post(`${this.baseURL}/api/v1${path}`, { data, headers: { Cookie: this.cookie, Origin: this.baseURL, 'X-CSRF-Token': this.csrf, 'X-XDrive-Client-Protocol': CLIENT_PROTOCOL_VERSION, ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) } })
    if (!response.ok()) throw new Error(`fixture request failed: ${path} ${response.status()} ${(await response.text()).slice(0, 200)}`)
    return await response.json() as T
  }
  async growTo(count: number): Promise<{ count: number; rootEncryptedBytes: number; globalRevision: number }> {
    if (!Number.isInteger(count) || count < this.entries.length || count > 5000) throw new TypeError('invalid fixture directory count')
    let rootEncryptedBytes = 0
    while (this.entries.length < count) {
      const prepared: { objectId: string; metadataId: string; expectedRevision: number; encrypted: Uint8Array }[] = []
      const batchEnd = Math.min(count, this.entries.length + 200)
      while (this.entries.length < batchEnd) {
        const childIndexId = opaqueId()
        this.entries.push({ entryId: opaqueId(), kind: 'folder', name: `folder-${String(this.entries.length).padStart(5, '0')}`, childIndexId })
        prepared.push({ objectId: opaqueId(), metadataId: childIndexId, expectedRevision: 0, encrypted: await encryptObject(this.key, utf8Strict(JSON.stringify({ version: 1, indexId: childIndexId, entries: [] })), indexAAD(childIndexId, 1)) })
      }
      const encrypted = await encryptObject(this.key, utf8Strict(JSON.stringify({ version: 1, indexId: this.rootId, entries: this.entries })), indexAAD(this.rootId, this.revision + 1))
      rootEncryptedBytes = encrypted.byteLength
      prepared.push({ objectId: opaqueId(), metadataId: this.rootId, expectedRevision: this.revision, encrypted })
      const { uploadId } = await this.post<{ uploadId: string }>('/uploads', {})
      await this.post(`/uploads/${uploadId}/reserve`, { reservedBytes: prepared.reduce((sum, item) => sum + item.encrypted.byteLength, 0) })
      for (const item of prepared) {
        const response = await this.api.put(`${this.baseURL}/api/v1/uploads/${uploadId}/objects/${item.objectId}`, {
          data: Buffer.from(item.encrypted), headers: { Cookie: this.cookie, Origin: this.baseURL, 'X-CSRF-Token': this.csrf, 'X-XDrive-Client-Protocol': CLIENT_PROTOCOL_VERSION, 'X-XDrive-Object-Size': String(item.encrypted.byteLength), 'X-XDrive-Ciphertext-SHA256': createHash('sha256').update(item.encrypted).digest('hex') },
        })
        if (response.status() !== 201) throw new Error(`fixture object PUT failed: ${response.status()}`)
        item.encrypted.fill(0)
      }
      const committed = await this.post<{ vaultMutationRevision: number }>('/metadata/transactions', {
        uploadId, expectedGlobalRevision: this.globalRevision, activateObjectIds: prepared.map((item) => item.objectId),
        updates: prepared.map((item) => ({ metadataId: item.metadataId, objectId: item.objectId, expectedRevision: item.expectedRevision })),
      }, opaqueId())
      this.globalRevision = committed.vaultMutationRevision
      this.revision += 1
    }
    return { count, rootEncryptedBytes, globalRevision: this.globalRevision }
  }
}
