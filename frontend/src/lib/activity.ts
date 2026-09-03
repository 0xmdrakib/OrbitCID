import type { PoolClient } from "pg";

export function recordActivity(client: PoolClient, userId: string, action: string, subject: string | null, connectionId: string | null = null, metadata: Record<string, unknown> = {}) {
  return client.query(
    "INSERT INTO user_activity(id, user_id, connection_id, action, subject, metadata) VALUES ($1, $2, $3, $4, $5, $6::jsonb)",
    [crypto.randomUUID(), userId, connectionId, action, subject, JSON.stringify(metadata)]
  );
}
