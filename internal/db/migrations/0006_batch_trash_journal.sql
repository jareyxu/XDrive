-- Batch trash changes up to 499 parents and one trash index atomically.
-- Total precharged maintenance capacity remains bounded by migration 0005.
ALTER TABLE metadata_maintenance RENAME TO metadata_maintenance_previous;
CREATE TABLE metadata_maintenance (
 id INTEGER PRIMARY KEY CHECK(id>=1 AND id<=500),
 object_id TEXT NOT NULL UNIQUE,
 size_bytes INTEGER NOT NULL CHECK(size_bytes>=36 AND size_bytes<=4194304),
 created_at INTEGER NOT NULL
);
INSERT INTO metadata_maintenance SELECT * FROM metadata_maintenance_previous;
DROP TABLE metadata_maintenance_previous;
