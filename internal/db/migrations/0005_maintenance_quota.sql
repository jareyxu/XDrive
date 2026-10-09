-- Precharged operational headroom. It is included in global reservedBytes.
CREATE TABLE IF NOT EXISTS maintenance_quota (
 id INTEGER PRIMARY KEY CHECK(id=1),
 capacity_bytes INTEGER NOT NULL CHECK(capacity_bytes>=0 AND capacity_bytes<=8388608)
);
CREATE TABLE IF NOT EXISTS maintenance_quota_objects (
 object_id TEXT PRIMARY KEY REFERENCES objects(id) ON DELETE CASCADE
);
-- A logical-trash transaction needs two bounded candidates in one journal.
ALTER TABLE metadata_maintenance RENAME TO metadata_maintenance_previous;
CREATE TABLE metadata_maintenance (
 id INTEGER PRIMARY KEY CHECK(id IN (1,2)),
 object_id TEXT NOT NULL UNIQUE,
 size_bytes INTEGER NOT NULL CHECK(size_bytes>=36 AND size_bytes<=4194304),
 created_at INTEGER NOT NULL
);
INSERT INTO metadata_maintenance SELECT * FROM metadata_maintenance_previous;
DROP TABLE metadata_maintenance_previous;
