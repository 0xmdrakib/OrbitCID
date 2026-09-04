ALTER TABLE backend_connections
  DROP CONSTRAINT IF EXISTS backend_connections_user_id_name_key;

ALTER TABLE backend_connections
  DROP CONSTRAINT IF EXISTS backend_connections_user_id_endpoint_key;

CREATE UNIQUE INDEX IF NOT EXISTS backend_connections_user_live_name_unique
  ON backend_connections(user_id, name)
  WHERE state <> 'revoked';

CREATE UNIQUE INDEX IF NOT EXISTS backend_connections_user_live_endpoint_unique
  ON backend_connections(user_id, endpoint)
  WHERE state <> 'revoked';
