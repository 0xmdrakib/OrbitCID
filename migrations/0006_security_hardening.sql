DROP TABLE admin_sessions;

CREATE TABLE admin_sessions (
  session_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  user_agent_hash TEXT
);

CREATE INDEX idx_admin_sessions_email_active
  ON admin_sessions(email, expires_at, revoked_at);

ALTER TABLE project_api_keys ADD COLUMN rotated_from_id TEXT;
CREATE INDEX idx_project_api_keys_rotation
  ON project_api_keys(project_id, rotated_from_id);
