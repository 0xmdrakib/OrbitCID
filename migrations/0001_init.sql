PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL,
  multipart_id TEXT,
  name TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL,
  chunk_size INTEGER NOT NULL DEFAULT 1048576,
  part_size INTEGER NOT NULL,
  part_count INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'standard' CHECK (mode IN ('standard', 'sealed')),
  state TEXT NOT NULL DEFAULT 'created' CHECK (state IN ('created','uploading','verifying','pinned','failed','expired','deleting')),
  root_cid TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  completed_parts_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  error TEXT
);

CREATE TABLE IF NOT EXISTS upload_chunks (
  upload_id TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  cid TEXT NOT NULL,
  offset INTEGER NOT NULL,
  length INTEGER NOT NULL,
  part_number INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  PRIMARY KEY (upload_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS upload_parts (
  upload_id TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL,
  etag TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (upload_id, part_number)
);

CREATE TABLE IF NOT EXISTS blocks (
  cid TEXT PRIMARY KEY,
  codec TEXT NOT NULL,
  size INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  ref_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS block_locations (
  cid TEXT NOT NULL REFERENCES blocks(cid) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  offset INTEGER NOT NULL,
  length INTEGER NOT NULL,
  PRIMARY KEY (cid, object_key)
);

CREATE TABLE IF NOT EXISTS objects (
  root_cid TEXT PRIMARY KEY,
  object_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'standard' CHECK (mode IN ('standard', 'sealed')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pins (
  request_id TEXT PRIMARY KEY,
  cid TEXT NOT NULL UNIQUE,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'pinned' CHECK (status IN ('queued','pinning','pinned','failed','deleting')),
  recursive INTEGER NOT NULL DEFAULT 1,
  size INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'standard',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error TEXT
);

CREATE TABLE IF NOT EXISTS pin_blocks (
  request_id TEXT NOT NULL REFERENCES pins(request_id) ON DELETE CASCADE,
  cid TEXT NOT NULL,
  PRIMARY KEY (request_id, cid)
);

CREATE TABLE IF NOT EXISTS mfs_entries (
  path TEXT PRIMARY KEY,
  cid TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'file' CHECK (type IN ('file','directory')),
  size INTEGER NOT NULL DEFAULT 0,
  mode INTEGER,
  mtime TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ipns_names (
  name TEXT PRIMARY KEY,
  cid TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0,
  ttl_seconds INTEGER NOT NULL DEFAULT 86400,
  public_key TEXT,
  record_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  prefix TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  ip TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quotas (
  key TEXT PRIMARY KEY,
  bytes_used INTEGER NOT NULL DEFAULT 0,
  bytes_limit INTEGER NOT NULL DEFAULT 10737418240,
  files_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_uploads_state ON uploads(state, expires_at);
CREATE INDEX IF NOT EXISTS idx_upload_chunks_cid ON upload_chunks(cid);
CREATE INDEX IF NOT EXISTS idx_upload_parts_upload ON upload_parts(upload_id, part_number);
CREATE INDEX IF NOT EXISTS idx_blocks_ref_count ON blocks(ref_count);
CREATE INDEX IF NOT EXISTS idx_pins_status ON pins(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mfs_parent ON mfs_entries(path);