import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const { Pool } = pg;
const pool = new Pool({ connectionString: databaseUrl, max: 1, allowExitOnIdle: true });
const client = await pool.connect();
const suffix = crypto.randomUUID();
const first = `isolation-a-${suffix}`;
const second = `isolation-b-${suffix}`;
try {
  await client.query("BEGIN");
  await client.query(`INSERT INTO "user"(id, name, email, email_verified, updated_at) VALUES ($1, 'A', $2, true, now()), ($3, 'B', $4, true, now())`, [first, `${first}@example.invalid`, second, `${second}@example.invalid`]);
  await client.query("INSERT INTO user_profiles(user_id, display_name) VALUES ($1, 'A'), ($2, 'B')", [first, second]);
  await client.query("SET LOCAL ROLE orbitcid_tenant");
  await client.query("SELECT set_config('app.user_id', $1, true)", [first]);
  const visible = await client.query("SELECT user_id FROM user_profiles ORDER BY user_id");
  if (visible.rowCount !== 1 || visible.rows[0].user_id !== first) throw new Error("Tenant RLS exposed another user's row");
  await client.query("SAVEPOINT cross_tenant_write");
  let rejected = false;
  try { await client.query("INSERT INTO user_activity(id, user_id, action) VALUES ($1, $2, 'cross-tenant-test')", [crypto.randomUUID(), second]); }
  catch (error) { rejected = error?.code === "42501"; await client.query("ROLLBACK TO SAVEPOINT cross_tenant_write"); }
  if (!rejected) throw new Error("Tenant RLS accepted a cross-user write");
  await client.query("ROLLBACK");
  process.stdout.write("Tenant RLS isolation check passed.\n");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
