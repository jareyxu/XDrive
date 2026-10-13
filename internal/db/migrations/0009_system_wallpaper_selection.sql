-- The selected built-in wallpaper is shared by all browsers and the public
-- login screen. The image files themselves are immutable public web assets.
CREATE TABLE system_wallpaper_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    selection TEXT NOT NULL CHECK (selection IN ('default', '02', '03', '04', '05', '06', '07', '08', 'custom')),
    updated_at INTEGER NOT NULL CHECK (updated_at > 0)
);

INSERT INTO system_wallpaper_state (id, selection, updated_at)
SELECT 1,
       CASE WHEN EXISTS (SELECT 1 FROM system_assets WHERE asset_id = 'desktop_wallpaper') THEN 'custom' ELSE 'default' END,
       CAST(strftime('%s', 'now') AS INTEGER);
