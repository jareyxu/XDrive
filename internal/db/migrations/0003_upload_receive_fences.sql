CREATE TABLE upload_receive_fences (
 object_id TEXT PRIMARY KEY,
 session_id TEXT NOT NULL REFERENCES upload_sessions(id),
 expected_size_bytes INTEGER NOT NULL CHECK (expected_size_bytes > 0),
 expected_sha256 BLOB NOT NULL CHECK (length(expected_sha256) = 32),
 created_at INTEGER NOT NULL
);
CREATE INDEX upload_receive_fences_session_idx ON upload_receive_fences(session_id);
INSERT INTO upload_receive_fences SELECT object_id, session_id, expected_size_bytes, expected_sha256, created_at FROM upload_object_claims;
