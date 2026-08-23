PRAGMA foreign_keys = OFF;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  default_visibility TEXT NOT NULL DEFAULT 'private' CHECK (default_visibility IN ('private','public')),
  gateway_enabled INTEGER NOT NULL DEFAULT 0,
  quota_bytes INTEGER NOT NULL DEFAULT 10737418240,
  daily_upload_bytes INTEGER NOT NULL DEFAULT 10737418240,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','deleted')),
  deleted_at TEXT,
  purge_after TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO projects (id, name, slug, description, default_visibility, gateway_enabled, created_at, updated_at)
VALUES ('default', 'Default project', 'default', 'Migrated single-project content', 'private', 0, datetime('now'), datetime('now'));

ALTER TABLE uploads ADD COLUMN project_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE jobs ADD COLUMN project_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE audit_logs ADD COLUMN project_id TEXT;

ALTER TABLE pins RENAME TO pins_legacy;
CREATE TABLE pins (
  request_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  cid TEXT NOT NULL,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'pinned' CHECK (status IN ('queued','pinning','pinned','failed','deleting')),
  recursive INTEGER NOT NULL DEFAULT 1,
  size INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'standard',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error TEXT,
  UNIQUE (project_id, cid)
);
INSERT INTO pins (request_id, project_id, cid, name, status, recursive, size, mode, metadata_json, created_at, updated_at, error)
SELECT request_id, 'default', cid, name, status, recursive, size, mode, metadata_json, created_at, updated_at, error FROM pins_legacy;

ALTER TABLE pin_blocks RENAME TO pin_blocks_legacy;
CREATE TABLE pin_blocks (
  request_id TEXT NOT NULL REFERENCES pins(request_id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id),
  cid TEXT NOT NULL,
  PRIMARY KEY (request_id, cid)
);
INSERT INTO pin_blocks (request_id, project_id, cid)
SELECT request_id, 'default', cid FROM pin_blocks_legacy;
DROP TABLE pin_blocks_legacy;
DROP TABLE pins_legacy;

ALTER TABLE mfs_entries RENAME TO mfs_entries_legacy;
CREATE TABLE mfs_entries (
  project_id TEXT NOT NULL REFERENCES projects(id),
  path TEXT NOT NULL,
  cid TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'file' CHECK (type IN ('file','directory')),
  size INTEGER NOT NULL DEFAULT 0,
  mode INTEGER,
  mtime TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, path)
);
INSERT INTO mfs_entries (project_id, path, cid, type, size, mode, mtime, version, created_at, updated_at)
SELECT 'default', path, cid, type, size, mode, mtime, version, created_at, updated_at FROM mfs_entries_legacy;
DROP TABLE mfs_entries_legacy;

ALTER TABLE mfs_versions RENAME TO mfs_versions_legacy;
CREATE TABLE mfs_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
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
INSERT INTO mfs_versions (id, project_id, path, cid, type, size, mode, mtime, version, action, deleted, recorded_at)
SELECT id, 'default', path, cid, type, size, mode, mtime, version, action, deleted, recorded_at FROM mfs_versions_legacy;
DROP TABLE mfs_versions_legacy;

ALTER TABLE ipns_names RENAME TO ipns_names_legacy;
CREATE TABLE ipns_names (
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  cid TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0,
  ttl_seconds INTEGER NOT NULL DEFAULT 86400,
  public_key TEXT,
  record_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, name)
);
INSERT INTO ipns_names (project_id, name, cid, sequence, ttl_seconds, public_key, record_json, updated_at)
SELECT 'default', name, cid, sequence, ttl_seconds, public_key, record_json, updated_at FROM ipns_names_legacy;
DROP TABLE ipns_names_legacy;

ALTER TABLE api_tokens RENAME TO api_tokens_legacy;
CREATE TABLE project_api_keys (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  prefix TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO project_api_keys (id, project_id, prefix, name, secret_hash, scopes_json, expires_at, last_used_at, revoked_at, created_at)
SELECT id, 'default', prefix, name, secret_hash, scopes_json, expires_at, last_used_at, revoked_at, created_at FROM api_tokens_legacy;
DROP TABLE api_tokens_legacy;

ALTER TABLE quotas RENAME TO quotas_legacy;
CREATE TABLE quotas (
  project_id TEXT NOT NULL REFERENCES projects(id),
  key TEXT NOT NULL,
  bytes_used INTEGER NOT NULL DEFAULT 0,
  bytes_limit INTEGER NOT NULL DEFAULT 10737418240,
  files_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, key)
);
INSERT INTO quotas (project_id, key, bytes_used, bytes_limit, files_count, updated_at)
SELECT 'default', key, bytes_used, bytes_limit, files_count, updated_at FROM quotas_legacy;
DROP TABLE quotas_legacy;

CREATE TABLE project_publications (
  project_id TEXT NOT NULL REFERENCES projects(id),
  cid TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'inherit' CHECK (visibility IN ('inherit','private','public')),
  status TEXT NOT NULL DEFAULT 'private' CHECK (status IN ('private','queued','publishing','network_ready','degraded','failed','unpublishing')),
  last_error TEXT,
  published_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, cid)
);

CREATE TABLE project_replicas (
  project_id TEXT NOT NULL REFERENCES projects(id),
  cid TEXT NOT NULL,
  node_id TEXT NOT NULL CHECK (node_id IN ('singapore','mumbai')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','pinning','pinned','failed','unpinned')),
  peer_id TEXT,
  last_error TEXT,
  checked_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, cid, node_id)
);

CREATE TABLE navigation_preferences (
  identity TEXT PRIMARY KEY,
  visible_json TEXT NOT NULL,
  overflow_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE usage_daily (
  project_id TEXT NOT NULL REFERENCES projects(id),
  day TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  bytes_served INTEGER NOT NULL DEFAULT 0,
  uploads INTEGER NOT NULL DEFAULT 0,
  upload_bytes INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, day)
);

CREATE TABLE admin_sessions (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE gateway_preview_tokens (
  token_hash TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  cid TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_uploads_project_state ON uploads(project_id, state, expires_at);
CREATE INDEX idx_pins_project_status ON pins(project_id, status, updated_at);
CREATE INDEX idx_pin_blocks_project_cid ON pin_blocks(project_id, cid);
CREATE INDEX idx_mfs_project_path ON mfs_entries(project_id, path);
CREATE INDEX idx_mfs_versions_project_path ON mfs_versions(project_id, path, version DESC);
CREATE INDEX idx_names_project ON ipns_names(project_id, name);
CREATE INDEX idx_jobs_project ON jobs(project_id, status, updated_at);
CREATE INDEX idx_audit_project ON audit_logs(project_id, created_at DESC);
CREATE INDEX idx_publications_status ON project_publications(status, updated_at);
CREATE INDEX idx_replicas_status ON project_replicas(status, updated_at);
CREATE INDEX idx_sessions_expiry ON admin_sessions(expires_at, revoked_at);

PRAGMA foreign_keys = ON;