import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";
import type { Env, Variables } from "./types";
import { all, audit, createJob, first } from "./db";
import { hashProjectKeyForStorage } from "./auth";
import { bytesToBase64, jsonError, nowIso } from "./utils";
import { contentIsPublic, requiresPublicPersistenceAcknowledgement } from "./project-policy";

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

const navigationItems = ["overview", "upload", "files", "pins", "integration", "names", "imports", "activity", "settings"] as const;
const defaultVisible = ["overview", "upload", "files", "pins", "integration"];
const defaultOverflow = ["names", "imports", "activity", "settings"];

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
  description: z.string().max(500).default(""),
  defaultVisibility: z.enum(["private", "public"]).default("private"),
  gatewayEnabled: z.boolean().default(false),
  acknowledgePublicPersistence: z.boolean().default(false),
  quotaBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  dailyUploadBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()
});

const updateProjectSchema = createProjectSchema.omit({ slug: true }).partial();
const keySchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(["read", "write", "pin", "publish", "export"])).min(1),
  expiresAt: z.string().datetime().nullable().default(null)
});
const publicationSchema = z.object({ visibility: z.enum(["inherit", "private", "public"]), acknowledgePublicPersistence: z.boolean().default(false) });
const navSchema = z.object({
  visible: z.array(z.enum(navigationItems)).min(1),
  overflow: z.array(z.enum(navigationItems))
}).refine((value) => {
  const combined = [...value.visible, ...value.overflow];
  return combined.length === navigationItems.length && new Set(combined).size === navigationItems.length;
}, "Navigation must contain every item exactly once");

export function currentProjectId(c: AppContext): string {
  return c.get("projectId") ?? c.get("auth")?.projectId ?? "default";
}

export const bindProjectById: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  const id = c.req.param("projectId") ?? "";
  const project = await first<{ id: string; slug: string; state: string }>(c.env.DB.prepare("SELECT id, slug, state FROM projects WHERE id = ?").bind(id));
  if (!project) return jsonError(c, 404, "PROJECT_NOT_FOUND", "Project does not exist");
  if (project.state !== "active" && !c.req.path.endsWith("/restore")) return jsonError(c, 410, "PROJECT_DELETED", "Project is in its recovery window");
  c.set("projectId", project.id);
  c.set("projectSlug", project.slug);
  await next();
};

export const bindProjectBySlug: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  const slug = (c.req.param("slug") ?? "").toLowerCase();
  const project = await first<{ id: string; slug: string; state: string }>(c.env.DB.prepare(
    "SELECT id, slug, state FROM projects WHERE slug = ?"
  ).bind(slug));
  if (!project || project.state !== "active") return jsonError(c, 404, "PROJECT_NOT_FOUND", "Project does not exist");
  const authProject = c.get("auth")?.projectId;
  if (authProject && authProject !== project.id) return jsonError(c, 404, "PROJECT_NOT_FOUND", "Project does not exist");
  c.set("projectId", project.id);
  c.set("projectSlug", project.slug);
  await next();
};

export async function activeProjectIdForSlug(env: Env, slug: string): Promise<string | null> {
  const row = await first<{ id: string }>(env.DB.prepare(
    "SELECT id FROM projects WHERE slug = ? AND state = 'active'"
  ).bind(slug.toLowerCase()));
  return row?.id ?? null;
}

export async function listProjects(c: AppContext): Promise<Response> {
  const includeDeleted = c.req.query("includeDeleted") === "true";
  const rows = await all<Record<string, unknown>>(c.env.DB.prepare(
    `SELECT projects.*,
      (SELECT COUNT(*) FROM pins WHERE pins.project_id = projects.id AND pins.status = 'pinned') AS file_count,
      (SELECT COALESCE(SUM(size), 0) FROM pins WHERE pins.project_id = projects.id AND pins.status = 'pinned') AS logical_bytes,
      (SELECT COUNT(*) FROM project_publications WHERE project_publications.project_id = projects.id AND status = 'network_ready') AS public_count
     FROM projects WHERE (? = 1 OR state = 'active') ORDER BY CASE WHEN id = 'default' THEN 0 ELSE 1 END, created_at DESC`
  ).bind(includeDeleted ? 1 : 0));
  return c.json({ results: rows });
}

export async function createProject(c: AppContext): Promise<Response> {
  const parsed = createProjectSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(c, 400, "INVALID_PROJECT", "Project payload is invalid", parsed.error.flatten());
  if (parsed.data.gatewayEnabled && parsed.data.defaultVisibility === "public" && !parsed.data.acknowledgePublicPersistence) {
    return jsonError(c, 409, "PUBLICATION_ACKNOWLEDGEMENT_REQUIRED", "Public IPFS content may remain available from third-party peers permanently");
  }
  const existing = await first<{ id: string }>(c.env.DB.prepare("SELECT id FROM projects WHERE slug = ?").bind(parsed.data.slug));
  if (existing) return jsonError(c, 409, "PROJECT_SLUG_EXISTS", "Project slug is already in use and slugs are immutable");
  const id = crypto.randomUUID();
  const now = nowIso();
  const quota = parsed.data.quotaBytes ?? Number(c.env.STORAGE_QUOTA_BYTES || 10 * 1024 * 1024 * 1024);
  const daily = parsed.data.dailyUploadBytes ?? Number(c.env.DAILY_UPLOAD_BYTES || quota);
  await c.env.DB.prepare(
    `INSERT INTO projects (id, name, slug, description, default_visibility, gateway_enabled, quota_bytes, daily_upload_bytes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, parsed.data.name, parsed.data.slug, parsed.data.description, parsed.data.defaultVisibility, parsed.data.gatewayEnabled ? 1 : 0, quota, daily, now, now).run();
  c.executionCtx.waitUntil(audit(c.env, c.get("auth").actor, "project.create", id, { slug: parsed.data.slug }, c.req.header("CF-Connecting-IP"), id));
  const { acknowledgePublicPersistence: _acknowledged, ...project } = parsed.data;
  return c.json({ id, ...project, quotaBytes: quota, dailyUploadBytes: daily, state: "active" }, 201);
}

export async function getProject(c: AppContext): Promise<Response> {
  const id = currentProjectId(c);
  const project = await first<Record<string, unknown>>(c.env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id));
  return project ? c.json(project) : jsonError(c, 404, "PROJECT_NOT_FOUND", "Project does not exist");
}

export async function updateProject(c: AppContext): Promise<Response> {
  const parsed = updateProjectSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(c, 400, "INVALID_PROJECT", "Project payload is invalid", parsed.error.flatten());
  const id = currentProjectId(c);
  const existing = await first<Record<string, unknown>>(c.env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id));
  if (!existing) return jsonError(c, 404, "PROJECT_NOT_FOUND", "Project does not exist");
  const next = {
    name: parsed.data.name ?? String(existing.name),
    description: parsed.data.description ?? String(existing.description ?? ""),
    visibility: parsed.data.defaultVisibility ?? String(existing.default_visibility),
    gateway: parsed.data.gatewayEnabled ?? Boolean(existing.gateway_enabled),
    quota: parsed.data.quotaBytes ?? Number(existing.quota_bytes),
    daily: parsed.data.dailyUploadBytes ?? Number(existing.daily_upload_bytes)
  };
  if (requiresPublicPersistenceAcknowledgement({
    currentGatewayEnabled: Boolean(existing.gateway_enabled),
    currentDefaultVisibility: String(existing.default_visibility) as "private" | "public",
    nextGatewayEnabled: next.gateway,
    nextDefaultVisibility: next.visibility as "private" | "public"
  }) && !parsed.data.acknowledgePublicPersistence) {
    return jsonError(c, 409, "PUBLICATION_ACKNOWLEDGEMENT_REQUIRED", "Public IPFS content may remain available from third-party peers permanently");
  }
  await c.env.DB.prepare(
    "UPDATE projects SET name = ?, description = ?, default_visibility = ?, gateway_enabled = ?, quota_bytes = ?, daily_upload_bytes = ?, updated_at = ? WHERE id = ?"
  ).bind(next.name, next.description, next.visibility, next.gateway ? 1 : 0, next.quota, next.daily, nowIso(), id).run();
  if (parsed.data.defaultVisibility !== undefined || parsed.data.gatewayEnabled !== undefined) await reconcileProjectPublications(c.env, id);
  c.executionCtx.waitUntil(audit(c.env, c.get("auth").actor, "project.update", id, parsed.data, c.req.header("CF-Connecting-IP"), id));
  return getProject(c);
}

export async function deleteProject(c: AppContext): Promise<Response> {
  const id = currentProjectId(c);
  if (id === "default") return jsonError(c, 409, "DEFAULT_PROJECT_REQUIRED", "The default project cannot be deleted");
  const now = nowIso();
  const purgeAfter = new Date(Date.now() + 30 * 86_400_000).toISOString();
  await c.env.DB.prepare("UPDATE projects SET state = 'deleted', gateway_enabled = 0, deleted_at = ?, purge_after = ?, updated_at = ? WHERE id = ?")
    .bind(now, purgeAfter, now, id).run();
  await reconcileProjectPublications(c.env, id);
  c.executionCtx.waitUntil(audit(c.env, c.get("auth").actor, "project.delete", id, { purgeAfter }, c.req.header("CF-Connecting-IP"), id));
  return c.json({ id, state: "deleted", purgeAfter }, 202);
}

export async function restoreProject(c: AppContext): Promise<Response> {
  const id = c.req.param("projectId") ?? "";
  const row = await first<{ purge_after: string | null }>(c.env.DB.prepare("SELECT purge_after FROM projects WHERE id = ? AND state = 'deleted'").bind(id));
  if (!row) return jsonError(c, 404, "PROJECT_NOT_RECOVERABLE", "Deleted project does not exist");
  if (row.purge_after && Date.parse(row.purge_after) <= Date.now()) return jsonError(c, 410, "PROJECT_RECOVERY_EXPIRED", "The project recovery period has expired");
  await c.env.DB.prepare("UPDATE projects SET state = 'active', deleted_at = NULL, purge_after = NULL, updated_at = ? WHERE id = ?").bind(nowIso(), id).run();
  c.executionCtx.waitUntil(audit(c.env, c.get("auth").actor, "project.restore", id, {}, c.req.header("CF-Connecting-IP"), id));
  return c.json({ id, state: "active" });
}

export async function projectStats(c: AppContext): Promise<Response> {
  const id = currentProjectId(c);
  const [project, pins, blocks, jobs, usage, replicas] = await Promise.all([
    first<Record<string, unknown>>(c.env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id)),
    first<{ count: number; bytes: number }>(c.env.DB.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM pins WHERE project_id = ? AND status = 'pinned'").bind(id)),
    first<{ count: number; bytes: number }>(c.env.DB.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(blocks.size), 0) AS bytes FROM blocks JOIN (SELECT DISTINCT cid FROM pin_blocks WHERE project_id = ?) owned ON owned.cid = blocks.cid").bind(id)),
    first<{ active: number; failed: number }>(c.env.DB.prepare("SELECT SUM(CASE WHEN status IN ('queued','running') THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed FROM jobs WHERE project_id = ?").bind(id)),
    first<{ requests: number; bytes: number; errors: number }>(c.env.DB.prepare("SELECT COALESCE(SUM(requests),0) AS requests, COALESCE(SUM(bytes_served),0) AS bytes, COALESCE(SUM(errors),0) AS errors FROM usage_daily WHERE project_id = ? AND day >= date('now','-30 day')").bind(id)),
    all<Record<string, unknown>>(c.env.DB.prepare("SELECT node_id, status, COUNT(*) AS count FROM project_replicas WHERE project_id = ? GROUP BY node_id, status").bind(id))
  ]);
  if (!project) return jsonError(c, 404, "PROJECT_NOT_FOUND", "Project does not exist");
  return c.json({
    project,
    storedBytes: pins?.bytes ?? 0,
    files: pins?.count ?? 0,
    uniqueBlocks: blocks?.count ?? 0,
    physicalBytes: blocks?.bytes ?? 0,
    dedupSavedBytes: Math.max(0, (pins?.bytes ?? 0) - (blocks?.bytes ?? 0)),
    activeJobs: jobs?.active ?? 0,
    failedJobs: jobs?.failed ?? 0,
    requests30d: usage?.requests ?? 0,
    bytesServed30d: usage?.bytes ?? 0,
    errors30d: usage?.errors ?? 0,
    replicas
  });
}

function randomTokenPart(length = 32): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(length))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function createProjectKey(c: AppContext): Promise<Response> {
  const parsed = keySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(c, 400, "INVALID_PROJECT_KEY", "API key payload is invalid", parsed.error.flatten());
  const pepper = c.env.PROJECT_KEY_PEPPER;
  if (!pepper) return jsonError(c, 503, "PROJECT_KEY_AUTH_NOT_CONFIGURED", "PROJECT_KEY_PEPPER must be configured");
  const id = crypto.randomUUID();
  const prefix = randomTokenPart(6);
  const token = `orbitcid_proj_${prefix}_${randomTokenPart(32)}`;
  const projectId = currentProjectId(c);
  await c.env.DB.prepare(
    "INSERT INTO project_api_keys (id, project_id, prefix, name, secret_hash, scopes_json, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, projectId, prefix, parsed.data.name, await hashProjectKeyForStorage(token, pepper), JSON.stringify(parsed.data.scopes), parsed.data.expiresAt, nowIso()).run();
  c.executionCtx.waitUntil(audit(c.env, c.get("auth").actor, "project_key.create", id, { name: parsed.data.name, scopes: parsed.data.scopes }, c.req.header("CF-Connecting-IP"), projectId));
  return c.json({ id, name: parsed.data.name, prefix, scopes: parsed.data.scopes, expiresAt: parsed.data.expiresAt, token }, 201);
}

export async function listProjectKeys(c: AppContext): Promise<Response> {
  const rows = await all<Record<string, unknown>>(c.env.DB.prepare(
    "SELECT id, prefix, name, scopes_json, expires_at, last_used_at, revoked_at, created_at FROM project_api_keys WHERE project_id = ? ORDER BY created_at DESC"
  ).bind(currentProjectId(c)));
  return c.json({ results: rows.map((row) => ({ ...row, scopes: JSON.parse(String(row.scopes_json)), scopes_json: undefined })) });
}

export async function revokeProjectKey(c: AppContext): Promise<Response> {
  const projectId = currentProjectId(c);
  const id = c.req.param("keyId") ?? c.req.param("id") ?? "";
  const result = await c.env.DB.prepare("UPDATE project_api_keys SET revoked_at = ? WHERE id = ? AND project_id = ?").bind(nowIso(), id, projectId).run();
  if (!result.meta.changes) return jsonError(c, 404, "PROJECT_KEY_NOT_FOUND", "API key does not exist in this project");
  c.executionCtx.waitUntil(audit(c.env, c.get("auth").actor, "project_key.revoke", id, {}, c.req.header("CF-Connecting-IP"), projectId));
  return new Response(null, { status: 204 });
}

export async function getNavigationPreferences(c: AppContext): Promise<Response> {
  const identity = c.get("auth").actor.toLowerCase();
  const row = await first<{ visible_json: string; overflow_json: string; version: number }>(c.env.DB.prepare(
    "SELECT visible_json, overflow_json, version FROM navigation_preferences WHERE identity = ?"
  ).bind(identity));
  return c.json(row ? { visible: JSON.parse(row.visible_json), overflow: JSON.parse(row.overflow_json), version: row.version } : { visible: defaultVisible, overflow: defaultOverflow, version: 0 });
}

export async function saveNavigationPreferences(c: AppContext): Promise<Response> {
  const parsed = navSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(c, 400, "INVALID_NAVIGATION", "Navigation preferences are invalid", parsed.error.flatten());
  const identity = c.get("auth").actor.toLowerCase();
  await c.env.DB.prepare(
    `INSERT INTO navigation_preferences (identity, visible_json, overflow_json, version, updated_at) VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(identity) DO UPDATE SET visible_json = excluded.visible_json, overflow_json = excluded.overflow_json, version = navigation_preferences.version + 1, updated_at = excluded.updated_at`
  ).bind(identity, JSON.stringify(parsed.data.visible), JSON.stringify(parsed.data.overflow), nowIso()).run();
  return getNavigationPreferences(c);
}

export async function effectivePublication(env: Env, projectId: string, cid: string): Promise<{ public: boolean; projectSlug: string; gatewayEnabled: boolean } | null> {
  const row = await first<{ slug: string; state: string; gateway_enabled: number; default_visibility: string; visibility: string | null }>(env.DB.prepare(
    `SELECT projects.slug, projects.state, projects.gateway_enabled, projects.default_visibility, project_publications.visibility
     FROM projects LEFT JOIN project_publications ON project_publications.project_id = projects.id AND project_publications.cid = ?
     WHERE projects.id = ?`
  ).bind(cid, projectId));
  if (!row) return null;
  return {
    public: contentIsPublic({ projectState: row.state, gatewayEnabled: row.gateway_enabled === 1, defaultVisibility: row.default_visibility as "private" | "public", override: row.visibility as "inherit" | "private" | "public" | null }),
    projectSlug: row.slug,
    gatewayEnabled: row.gateway_enabled === 1
  };
}

export async function projectCanAccessCid(env: Env, projectId: string, cid: string): Promise<boolean> {
  const row = await first<{ allowed: number }>(env.DB.prepare(
    `SELECT 1 AS allowed FROM project_blocks WHERE project_id = ? AND cid = ?
     UNION ALL
     SELECT 1 AS allowed FROM pins WHERE project_id = ? AND status = 'pinned' AND cid = ?
     UNION ALL
     SELECT 1 AS allowed FROM pin_blocks WHERE project_id = ? AND cid = ?
     LIMIT 1`
  ).bind(projectId, cid, projectId, cid, projectId, cid));
  return row?.allowed === 1;
}

export async function projectHasPinnedCid(env: Env, projectId: string, cid: string): Promise<boolean> {
  const row = await first<{ allowed: number }>(env.DB.prepare(
    `SELECT 1 AS allowed FROM pins WHERE project_id = ? AND status = 'pinned' AND cid = ?
     UNION ALL
     SELECT 1 AS allowed FROM pin_blocks JOIN pins ON pins.request_id = pin_blocks.request_id
       WHERE pin_blocks.project_id = ? AND pin_blocks.cid = ? AND pins.status = 'pinned'
     LIMIT 1`
  ).bind(projectId, cid, projectId, cid));
  return row?.allowed === 1;
}

export async function publicProjectForCid(env: Env, cid: string, projectId?: string): Promise<string | null> {
  const row = await first<{ project_id: string }>(env.DB.prepare(
    `SELECT pins.project_id FROM pins
     JOIN projects ON projects.id = pins.project_id
     LEFT JOIN pin_blocks ON pin_blocks.request_id = pins.request_id AND pin_blocks.cid = ?
     LEFT JOIN project_publications ON project_publications.project_id = pins.project_id AND project_publications.cid = pins.cid
     WHERE pins.status = 'pinned' AND (pins.cid = ? OR pin_blocks.cid IS NOT NULL)
       AND (? IS NULL OR pins.project_id = ?)
       AND projects.state = 'active' AND projects.gateway_enabled = 1
       AND CASE WHEN project_publications.visibility IS NOT NULL AND project_publications.visibility != 'inherit'
         THEN project_publications.visibility ELSE projects.default_visibility END = 'public'
     LIMIT 1`
  ).bind(cid, cid, projectId ?? null, projectId ?? null));
  return row?.project_id ?? null;
}

export async function queuePublication(env: Env, projectId: string, cid: string): Promise<void> {
  const effective = await effectivePublication(env, projectId, cid);
  if (!effective) return;
  if (!effective.public) {
    const previous = await first<{ status: string }>(env.DB.prepare("SELECT status FROM project_publications WHERE project_id = ? AND cid = ?").bind(projectId, cid));
    const replicas = await first<{ count: number }>(env.DB.prepare("SELECT COUNT(*) AS count FROM project_replicas WHERE project_id = ? AND cid = ? AND status IN ('pinning','pinned','failed')").bind(projectId, cid));
    if (!previous || (["private", "queued"].includes(previous.status) && !(replicas?.count ?? 0))) {
      await env.DB.prepare(
        `INSERT INTO project_publications (project_id, cid, visibility, status, updated_at) VALUES (?, ?, 'inherit', 'private', ?)
         ON CONFLICT(project_id, cid) DO UPDATE SET status = 'private', last_error = NULL, updated_at = excluded.updated_at`
      ).bind(projectId, cid, nowIso()).run();
      return;
    }
  }
  const type = effective.public ? "replicate_public" : "unpublish_public";
  const status = effective.public ? "queued" : "unpublishing";
  await env.DB.prepare(
    `INSERT INTO project_publications (project_id, cid, visibility, status, updated_at) VALUES (?, ?, 'inherit', ?, ?)
     ON CONFLICT(project_id, cid) DO UPDATE SET status = excluded.status, last_error = NULL, updated_at = excluded.updated_at`
  ).bind(projectId, cid, status, nowIso()).run();
  const jobId = await createJob(env, type, { projectId, cid }, projectId);
  if (env.REPLICATION_WORKFLOW) {
    await env.REPLICATION_WORKFLOW.create({ id: jobId, params: { jobId, type, projectId, cid } });
  } else {
    await env.JOBS.send({ id: jobId, type, payload: { projectId, cid } });
  }
}

async function reconcileProjectPublications(env: Env, projectId: string): Promise<void> {
  const pins = await all<{ cid: string }>(env.DB.prepare("SELECT cid FROM pins WHERE project_id = ? AND status = 'pinned'").bind(projectId));
  for (const pin of pins) await queuePublication(env, projectId, pin.cid);
}

export async function setPublication(c: AppContext): Promise<Response> {
  const parsed = publicationSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(c, 400, "INVALID_PUBLICATION", "Publication setting is invalid", parsed.error.flatten());
  const projectId = currentProjectId(c);
  const cid = c.req.param("cid") ?? "";
  const pin = await first<{ mode: string }>(c.env.DB.prepare("SELECT mode FROM pins WHERE project_id = ? AND cid = ? AND status = 'pinned'").bind(projectId, cid));
  if (!pin) return jsonError(c, 404, "PIN_NOT_FOUND", "Verified project content was not found");
  if (parsed.data.visibility === "public" && !parsed.data.acknowledgePublicPersistence) {
    return jsonError(c, 409, "PUBLICATION_ACKNOWLEDGEMENT_REQUIRED", "Public IPFS content may remain available from third-party peers permanently");
  }
  await c.env.DB.prepare(
    `INSERT INTO project_publications (project_id, cid, visibility, status, updated_at) VALUES (?, ?, ?, 'private', ?)
     ON CONFLICT(project_id, cid) DO UPDATE SET visibility = excluded.visibility, updated_at = excluded.updated_at`
  ).bind(projectId, cid, parsed.data.visibility, nowIso()).run();
  await queuePublication(c.env, projectId, cid);
  const effective = await effectivePublication(c.env, projectId, cid);
  const publication = await first<{ status: string }>(c.env.DB.prepare("SELECT status FROM project_publications WHERE project_id = ? AND cid = ?").bind(projectId, cid));
  c.executionCtx.waitUntil(audit(c.env, c.get("auth").actor, "publication.update", cid, { visibility: parsed.data.visibility, effectivePublic: effective?.public }, c.req.header("CF-Connecting-IP"), projectId));
  return c.json({ cid, visibility: parsed.data.visibility, effectivePublic: effective?.public ?? false, status: publication?.status ?? "private", sealed: pin.mode === "sealed" });
}

export async function createPreviewToken(c: AppContext): Promise<Response> {
  const projectId = currentProjectId(c);
  const cid = c.req.param("cid") ?? "";
  const pin = await first<{ cid: string }>(c.env.DB.prepare("SELECT cid FROM pins WHERE project_id = ? AND cid = ? AND status = 'pinned'").bind(projectId, cid));
  if (!pin || !c.env.SESSION_SECRET) return jsonError(c, 404, "PIN_NOT_FOUND", "Verified project content was not found");
  const token = randomTokenPart(36);
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  await c.env.DB.prepare("INSERT INTO gateway_preview_tokens (token_hash, project_id, cid, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(await hashProjectKeyForStorage(token, c.env.SESSION_SECRET), projectId, cid, expiresAt, nowIso()).run();
  return c.json({ token, expiresAt, url: `https://${c.env.GATEWAY_HOST}/_preview/${token}/ipfs/${cid}` }, 201);
}

export async function consumePreviewToken(env: Env, token: string, cid: string): Promise<string | null> {
  if (!env.SESSION_SECRET) return null;
  const hash = await hashProjectKeyForStorage(token, env.SESSION_SECRET);
  const row = await first<{ project_id: string; expires_at: string; used_at: string | null }>(env.DB.prepare(
    "SELECT project_id, expires_at, used_at FROM gateway_preview_tokens WHERE token_hash = ? AND cid = ?"
  ).bind(hash, cid));
  if (!row || row.used_at || Date.parse(row.expires_at) <= Date.now()) return null;
  await env.DB.prepare("UPDATE gateway_preview_tokens SET used_at = ? WHERE token_hash = ?").bind(nowIso(), hash).run();
  return row.project_id;
}

export async function recordProjectUsage(env: Env, projectId: string, bytes: number, error = false): Promise<void> {
  env.ANALYTICS?.writeDataPoint({
    blobs: [projectId, error ? "error" : "success"],
    doubles: [Math.max(0, bytes), 1],
    indexes: [projectId]
  });
  await env.DB.prepare(
    `INSERT INTO usage_daily (project_id, day, requests, bytes_served, errors) VALUES (?, date('now'), 1, ?, ?)
     ON CONFLICT(project_id, day) DO UPDATE SET requests = requests + 1, bytes_served = bytes_served + excluded.bytes_served, errors = errors + excluded.errors`
  ).bind(projectId, Math.max(0, bytes), error ? 1 : 0).run();
}

export async function queueUnpublication(env: Env, projectId: string, cid: string): Promise<void> {
  const previous = await first<{ status: string }>(env.DB.prepare("SELECT status FROM project_publications WHERE project_id = ? AND cid = ?").bind(projectId, cid));
  const replicas = await first<{ count: number }>(env.DB.prepare("SELECT COUNT(*) AS count FROM project_replicas WHERE project_id = ? AND cid = ? AND status != 'unpinned'").bind(projectId, cid));
  if (!(replicas?.count ?? 0) && (!previous || previous.status === "private")) {
    await env.DB.prepare(
      `INSERT INTO project_publications (project_id, cid, visibility, status, updated_at) VALUES (?, ?, 'private', 'private', ?)
       ON CONFLICT(project_id, cid) DO UPDATE SET visibility = 'private', status = 'private', last_error = NULL, updated_at = excluded.updated_at`
    ).bind(projectId, cid, nowIso()).run();
    return;
  }
  await env.DB.prepare(
    `INSERT INTO project_publications (project_id, cid, visibility, status, updated_at) VALUES (?, ?, 'private', 'unpublishing', ?)
     ON CONFLICT(project_id, cid) DO UPDATE SET visibility = 'private', status = 'unpublishing', last_error = NULL, updated_at = excluded.updated_at`
  ).bind(projectId, cid, nowIso()).run();
  const jobId = await createJob(env, "unpublish_public", { projectId, cid }, projectId);
  if (env.REPLICATION_WORKFLOW) await env.REPLICATION_WORKFLOW.create({ id: jobId, params: { jobId, type: "unpublish_public", projectId, cid } });
  else await env.JOBS.send({ id: jobId, type: "unpublish_public", payload: { projectId, cid } });
}

export async function rotateProjectKey(c: AppContext): Promise<Response> {
  const projectId = currentProjectId(c);
  const oldId = c.req.param("keyId") ?? "";
  const existing = await first<{ name: string; scopes_json: string; expires_at: string | null; revoked_at: string | null }>(c.env.DB.prepare(
    "SELECT name, scopes_json, expires_at, revoked_at FROM project_api_keys WHERE id = ? AND project_id = ?"
  ).bind(oldId, projectId));
  if (!existing || existing.revoked_at) return jsonError(c, 404, "PROJECT_KEY_NOT_FOUND", "Active API key does not exist in this project");
  if (!c.env.PROJECT_KEY_PEPPER) return jsonError(c, 503, "PROJECT_KEY_AUTH_NOT_CONFIGURED", "PROJECT_KEY_PEPPER must be configured");
  const id = crypto.randomUUID();
  const prefix = randomTokenPart(6);
  const token = `orbitcid_proj_${prefix}_${randomTokenPart(32)}`;
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO project_api_keys (id, project_id, prefix, name, secret_hash, scopes_json, expires_at, created_at, rotated_from_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, projectId, prefix, existing.name, await hashProjectKeyForStorage(token, c.env.PROJECT_KEY_PEPPER), existing.scopes_json, existing.expires_at, now, oldId),
    c.env.DB.prepare("UPDATE project_api_keys SET revoked_at = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL").bind(now, oldId, projectId)
  ]);
  c.executionCtx.waitUntil(audit(c.env, c.get("auth").actor, "project_key.rotate", oldId, { replacementId: id }, c.req.header("CF-Connecting-IP"), projectId));
  return c.json({ id, name: existing.name, prefix, scopes: JSON.parse(existing.scopes_json), expiresAt: existing.expires_at, token }, 201);
}
