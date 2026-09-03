import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
const password = process.env.ORBITCID_TENANT_PASSWORD;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!password || !/^[A-Za-z0-9_-]{48,128}$/.test(password)) throw new Error("ORBITCID_TENANT_PASSWORD must be a generated base64url value");

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, allowExitOnIdle: true });
try {
  const statement = await pool.query("SELECT format('ALTER ROLE orbitcid_tenant LOGIN PASSWORD %L', $1::text) AS sql", [password]);
  await pool.query(statement.rows[0].sql);
  process.stdout.write("Restricted tenant login configured.\n");
} finally {
  await pool.end();
}
