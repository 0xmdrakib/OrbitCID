import type { Env } from "./types";
import { nowIso } from "./utils";
import { effectivePublication } from "./projects";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { setJobState } from "./db";
import { createReplicationTicket } from "./replication-ticket";
export { createReplicationTicket, verifyReplicationTicket } from "./replication-ticket";

interface NodeConfig {
  id: "primary" | "secondary";
  url: string;
  token: string;
}

function nodes(env: Env): NodeConfig[] {
  const candidates: Array<{ id: NodeConfig["id"]; url?: string; token?: string }> = [
    { id: "primary", url: env.KUBO_NODE_PRIMARY_URL, token: env.KUBO_NODE_PRIMARY_TOKEN },
    { id: "secondary", url: env.KUBO_NODE_SECONDARY_URL, token: env.KUBO_NODE_SECONDARY_TOKEN }
  ];
  return candidates.flatMap((node) => node.url && node.token ? [{ id: node.id, url: node.url, token: node.token }] : []);
}

async function callNode(node: NodeConfig, body: Record<string, unknown>): Promise<{ peerId?: string }> {
  const response = await fetch(new URL("/v1/pins", node.url), {
    method: "POST",
    headers: { Authorization: `Bearer ${node.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10 * 60_000)
  });
  if (!response.ok) throw new Error(`${node.id} bridge returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response.json<{ peerId?: string }>().catch(() => ({}));
}

async function updateReplica(env: Env, projectId: string, cid: string, nodeId: string, status: string, error?: string, peerId?: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO project_replicas (project_id, cid, node_id, status, peer_id, last_error, checked_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, cid, node_id) DO UPDATE SET status = excluded.status, peer_id = COALESCE(excluded.peer_id, project_replicas.peer_id), last_error = excluded.last_error, checked_at = excluded.checked_at, updated_at = excluded.updated_at`
  ).bind(projectId, cid, nodeId, status, peerId ?? null, error ?? null, nowIso(), nowIso()).run();
}

export async function replicatePublicContent(env: Env, projectId: string, cid: string): Promise<void> {
  const effective = await effectivePublication(env, projectId, cid);
  if (!effective?.public) return unpublishPublicContent(env, projectId, cid);
  const configuredNodes = nodes(env);
  if (!configuredNodes.length) throw new Error("At least one Kubo replication node must be configured");
  await env.DB.prepare("UPDATE project_publications SET status = 'publishing', last_error = NULL, updated_at = ? WHERE project_id = ? AND cid = ?")
    .bind(nowIso(), projectId, cid).run();
  const ticket = await createReplicationTicket(env, projectId, cid);
  if (!env.APP_ORIGIN) throw new Error("APP_ORIGIN is not configured");
  const carUrl = `${env.APP_ORIGIN}/internal/replication/car/${encodeURIComponent(cid)}`;
  const results = await Promise.all(configuredNodes.map(async (node) => {
    await updateReplica(env, projectId, cid, node.id, "pinning");
    try {
      const result = await callNode(node, { action: "pin", cid, carUrl, carToken: ticket });
      await updateReplica(env, projectId, cid, node.id, "pinned", undefined, result.peerId);
      return { ok: true, node: node.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Replication failed";
      await updateReplica(env, projectId, cid, node.id, "failed", message);
      return { ok: false, node: node.id, error: message };
    }
  }));
  const success = results.filter((result) => result.ok).length;
  const status = success === configuredNodes.length ? "network_ready" : success > 0 ? "degraded" : "failed";
  const error = results.filter((result) => !result.ok).map((result) => result.error).join("; ") || null;
  await env.DB.prepare("UPDATE project_publications SET status = ?, last_error = ?, published_at = CASE WHEN ? = 'network_ready' THEN COALESCE(published_at, ?) ELSE published_at END, updated_at = ? WHERE project_id = ? AND cid = ?")
    .bind(status, error, status, nowIso(), nowIso(), projectId, cid).run();
  if (success < configuredNodes.length) throw new Error(error || "Content is not replicated to every configured Kubo node");
}

export async function unpublishPublicContent(env: Env, projectId: string, cid: string): Promise<void> {
  const results = await Promise.all(nodes(env).map(async (node) => {
    try {
      await callNode(node, { action: "unpin", cid });
      await updateReplica(env, projectId, cid, node.id, "unpinned");
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unpublish failed";
      await updateReplica(env, projectId, cid, node.id, "failed", message);
      return { ok: false, error: message };
    }
  }));
  const error = results.filter((result) => !result.ok).map((result) => result.error).join("; ") || null;
  await env.DB.prepare("UPDATE project_publications SET status = ?, last_error = ?, updated_at = ? WHERE project_id = ? AND cid = ?")
    .bind(error ? "degraded" : "private", error, nowIso(), projectId, cid).run();
  if (error) throw new Error(error);
}

export class ReplicationWorkflow extends WorkflowEntrypoint<Env, { jobId: string; type: string; projectId: string; cid: string }> {
  async run(event: Readonly<WorkflowEvent<{ jobId: string; type: string; projectId: string; cid: string }>>, step: WorkflowStep): Promise<void> {
    const { jobId, type, projectId, cid } = event.payload;
    await setJobState(this.env, jobId, "running");
    try {
      await step.do("synchronize configured Kubo replicas", { retries: { limit: 5, delay: "30 seconds", backoff: "exponential" }, timeout: "15 minutes" }, async () => {
        if (type === "replicate_public") await replicatePublicContent(this.env, projectId, cid);
        else await unpublishPublicContent(this.env, projectId, cid);
      });
      await setJobState(this.env, jobId, "completed");
    } catch (error) {
      await setJobState(this.env, jobId, "failed", error instanceof Error ? error.message : "Replication workflow failed");
      throw error;
    }
  }
}
