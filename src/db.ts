import type { Env } from "./types";
import { nowIso } from "./utils";

export async function first<T>(statement: D1PreparedStatement): Promise<T | null> {
  return (await statement.first<T>()) ?? null;
}

export async function all<T>(statement: D1PreparedStatement): Promise<T[]> {
  const result = await statement.all<T>();
  return result.results ?? [];
}

export async function audit(
  env: Env,
  actor: string,
  action: string,
  target: string | null,
  metadata: Record<string, unknown>,
  ip?: string,
  projectId?: string | null
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_logs (actor, action, target, metadata_json, ip, created_at, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(actor, action, target, JSON.stringify(metadata), ip ?? null, nowIso(), projectId ?? null).run();
}

export async function createJob(env: Env, type: string, payload: Record<string, unknown>, projectId = "default"): Promise<string> {
  const id = crypto.randomUUID();
  const now = nowIso();
  await env.DB.prepare(
    "INSERT INTO jobs (id, type, status, payload_json, created_at, updated_at, project_id) VALUES (?, ?, 'queued', ?, ?, ?, ?)"
  ).bind(id, type, JSON.stringify(payload), now, now, projectId).run();
  return id;
}

export async function setJobState(env: Env, id: string, status: string, error?: string): Promise<void> {
  await env.DB.prepare("UPDATE jobs SET status = ?, error = ?, attempts = attempts + CASE WHEN ? = 'running' THEN 1 ELSE 0 END, updated_at = ? WHERE id = ?")
    .bind(status, error ?? null, status, nowIso(), id).run();
}