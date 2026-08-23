CREATE TABLE IF NOT EXISTS mfs_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  cid TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('file','directory')),
  size INTEGER NOT NULL DEFAULT 0,
  mode INTEGER,
  mtime TEXT,
  version INTEGER NOT NULL,
  action TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mfs_versions_path ON mfs_versions(path, version DESC, recorded_at DESC);
