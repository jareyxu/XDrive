-- Retain deleted identities while advancing bounded physical cleanup.
CREATE TABLE object_gc_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    cursor TEXT NOT NULL DEFAULT '',
    generation INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(generation) = 'integer' AND generation >= 0)
);
INSERT INTO object_gc_state (id) VALUES (1);
CREATE INDEX objects_deleted_gc_idx ON objects(id) WHERE state = 'deleted';
