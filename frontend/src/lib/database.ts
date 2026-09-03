import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { serverEnv } from "./env";

let ownerPool: Pool | undefined;
let tenantPool: Pool | undefined;

export function getOwnerPool() {
  ownerPool ??= new Pool({ connectionString: serverEnv().databaseUrl, max: 4, idleTimeoutMillis: 20_000, allowExitOnIdle: true });
  return ownerPool;
}

function getTenantPool() {
  tenantPool ??= new Pool({ connectionString: serverEnv().tenantDatabaseUrl, max: 4, idleTimeoutMillis: 20_000, allowExitOnIdle: true });
  return tenantPool;
}

export async function withTenant<T>(userId: string, callback: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(userId)) throw new Error("Invalid tenant identity");
  const client = await getTenantPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function tenantRows<T extends QueryResultRow>(userId: string, text: string, values: unknown[] = []): Promise<T[]> {
  return withTenant(userId, async (client) => (await client.query<T>(text, values)).rows);
}
