ALTER TABLE uploads ADD COLUMN created_by_key_id TEXT;
ALTER TABLE pins ADD COLUMN created_by_key_id TEXT;

CREATE INDEX idx_uploads_project_key ON uploads(project_id, created_by_key_id, created_at);
CREATE INDEX idx_pins_project_key ON pins(project_id, created_by_key_id, created_at);
