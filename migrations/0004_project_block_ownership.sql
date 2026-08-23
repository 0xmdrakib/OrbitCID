PRAGMA foreign_keys = ON;

CREATE TABLE project_blocks (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cid TEXT NOT NULL REFERENCES blocks(cid) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'pin' CHECK (source IN ('pin','car','upload','import','kubo')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, cid)
);

INSERT OR IGNORE INTO project_blocks (project_id, cid, source, created_at)
SELECT project_id, cid, 'pin', datetime('now') FROM pin_blocks;

CREATE INDEX idx_project_blocks_cid ON project_blocks(cid);

CREATE TABLE project_objects (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  root_cid TEXT NOT NULL,
  object_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'standard' CHECK (mode IN ('standard','sealed')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, root_cid)
);

INSERT OR IGNORE INTO project_objects (project_id, root_cid, object_key, size, mime, name, mode, metadata_json, created_at)
SELECT pins.project_id, objects.root_cid, objects.object_key, objects.size, objects.mime, pins.name, pins.mode, pins.metadata_json, objects.created_at
FROM pins JOIN objects ON objects.root_cid = pins.cid;
