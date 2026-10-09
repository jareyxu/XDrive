import { expect, test } from 'vitest'
import { fixtureKEK } from '../e2e/encrypted-directory-fixture'
import { encodeBase64 } from '../src/crypto/encoding'
import { wrapVaultKey, unwrapVaultKeyBytes } from '../src/crypto/keys'
import type { Argon2idParams } from '../src/crypto/constants'

test('test fixture uses actual Argon2id/WASM and can unwrap a production Vault slot', async () => {
  const kdf: Argon2idParams = { alg: 'argon2id', salt: encodeBase64(new Uint8Array(16).fill(7)), m: 32768, t: 2, p: 1 }
  const rawVaultKey = new Uint8Array(32).fill(42)
  const kek = await fixtureKEK('correct horse battery', kdf)
  const slot = await wrapVaultKey(kek, rawVaultKey, 'test-slot-012345678901', kdf)
  const independent = await fixtureKEK('correct horse battery', kdf)
  const opened = await unwrapVaultKeyBytes(independent, { formatVersion: 1, revision: 1, slots: [slot] })
  expect(opened).toEqual(rawVaultKey)
  const wrong = await fixtureKEK('different password', kdf)
  await expect(unwrapVaultKeyBytes(wrong, { formatVersion: 1, revision: 1, slots: [slot] })).rejects.toThrow()
  opened.fill(0); rawVaultKey.fill(0)
}, 20_000)
