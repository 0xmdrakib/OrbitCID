import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [root = ".", manifestKey, sqlOutput] = process.argv.slice(2);
if (!manifestKey || !process.env.RECOVERY_KEY) {
  console.error("Usage: RECOVERY_KEY=... npm run recovery:verify -- <download-root> <snapshots/.../manifest.json.enc>");
  process.exit(2);
}

function decode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(Buffer.from(normalized, "base64"));
}

const keyBytes = decode(process.env.RECOVERY_KEY);
if (keyBytes.length !== 32) throw new Error("RECOVERY_KEY must decode to 32 bytes");
const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);

async function decrypt(path) {
  const envelope = JSON.parse(await readFile(resolve(root, path), "utf8"));
  if (envelope.version !== 2 || envelope.algorithm !== "AES-256-GCM" || typeof envelope.aad !== "string") throw new Error(`Unsupported recovery envelope: ${path}`);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(envelope.iv), additionalData: new TextEncoder().encode(envelope.aad) }, key, decode(envelope.ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext));
}

const manifest = await decrypt(manifestKey);
if (manifest.version !== 2 || !Array.isArray(manifest.tables)) throw new Error("Recovery manifest is invalid");
let total = 0;
const restored = [];
for (const table of manifest.tables) {
  let rows = 0;
  for (const pagePath of table.pages) {
    const page = await decrypt(pagePath);
    if (page.table !== table.name || !Array.isArray(page.rows)) throw new Error(`Recovery page mismatch: ${pagePath}`);
    rows += page.rows.length;
    restored.push({ table: table.name, rows: page.rows });
  }
  if (rows !== table.rows) throw new Error(`Row count mismatch for ${table.name}: expected ${table.rows}, found ${rows}`);
  total += rows;
  console.log(`${table.name}: ${rows} rows verified`);
}
console.log(`Recovery snapshot verified: ${total} encrypted metadata rows`);

if (sqlOutput) {
  const identifier = (value) => {
    if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
    return `"${value}"`;
  };
  const literal = (value) => {
    if (value === null || value === undefined) return "NULL";
    if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("Non-finite number in recovery data"); return String(value); }
    if (typeof value === "boolean") return value ? "1" : "0";
    return `'${String(value).replaceAll("'", "''")}'`;
  };
  const statements = ["PRAGMA foreign_keys = OFF;", "BEGIN TRANSACTION;"];
  for (const page of restored) {
    for (const row of page.rows) {
      const columns = Object.keys(row);
      if (!columns.length) continue;
      statements.push(`INSERT OR REPLACE INTO ${identifier(page.table)} (${columns.map(identifier).join(", ")}) VALUES (${columns.map((column) => literal(row[column])).join(", ")});`);
    }
  }
  statements.push("COMMIT;", "PRAGMA foreign_keys = ON;", "");
  await writeFile(sqlOutput, statements.join("\n"), { encoding: "utf8", mode: 0o600 });
  console.log(`Verified restore SQL written to ${sqlOutput}. Treat it as sensitive and use only with a freshly migrated empty D1 database.`);
}
