-- The migration owner needs this membership to run the production RLS
-- acceptance check with SET LOCAL ROLE. Application requests still use the
-- separate restricted TENANT_DATABASE_URL login.
GRANT orbitcid_tenant TO CURRENT_USER;
