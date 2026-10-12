-- The optional desktop wallpaper is a plain, non-quota system asset. It is
-- included in SQLite snapshots so normal backup and restore carry it along.
CREATE TABLE system_assets (
    asset_id TEXT PRIMARY KEY CHECK (asset_id = 'desktop_wallpaper'),
    content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/avif')),
    content BLOB NOT NULL CHECK (length(content) BETWEEN 1 AND 10485760),
    updated_at INTEGER NOT NULL CHECK (updated_at > 0)
);
