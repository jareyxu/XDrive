# Current encrypted format notes

This document describes the implemented format. The format matrix currently records `v1.3.1` as release-approved based on the user's explicit attestation that the remaining compatibility and independent-review gates are complete; the report and evidence limits are recorded in the [release preflight](operations/artifacts/release-preflight-2026-10-09.md). This document does not replace the shared vectors or the requirements in `IMPLEMENTATION.md`.

## Persistent-format version matrix

[`format-version-matrix.json`](format-version-matrix.json) is the machine-readable index of the current writers, accepted reader versions, required fields, legacy meanings, and version-evolution rules for browser-owned payloads and server persistence. Its current status is `release-approved` for `v1.3.1`; the approval basis and the absence of the underlying external report from this repository are recorded in the matrix and release preflight.

| Dimension | Current writer | Current readers | Compatibility rule |
|---|---:|---:|---|
| Encrypted object envelope | 1 (AES-256-GCM ID 1) | 1 | Unknown envelope/cipher versions reject. |
| Vault config and key-slot AAD | 2 for new setup | 1, 2 | Config format binds into key-slot AAD; the Vault Key remains the same across password changes. |
| File key/AAD crypto version | 1 or 2, selected by Vault config | 1, 2 | Missing directory-entry version means legacy 1; versions select key derivation and chunk/manifest/thumbnail AAD, not manifest schema. |
| Directory and trash payload schema | 1 | 1 | Exact known fields only; supported optional directory-entry fields and absent-value meanings are listed in the JSON matrix. |
| File manifest payload schema | 3 | legacy 1, 2 and current 3 | Legacy 1/2 overload the field as crypto version; schema 3 has a separate `fileCryptoVersion`. |
| Encrypted upload-recovery payload | 4 | 1–4 | Version-specific exact parser; versions 1–3 imply crypto version 1, and version 4 records it explicitly. |
| Local-state AAD / IndexedDB name | 1 / `xdrive-local-v1` | 1 | Records are encrypted under `K_local` before persistence. |
| Backup container / SQLite | 1 / schema 7 | container 1 / snapshot schema 2–7 | Independent version dimensions; restore accepts only a validated snapshot and referenced object set. |
| Client mutation protocol | 1 | exact match only | Go and TypeScript declarations must match; missing, older, or future values reject before request-body processing. |

Payload schema, cryptographic key/AAD version, envelope version, client mutation protocol, backup container version, and SQLite schema are independent. A new field or changed interpretation requires a new payload schema version; a stale client that could make unsafe mutations requires a mutation-protocol bump. Unknown versions and fields stay fail-closed. `make scripts-check` runs `tests/persistent_format_contract_test.py` to catch drift between this matrix and selected Go/TypeScript reader and writer declarations. Detailed runtime schema behavior remains covered by the shared fixtures and unit tests.

## Encrypted object envelope

The binary envelope is:

```text
magic[4] = "XDRV"
version[1] = 1
cipher[1] = 1 (AES-256-GCM)
reserved[2] = 0
nonce[12]
ciphertext_and_tag[plaintext_size + 16]
```

The fixed object overhead is 36 bytes. The browser calls `crypto.getRandomValues()` for a fresh 12-byte nonce for each AES-GCM object encryption; password-slot wrapping uses the same fresh 96-bit CSPRNG rule. The nonce space is probabilistic, not a global uniqueness counter: for `n` operations under one AES key, the birthday-bound collision probability is approximately `n(n−1)/2^97` (about `2^-33` at `2^32` operations under that key). The implementation does not persist a nonce registry or retry on collision. It instead follows the protocol requirement to allocate a new nonce whenever it encrypts; upload retries replay the already persisted encrypted envelope, while a re-encryption attempt after identity/content mismatch creates a new object identity and nonce. A collision remains a theoretical AES-GCM risk and is not claimed impossible. Temporary nonce, IV, AAD and input copies are cleared in `finally` blocks where JavaScript exposes them, including encryption failure. The server treats the envelope as opaque and verifies declared length and SHA-256 before publishing it.

## Password slot and keys

The browser uses Argon2id with a random 16-byte salt and the currently configured default of 65,536 KiB memory, 3 iterations, and parallelism 1. Validated bounds are in `web/src/crypto/constants.ts`. HKDF-SHA-256 with an empty salt and domain labels separates `xdrive/v1/kek` and `xdrive/v1/auth`. The KEK wraps a random 32-byte Vault Key. `vault_config.formatVersion` is 1 or 2 and is bound into key-slot AAD. Both versions derive metadata and root/trash opaque IDs directly from the Vault Key. Version 1 file and thumbnail keys retain the original direct Vault Key labels `xdrive/v1/file/{fileId}` and `xdrive/v1/thumb/{fileId}`. Version 2 derives a non-exportable `K_data = HKDF(VK, empty salt, info="xdrive/v1/data")`, then derives per-file keys with `salt=UTF8(fileId)` and info `xdrive/v1/file` or `xdrive/v1/thumb`. Each encrypted file entry carries `fileCryptoVersion`; legacy missing fields mean version 1. Password changes can rewrap the same Vault Key in a version 2 slot without re-encrypting existing files. See [ADR-048](adr/ADR-048-versioned-k-data-key-hierarchy.md).

Key-slot AAD binds format version, config revision, slot ID, slot type, KDF algorithm and parameters, and the decoded salt. The server stores the encrypted key slot and a salted authentication verifier, not the password or unwrapped Vault Key.

## AAD

AAD uses a fixed domain label, big-endian integer encodings, and four-byte big-endian length prefixes for variable-length fields. The implemented domains are key slot, chunk, manifest, thumbnail, directory index, and local state. V1 vectors live in `tests/testdata/crypto-v1.json`; version 2 key-slot, per-file HKDF and object AAD vectors live in `tests/testdata/crypto-v2.json`. Go and TypeScript tests consume the shared files.

## Directory index

The current root index plaintext is UTF-8 JSON with `version: 1`, its derived `indexId`, and an `entries` array. A file entry records opaque entry/file/manifest IDs, the encrypted manifest digest, file size, MIME value, and name. File names and the MIME value are inside the encrypted index. The browser rejects more than 5,000 direct entries or an encrypted index above 4 MiB, validates exact entry keys, and compares NFC-normalized names case-sensitively.

The server stores a pointer from opaque metadata ID and revision to an object ID. Pointer changes use expected local and global revisions. The server never parses decrypted directory indexes.

## File manifest and chunks

New manifest plaintext uses schema `version: 3` and the separate `fileCryptoVersion: 1 | 2`, plus `fileId`, `size`, `chunkSize`, `chunkCount`, `mime`, `originalModifiedAt`, ordered chunk records with explicit zero-based `index`, and `thumbnail: null | ThumbnailReference`. Optional `media` contains exactly `durationMs`, `width`, and `height`; current uploads omit it when browser metadata is not available at upload time. New files use the same opaque ID for `entryId` and `fileId`; the reader still accepts distinct IDs written before this schema decision. Legacy manifests with `version: 1 | 2` used that field as the crypto version and did not have a separate schema version; they remain readable under their exact legacy key sets. The selected crypto version must match the directory entry (legacy absence means V1). The manifest is encrypted with that version's file key and manifest AAD; each data chunk uses the same key version and chunk AAD binding file ID, zero-based chunk index, total chunk count, and plaintext size.

New uploads record their actual plaintext chunk size (currently 8 MiB). Readers accept 1 byte through `MAX_CLIENT_FILE_CHUNK_BYTES` (16 MiB minus the 36-byte encrypted-object overhead), use the recorded value for range mapping, and treat the missing field in legacy manifests as the historical 8 MiB default. An empty file has `chunkCount: 0`, zero data chunks, and a non-empty encrypted manifest and directory entry. Downloads stream through File System Access or the verified desktop Chromium Service Worker path. The in-memory Blob fallback is capped at 512 MiB; this does not certify other platforms or total browser memory.

The client uses a duplicate-member-rejecting JSON parser for authenticated manifest, directory/trash index, and encrypted local recovery payloads before schema validation. This prevents JSON parser differences from silently selecting one of two repeated fields. Unknown schema fields and unsupported versions remain fail-closed.

## Encrypted local upload recovery

New upload-resume payloads use numeric `version: 4` inside the existing K_local/AAD encrypted IndexedDB row. They bind a required `fileCryptoVersion` and retain the version-3 encrypted thumbnail write-ahead state. The envelope and local-state AAD remain V1. Replacement records require `replacementFingerprint`, a lowercase 64-character SHA-256 of strict UTF-8 encoding of the fixed target-identity array string: `[entryId, kind, name, fileId, manifestSha256, childIndexId]`; absent optional array values serialize as null. This client-local identity encoding is not the binary AAD protocol and is not a server authentication token. The separate original-file fingerprint still validates size, modification time and sampled bytes.

Readers accept exact numeric versions 1 through 4 with version-specific fields and reject unknown fields, versions, or crypto-version mismatches. Versions 1–3 are treated as legacy file crypto version 1; version 4 explicitly records 1 or 2. V1 nonreplacement records remain readable. V1 replacement records lack the original target identity and can be abandoned but cannot resume automatically. V2/V3/V4 replacement checks the current target digest before writes; a mismatch requires abandoning and selecting the upload again for fresh confirmation. Older readers must reject newer schemas rather than reinterpret them. See [ADR-035](adr/ADR-035-file-replaces-folder.md), [ADR-046](adr/ADR-046-encrypted-media-thumbnails.md), [ADR-048](adr/ADR-048-versioned-k-data-key-hierarchy.md), and the strict parser in `web/src/uploads/resume.ts`. This is a documented current payload change, not completion of the planned full format-freeze review.

## Freeze status

Cross-runtime V1/V2 AAD and HKDF vectors pass; the shared AEAD vectors include full-envelope reproduction and bit-mutation rejection. Manifest schema 3 separates payload schema from file crypto version while keeping exact legacy readers. Shared fixtures and strict tests now cover legacy/current manifests, directory and trash indexes, and recovery versions 1–4. The encrypted zero-byte round-trip passes desktop Chromium, WebKit and Firefox automation, and nonce allocation/cleanup behavior has focused tests. The server-side stale-client mutation gate is implemented and tested. At the time of the 2026-10-07 audit, persistent-transaction freeze and format-change rollback rehearsal were still open. The user later confirmed completion of the independent review and compatibility rehearsal; the current release decision is recorded in the matrix. Native/mobile and target-host behavior outside the selected release gate is not claimed. The pre-release matched-deployment and version-bump policy is in [ADR-173](adr/ADR-173-pre-release-format-compatibility.md). See the [2026-10-07 format audit](format-freeze-audit-2026-10-07.md).

## Optional entry timestamps (ADR-044, provisional)

Directory/trash DriveEntry now accepts optional `originalModifiedAt` and `createdAt` as safe integer milliseconds in 0..8640000000000000. New uploads preserve File.lastModified (resume uses the fingerprint-protected recovery value); new folders use client creation time. The upload preflight rejects invalid modification dates before creating its reservation. Missing fields in older entries remain unknown; no date is inferred. Unknown entry fields still fail closed. Timestamps are encrypted inside each index, charged as actual envelope bytes and retained by move/rename/trash operations. createdAt on a resumed candidate describes that candidate's creation, not a guaranteed original first-attempt date.

Old strict browser code rejects new entry fields, so this provisional development change requires matched frontend/backend deployment and reloading older tabs. It does not alter envelope/AAD or SQLite and is not a completed format-freeze review. Manifest time/thumbnail structures still need full requirements conformance before freezing V1.

## Media reference and upload recovery V3 (ADR-046, provisional)

New file manifests allow `thumbnail: null | ThumbnailReference`; new encrypted file entries carry the same reference when present. ThumbnailReference has exactly objectId, sizeBytes (complete encrypted envelope), sha256, mime=image/webp or image/jpeg, width and height. Plaintext output is at most 256 KiB, dimensions 1..256; reference size/hash and AEAD/AAD are verified before creating a temporary plaintext Blob. Manifest and index references must agree. Prior manifests/entries without thumbnail remain readable. Both the file and thumbnail use their existing separate AAD domains.

New encrypted recovery records use version=3 with required `thumbnail: null | {reference,ciphertext}`. Canonical Base64 ciphertext is itself the encrypted thumbnail envelope; the whole record remains K_local encrypted. Older version=1/2 schemas reject thumbnail fields, and old non-replacement tasks remain resumable without generating new thumbnails. Existing target-fingerprint safeguards remain mandatory. See ADR-046 for write-ahead, object reconciliation, accounting and membership.

This is a provisional matched frontend development format expansion, not a freeze approval. Earlier strict browser code rejects new fields/V3; reload older tabs after deployment. New uploads use the specified K_data hierarchy and legacy direct Vault Key file/thumb domains remain readable as crypto version 1. Manifest chunk/time/media fields and full requirements conformance still require the final format review.

ADR-071 corrects the previously WebP-only reader to implement the JPEG fallback explicitly required by IMPLEMENTATION section 43. Existing WebP objects and all envelope/AAD/key derivation remain unchanged; references still use the exact same field set and limits. This provisional MIME-enum expansion requires matched frontend deployment and reloading old tabs, whose strict reader rejects JPEG references. It is not a completed format freeze or an assertion of old-reader compatibility.
