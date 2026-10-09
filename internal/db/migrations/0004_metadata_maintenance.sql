-- One bounded candidate, never a live/pending object or upload quota claim.
-- The journal owns its immutable object ID until publication/cleanup completes.
CREATE TABLE metadata_maintenance (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 object_id TEXT NOT NULL UNIQUE,
 size_bytes INTEGER NOT NULL CHECK (size_bytes >= 36 AND size_bytes <= 4194304),
 created_at INTEGER NOT NULL
);
