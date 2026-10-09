# Implemented API surface

All routes use `/api/v1`. JSON responses use `Cache-Control: no-store`; errors have a stable `error` code and request ID. Mutating routes require a same-origin `Origin` and, after authentication, the session CSRF token. The table records the current implemented subset only.

| Method and path | Purpose |
|---|---|
| `GET /healthz` | Process health |
| `GET /readyz` | SQLite readiness |
| `GET /api/v1/system/info` | Authenticated binary/format version and nonsecret preview/trash policies; no-store |
| `GET /api/v1/status` | Setup state without account secrets |
| `POST /api/v1/setup` | Consume the one-time setup token and store the wrapped Vault Key plus encrypted initial indexes |
| `POST /api/v1/auth/prelogin` | Return stored or stable fake KDF parameters |
| `POST /api/v1/auth/login` | Verify the browser-derived auth key and issue a session |
| `POST /api/v1/auth/unlock` | Recheck the auth key for an existing session |
| `POST /api/v1/auth/change-password` | Verify current auth material, CAS the new wrapped Vault Key slot and verifier, and revoke other sessions |
| `POST /api/v1/auth/logout` | Revoke the current session |
| `GET /api/v1/auth/session` | Read session and encrypted vault configuration |
| `GET /api/v1/vault/config` | Read encrypted key-slot configuration |
| `GET /api/v1/vault/state` | Read the global mutation revision |
| `GET /api/v1/storage/usage` | Read one logical quota snapshot: used, pending subset, outstanding reserved, unique active trash, available; physical freeDiskBytes and lastBackupAt Unix milliseconds |
| `POST /api/v1/backups/download` | Create a short-lived, session-bound download ticket; requires same Origin, CSRF and the exact client protocol |
| `GET /api/v1/backups/download` | Stream a complete restore-compatible tar backup using the one-time HttpOnly ticket cookie |
| `GET /api/v1/trash/tombstones` | Read active opaque tombstone IDs and deletion times so unlock can ignore expired encrypted trash-index entries |
| `GET /api/v1/metadata/{id}` | Read an authenticated live metadata pointer |
| `GET /api/v1/objects/{id}` | Read an authenticated live opaque object; supports HTTP range serving |
| `POST /api/v1/uploads` | Create an upload session with a persisted configured deadline (default 24 hours) |
| `GET /api/v1/uploads/{id}` | Read active/terminal session state and pending opaque object IDs, sizes, and ciphertext SHA-256 digests for resume reconciliation |
| `POST /api/v1/uploads/{id}/reserve` | Reserve complete encrypted bytes against logical and filesystem capacity |
| `PUT /api/v1/uploads/{id}/objects/{objectId}` | Claim, stream, digest-check, fsync, and persist one encrypted object |
| `DELETE /api/v1/uploads/{id}/objects/{objectId}` | Remove one pending object owned by this active upload, releasing its consumed quota before re-encryption with a fresh ID and nonce |
| `POST /api/v1/uploads/{id}/abandon` | Abandon an active upload and remove pending files |
| `POST /api/v1/metadata/transactions` | Atomically activate selected pending objects and CAS metadata pointers |
| `POST /api/v1/metadata/maintenance-purge` | Bounded full-capacity permanent purge with one encrypted index |
| `POST /api/v1/metadata/maintenance-trash` | Use precharged metadata headroom for atomic logical deletion with 2–500 encrypted indexes |

Upload creation and reservation accept JSON. PUT requires canonical decimal `X-XDrive-Object-Size` and lowercase hexadecimal `X-XDrive-Ciphertext-SHA256`; a known HTTP `Content-Length` must match the declared size before the body is read. Unknown transport length remains allowed under the application-level size bound. Metadata transactions require a 16–128 character URL-safe `Idempotency-Key`; identical request bytes replay the original success, while a changed request under the same key conflicts.

Receive exclusivity is separate from active quota claims (ADR-028 / schema 3). Abandon and expiry release claims but keep a receiving object fence until handler cleanup, so another session cannot consume a second body for the same ID. Matching inflight duplicates return 409 `object_receive_in_progress`; completed matching pending objects return 204. Metadata commit also returns this 409 while the upload has any receiving fence. PUT rechecks real filesystem safety after acquiring its claim and uses a ten-minute read deadline on supported net/http connections. Receive fences contain only opaque IDs, encrypted sizes and hashes, and are not included in logical storage usage.

Each metadata pointer's encrypted object is limited to 4 MiB, including envelope overhead. A transaction referencing a larger object returns 413 `metadata_object_too_large`; all pointer updates and object activation are rolled back. This limit is distinct from the configured general object PUT limit (default 16 MiB). Oversized declared PUT headers return `400 invalid_object_headers` before body reads or quota claims.

Password change accepts `currentAuthKey`, `newAuthKey`, `newVaultConfig`, and `expectedConfigRevision`. The browser first reauthenticates with the current password, unwraps the existing Vault Key locally, wraps the same bytes under a new Argon2id salt and KEK, and verifies the new slot locally before submission. The server updates the authentication verifier and vault configuration in one transaction, with config revision CAS, and keeps only the initiating session. It never receives the password, KEK, or unwrapped Vault Key.

`GET /uploads/{id}` returns `uploadId`, state, reservation and consumed bytes, expiry time, and bounded arrays of pending objects and active claims. Each object item contains only its opaque ID, encrypted byte length and ciphertext SHA-256. A browser resumes only after unlocking its encrypted IndexedDB record and asking the user to reselect the original file. It compares that record with the server triples; a missing or mismatched object gets a new ID and fresh encryption nonce. A committed session can be recognized after a lost transaction response. Startup recovery removes orphaned claims, unpublished final paths and interrupted temporary files before accepting retries.

Trash creation uses `POST /api/v1/tombstone-builds`, one or more bounded `POST /api/v1/tombstone-builds/{id}/members` batches, and a metadata transaction that finalizes the build while updating the parent and encrypted trash indexes. `DELETE /api/v1/tombstone-builds/{id}` cancels an unfinished build. Restore and permanent purge are atomic metadata transactions using `restoreTombstoneId`, atomic `restoreTombstoneIds` (1–5000 unique roots), singular `purgeTombstoneId`, or atomic `purgeTombstoneIds` (1–5000 unique roots). Lifecycle action forms are mutually exclusive; new batch requests never fall back to multiple old single-item commits. There is no general-purpose object deletion route. Expired trash is purged using the configured retention period (default 30 days). A restore-compatible backup can be downloaded from Settings; verification and restore remain local CLI operations. There is no scheduled or persistent server-side backup API. Installation and administration are local CLI/script operations; no other management API is defined in V1.

The Settings screen can prepare a browser download of one point-in-time backup. The POST issues a two-minute, one-use ticket in a Secure, HttpOnly, SameSite=Strict cookie bound to the current session; the subsequent GET does not put a ticket in the URL. The tar archive extracts to the existing backup directory format and can be passed to `xdrive verify-backup` and `xdrive restore`. It contains a SQLite snapshot and the encrypted object set referenced by that snapshot. Object deletion is held behind the existing cross-process backup lease while the archive streams; each object and the snapshot are hashed during transfer. The service keeps only a temporary SQLite snapshot, not a second full copy of all object data, and removes abandoned snapshot staging directories after acquiring its service lease at startup. `lastBackupAt` advances only after the archive stream finishes successfully. If the connection is interrupted or an object fails verification, the downloaded tar is incomplete and must be discarded. The archive itself is not password-encrypted; store it as sensitive data. The browser download endpoint is not an automatic scheduler or persistent on-server backup destination.

Global snapshot conflicts from build creation and metadata commit return HTTP 409 with `error: "vault_mutation_conflict"`; local pointer conflicts use `metadata_revision_conflict`. For deletion the browser discards each rejected attempt's upload/build, refreshes global state and indexes, and traverses again. It attempts at most four times, then exposes `concurrent_mutation_retry_exhausted` locally. Transport-ambiguous commits retain the same idempotency key and are never treated as a definite revision rejection.

## Storage usage snapshot

The authenticated response includes quotaBytes, usedBytes, pendingBytes, trashBytes, reservedBytes, uploadReservedBytes, maintenanceReservedBytes, maintenanceCapacityBytes, availableBytes, freeDiskBytes and lastBackupAt. reservedBytes is uploadReservedBytes + maintenanceReservedBytes. Pending is a subset of used. Outstanding upload reservations include inflight claims; neither is added again to the quota formula. The fixed maintenance capacity minus its live/pending origin charges is reserved before ordinary upload admission. Those origin objects already belong to used; the full capacity must not be charged again. availableBytes = max(0, quotaBytes-usedBytes-reservedBytes). Active tombstone membership counts unique live objects only. Logical fields come from one SQLite statement snapshot; physical disk space is a separate current statfs observation, not additional quota. Disk probe failure returns disk_usage_unavailable. lastBackupAt is Unix milliseconds or null, although the internal database stores Unix seconds. See ADR-036 and the storage usage tests.

## Bounded full-quota purge maintenance (ADR-038, schema 4)

`POST /api/v1/metadata/maintenance-purge` requires authenticated cookie, same Origin, CSRF and `Idempotency-Key`. The body has only `expectedGlobalRevision`, `purgeTombstoneIds` (1–5000 unique opaque IDs), `updates` (exactly one existing metadata pointer with positive expected revision), and `encryptedObject` (canonical padded Base64 of a supported 36-byte–4 MiB envelope). Body limit is 6 MiB. It does not accept upload IDs, arbitrary object activation, creation, restore or build finalization.

The candidate is bounded temporary transaction storage, invisible to object reads and not a pending/live quota object. The purge uses one journal slot; schema 5 supports two bounded slots shared with maintenance-trash, and any residual slot blocks new maintenance until startup recovery. Regular receive fences and journal candidates mutually exclude object IDs. It consumes physical disk budget, including safety margin and outstanding receiving/upload commitments. The final SQL transaction atomically purges all confirmed active roots and admits the candidate only when remaining used + outstanding upload reservations + remaining maintenance reservation + candidate size ≤ configured quota. Retained metadata history remains charged. A 507, CAS/root conflict or publication error preserves the prior roots/index; physical unlink of purge members remains janitor work protected by the backup lock.

Response is the existing metadata transaction response (one activated object/one updated pointer). Same body/key replays saved success without revisiting roots or increasing revision. Hashes have a separate maintenance domain; cross-protocol/same-key different content is `409 idempotency_conflict`. `409 maintenance_in_progress` does not imply automatic retry or permission to clear another candidate. Crashed publication is reconciled before serving requests; schema 6 extends the journal to bounded multi-index trash batches (ADR-047). Restoration clears all journal entries after migrating supported schema 2–6 snapshots to the current schema. Envelope and AAD are unchanged.

The browser switches only after explicit ordinary purge-reservation `507 quota_exceeded`, closes the still-empty session, and preserves the same generated encrypted candidate. This path cannot bypass file-upload reservation. Insufficient purge credit still returns 507. ADR-041 below supplies precharged quota for the empty-trash/full-ordinary-capacity logical-delete case; full S4 acceptance remains pending.

## Precharged logical-trash maintenance (ADR-041, schema 5)

`POST /api/v1/metadata/maintenance-trash` has the same cookie, Origin, CSRF and idempotency requirements. Its strict body contains `expectedGlobalRevision`, either singular `finalizeTombstoneBuildId`/`createTombstoneId` or plural `finalizeTombstoneBuilds` (1–5000 unique build/tombstone pairs), `updates` (2–500 distinct existing metadata pointers with positive expected revisions and distinct fresh object IDs), and `encryptedObjects` (canonical padded Base64 envelopes matching updates by position, each 36 bytes–4 MiB and at most 8 MiB in aggregate). The body limit is 12 MiB. It accepts no upload session, arbitrary activation, creation or other lifecycle action. Updated pointers cannot already belong to an active tombstone or to this staged subtree.

After successful ordinary-reservation `507 quota_exceeded`, the client abandons its empty session before sending this request. It reuses the encrypted candidates and staged build; it never uploads normal file chunks here. The server holds the shared maintenance gate before reading the body, checks quota and physical budget, journals the bounded immutable candidates, publishes them without holding a SQL write lock, then rechecks revisions/build/remaining credit in the final transaction. All selected indexes, history, source-charge flags, tombstone membership and idempotent response commit together. Old files/history remain live. New used bytes consume the same maintenance reservation, so total charged quota does not increase.

Insufficient maintenance credit returns `507 maintenance_reserve_exhausted`; physical and revision failures preserve prior state. Unknown commit outcome replays the exact body/key under the independent maintenance-trash hash domain. Cancellation cannot recall an already committed transaction. Restart recovers all journal entries before serving requests; backup protects publication cleanup with the deletion lease. Restore validates fixed maintenance capacity and total quota in private staging before activating an empty target. See ADR-041 and its execution evidence for local tests and remaining platform gates.


## Runtime policy and lifecycle configuration (ADR-052 through ADR-062)

`GET /api/v1/system/info` requires a valid session and returns `version` (string), `commit` (string), `encryptedFormatVersion` (integer), `textPreviewLimit` (integer bytes), `trashRetentionSeconds` (positive integer seconds), `videoBlobFallbackLimit` (integer bytes), and `zipMemoryFallbackLimit` (integer bytes). Responses are no-store. These fields contain no file names, plaintext indexes or keys. The preview client validates policy before requesting text/Markdown/code objects; invalid or unavailable policy stops preview. Trash displays the actual returned retention or an explicit read error.

TOML settings and their environment overrides:

| TOML | Environment | Default | Activation |
|---|---|---|---|
| text_preview_limit | XDRIVE_TEXT_PREVIEW_LIMIT | 20971520 bytes | Restart, subsequent previews |
| object_put_max_bytes | XDRIVE_OBJECT_PUT_MAX_BYTES | 16777216 bytes | Restart, subsequent PUT header checks |
| upload_expiry | XDRIVE_UPLOAD_EXPIRY | 24h | New upload sessions only |
| trash_retention | XDRIVE_TRASH_RETENTION | 720h | Restart, existing and new trash |
| session_idle_timeout | XDRIVE_SESSION_IDLE_TIMEOUT | 12h | Restart, cap existing deadlines and renew valid requests |
| setup_token_ttl | XDRIVE_SETUP_TOKEN_TTL | 24h | New init/setup-token generation only |
| metadata_keep_versions | XDRIVE_METADATA_KEEP_VERSIONS | 5 | Restart, startup and periodic history cleanup |
| min_free_disk_bytes | XDRIVE_MIN_FREE_DISK_BYTES | 3221225472 bytes | Restart, reservation/receive/maintenance disk checks |
| video_blob_fallback_limit | XDRIVE_VIDEO_BLOB_FALLBACK_LIMIT | 268435456 bytes | Restart, subsequent non-streaming video previews |
| zip_memory_fallback_limit | XDRIVE_ZIP_MEMORY_FALLBACK_LIMIT | 536870912 bytes | Restart, subsequent ZIP memory fallback |
| backup_warn_after_days | XDRIVE_BACKUP_WARN_AFTER_DAYS | 30 days | Restart, subsequent storage-usage reads |

Environment overrides the TOML file. Duration values must be positive whole-second Go durations. Existing upload/setup-token deadlines are persisted and not rewritten when configuration changes. Setup token rotation replaces the prior hash atomically; completed setup prevents generation and replay. A shortened session policy caps existing deadlines before startup expiry cleanup; extending it cannot revive a past deadline. Authentication checks and sliding renewal occur in one conditional SQL update, preserving monotonic last activity under out-of-order requests. Local browser locking is independent.

The minimum-free-disk byte count accepts zero through signed int64 maximum. Legacy `disk_safety_bytes` / `XDRIVE_DISK_SAFETY_BYTES` remain aliases, with either environment spelling overriding either file spelling. Supplying both file spellings or both nonempty environment spellings is an error, including equal values; an explicit file zero is not treated as absent. No new public API field is introduced. An insufficient physical budget rejects uploads without reading the PUT body or leaking claims, independently of logical quota.

`system/info.videoBlobFallbackLimit` is the resolved integer byte limit (1–536870912). The video viewer reads and validates it only when Range setup fails; invalid/missing policy prevents complete-decryption fallback. Files exactly at the limit are allowed. Streaming Range remains independent of the Blob limit; the limit does not certify native media-decoder peak memory.

`system/info.zipMemoryFallbackLimit` is the resolved integer byte limit (1–536870912). Memory ZIP checks both the conservative structural estimate and actual retained output. Directory-index traversal may precede policy retrieval; invalid/missing policy prevents file manifest/chunk reads and archive allocation. Streaming outputs do not retrieve or depend on this policy. The budget includes archive-wide ZIP64 end records and per-entry structures, but does not certify total browser/library RSS.

`storage/usage.backupWarnAfterDays` is the resolved integer warning threshold (1–3650 days), alongside persisted `lastBackupAt` (milliseconds or null). The frontend validates the threshold and uses the shorter of it and the existing browser preference. Never-backed-up warns immediately; otherwise age must strictly exceed the effective threshold. Missing/invalid policy fails the usage read explicitly. This field configures reminders, not scheduling or backup retention.

History retention counts the current version within N. Cleanup prunes at most 1000 rows per pass; pointer/shared-pointer, trash and active deletion-build references can retain additional history until released. Only pruned index-object candidates can be marked deleted, after rechecking references; this is not a sweep of unreferenced file data. Logical expiry/deletion remains atomic and physical unlink remains protected by the cross-process backup lease. Lower retention/count policies can retire previously retained data, so operators should preserve an external backup before reducing them. Detailed bounds and test limitations are in the corresponding ADRs.
