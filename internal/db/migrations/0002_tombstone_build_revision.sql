ALTER TABLE tombstone_builds ADD COLUMN expected_global_revision INTEGER NOT NULL DEFAULT 0 CHECK (expected_global_revision >= 0);
CREATE INDEX IF NOT EXISTS tombstone_build_expiry_idx ON tombstone_builds(state, expires_at);
CREATE INDEX IF NOT EXISTS tombstone_build_member_id_idx ON tombstone_build_members(member_type, opaque_id);
