PRAGMA foreign_keys = OFF;

ALTER TABLE project_replicas RENAME TO project_replicas_legacy;

CREATE TABLE project_replicas (
  project_id TEXT NOT NULL REFERENCES projects(id),
  cid TEXT NOT NULL,
  node_id TEXT NOT NULL CHECK (node_id IN ('primary','secondary')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','pinning','pinned','failed','unpinned')),
  peer_id TEXT,
  last_error TEXT,
  checked_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, cid, node_id)
);

INSERT INTO project_replicas (project_id, cid, node_id, status, peer_id, last_error, checked_at, updated_at)
SELECT project_id, cid,
  CASE node_id WHEN 'mumbai' THEN 'primary' WHEN 'singapore' THEN 'secondary' ELSE node_id END,
  status, peer_id, last_error, checked_at, updated_at
FROM project_replicas_legacy;

DROP TABLE project_replicas_legacy;
CREATE INDEX idx_replicas_status ON project_replicas(status, updated_at);

PRAGMA foreign_keys = ON;
