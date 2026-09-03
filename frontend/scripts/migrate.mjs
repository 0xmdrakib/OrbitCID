import pg from "pg";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const directory = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const files = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name) && !name.endsWith(".example.sql")).sort();
const { Pool } = pg;
const pool = new Pool({ connectionString: databaseUrl, max: 1, allowExitOnIdle: true });
const client = await pool.connect();
try {
  await client.query("CREATE TABLE IF NOT EXISTS orbitcid_frontend_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  for (const name of files) {
    const exists = await client.query("SELECT 1 FROM orbitcid_frontend_migrations WHERE name = $1", [name]);
    if (exists.rowCount) continue;
    await client.query("BEGIN");
    try {
      await client.query(await readFile(join(directory, name), "utf8"));
      await client.query("INSERT INTO orbitcid_frontend_migrations(name) VALUES ($1)", [name]);
      await client.query("COMMIT");
      process.stdout.write(`Applied ${name}\n`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  client.release();
  await pool.end();
}
