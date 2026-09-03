CREATE TABLE IF NOT EXISTS user_profiles (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  display_name text,
  avatar_url text,
  onboarding_state text NOT NULL DEFAULT 'new' CHECK (onboarding_state IN ('new', 'pairing', 'ready')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS backend_connections (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  endpoint text NOT NULL CHECK (char_length(endpoint) <= 2048),
  public_key jsonb NOT NULL,
  key_fingerprint text NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled', 'revoked')),
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, name),
  UNIQUE(user_id, endpoint)
);
CREATE INDEX IF NOT EXISTS backend_connections_user_idx ON backend_connections(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pairing_claims (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE CHECK (char_length(code_hash) = 64),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pairing_claims_user_idx ON pairing_claims(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pairing_claims_expiry_idx ON pairing_claims(expires_at) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS user_activity (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  connection_id text REFERENCES backend_connections(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 80),
  subject text CHECK (char_length(subject) <= 300),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_activity_user_idx ON user_activity(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  active_connection_id text REFERENCES backend_connections(id) ON DELETE SET NULL,
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orbitcid_tenant') THEN
    CREATE ROLE orbitcid_tenant NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orbitcid_service') THEN
    CREATE ROLE orbitcid_service NOLOGIN;
  END IF;
END $$;

GRANT orbitcid_service TO CURRENT_USER;

GRANT USAGE ON SCHEMA public TO orbitcid_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_profiles, backend_connections, pairing_claims, user_activity, user_preferences TO orbitcid_tenant;

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE backend_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE backend_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE pairing_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE pairing_claims FORCE ROW LEVEL SECURITY;
ALTER TABLE user_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_activity FORCE ROW LEVEL SECURITY;
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preferences FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_profiles_tenant_isolation ON user_profiles;
CREATE POLICY user_profiles_tenant_isolation ON user_profiles USING (user_id = current_setting('app.user_id', true)) WITH CHECK (user_id = current_setting('app.user_id', true));
DROP POLICY IF EXISTS user_profiles_service_access ON user_profiles;
CREATE POLICY user_profiles_service_access ON user_profiles TO orbitcid_service USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS backend_connections_tenant_isolation ON backend_connections;
CREATE POLICY backend_connections_tenant_isolation ON backend_connections USING (user_id = current_setting('app.user_id', true)) WITH CHECK (user_id = current_setting('app.user_id', true));
DROP POLICY IF EXISTS backend_connections_service_access ON backend_connections;
CREATE POLICY backend_connections_service_access ON backend_connections TO orbitcid_service USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS pairing_claims_tenant_isolation ON pairing_claims;
CREATE POLICY pairing_claims_tenant_isolation ON pairing_claims USING (user_id = current_setting('app.user_id', true)) WITH CHECK (user_id = current_setting('app.user_id', true));
DROP POLICY IF EXISTS pairing_claims_service_access ON pairing_claims;
CREATE POLICY pairing_claims_service_access ON pairing_claims TO orbitcid_service USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS user_activity_tenant_isolation ON user_activity;
CREATE POLICY user_activity_tenant_isolation ON user_activity USING (user_id = current_setting('app.user_id', true)) WITH CHECK (user_id = current_setting('app.user_id', true));
DROP POLICY IF EXISTS user_activity_service_access ON user_activity;
CREATE POLICY user_activity_service_access ON user_activity TO orbitcid_service USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS user_preferences_tenant_isolation ON user_preferences;
CREATE POLICY user_preferences_tenant_isolation ON user_preferences USING (user_id = current_setting('app.user_id', true)) WITH CHECK (user_id = current_setting('app.user_id', true));
DROP POLICY IF EXISTS user_preferences_service_access ON user_preferences;
CREATE POLICY user_preferences_service_access ON user_preferences TO orbitcid_service USING (true) WITH CHECK (true);
