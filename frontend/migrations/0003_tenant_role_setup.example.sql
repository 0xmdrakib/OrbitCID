-- Run once as the Neon database owner, replace the placeholder with a unique
-- generated password, and store the resulting pooled URL only in Vercel's
-- TENANT_DATABASE_URL secret. Never commit the real password or URL.
ALTER ROLE orbitcid_tenant LOGIN PASSWORD 'REPLACE_WITH_A_GENERATED_PASSWORD';
