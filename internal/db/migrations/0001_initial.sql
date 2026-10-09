CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    username TEXT NOT NULL UNIQUE,
    auth_salt BLOB,
    auth_hash BLOB,
    state TEXT NOT NULL CHECK (state IN ('pending_setup', 'active')),
    created_at INTEGER NOT NULL,
    CHECK (
        (state = 'pending_setup' AND auth_salt IS NULL AND auth_hash IS NULL)
        OR (state = 'active' AND length(auth_salt) = 16 AND length(auth_hash) = 32)
    )
);

CREATE TABLE IF NOT EXISTS vault_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    format_version INTEGER NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    config_json BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS server_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    vault_mutation_revision INTEGER NOT NULL DEFAULT 0 CHECK (vault_mutation_revision >= 0),
    last_backup_at INTEGER
);
INSERT OR IGNORE INTO server_state (id, vault_mutation_revision) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS setup_tokens (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    token_hash BLOB NOT NULL CHECK (length(token_hash) = 32),
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id_hash BLOB PRIMARY KEY CHECK (length(id_hash) = 32),
    csrf_token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS objects (
    id TEXT PRIMARY KEY,
    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
    sha256 BLOB NOT NULL CHECK (length(sha256) = 32),
    state TEXT NOT NULL CHECK (state IN ('pending', 'live', 'deleted')),
    upload_session_id TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS objects_state_size_idx ON objects(state, size_bytes);
CREATE INDEX IF NOT EXISTS objects_upload_session_idx ON objects(upload_session_id, state);

CREATE TABLE IF NOT EXISTS upload_sessions (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('active', 'committed', 'aborted', 'expired')),
    reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes >= 0),
    consumed_bytes INTEGER NOT NULL DEFAULT 0 CHECK (consumed_bytes >= 0),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS upload_object_claims (
    session_id TEXT NOT NULL REFERENCES upload_sessions(id),
    object_id TEXT NOT NULL,
    expected_size_bytes INTEGER NOT NULL CHECK (expected_size_bytes > 0),
    expected_sha256 BLOB NOT NULL CHECK (length(expected_sha256) = 32),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, object_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS upload_claims_object_idx ON upload_object_claims(object_id);

CREATE TABLE IF NOT EXISTS metadata_pointers (
    id TEXT PRIMARY KEY,
    object_id TEXT NOT NULL REFERENCES objects(id),
    revision INTEGER NOT NULL CHECK (revision > 0),
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS metadata_versions (
    metadata_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    object_id TEXT NOT NULL REFERENCES objects(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (metadata_id, revision)
);
CREATE INDEX IF NOT EXISTS metadata_versions_object_idx ON metadata_versions(object_id);

CREATE TABLE IF NOT EXISTS tombstone_builds (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('active', 'finalized', 'expired', 'cancelled')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tombstone_build_members (
    build_id TEXT NOT NULL REFERENCES tombstone_builds(id) ON DELETE CASCADE,
    member_type TEXT NOT NULL CHECK (member_type IN ('object', 'metadata')),
    opaque_id TEXT NOT NULL,
    PRIMARY KEY (build_id, member_type, opaque_id)
);

CREATE TABLE IF NOT EXISTS tombstones (
    id TEXT PRIMARY KEY,
    deleted_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'purging'))
);

CREATE TABLE IF NOT EXISTS tombstone_objects (
    tombstone_id TEXT NOT NULL REFERENCES tombstones(id) ON DELETE CASCADE,
    object_id TEXT NOT NULL,
    PRIMARY KEY (tombstone_id, object_id)
);
CREATE INDEX IF NOT EXISTS tombstone_objects_object_idx ON tombstone_objects(object_id);

CREATE TABLE IF NOT EXISTS tombstone_metadata (
    tombstone_id TEXT NOT NULL REFERENCES tombstones(id) ON DELETE CASCADE,
    metadata_id TEXT NOT NULL,
    PRIMARY KEY (tombstone_id, metadata_id)
);
CREATE INDEX IF NOT EXISTS tombstone_metadata_id_idx ON tombstone_metadata(metadata_id);

CREATE TABLE IF NOT EXISTS tx_log (
    idempotency_key TEXT PRIMARY KEY,
    request_sha256 BLOB NOT NULL CHECK (length(request_sha256) = 32),
    response_json BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
    attempt_key BLOB PRIMARY KEY,
    failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
    window_started_at INTEGER NOT NULL,
    blocked_until INTEGER NOT NULL DEFAULT 0
);
