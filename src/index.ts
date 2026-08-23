import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { Env, JobMessage, Variables } from "./types";
import { accessIdentity, authMiddleware, csrfMiddleware, loginWithPassword, logoutAdmin, requireScope } from "./auth";
import { createUpload, uploadPart, uploadDag, completeUpload, getUploadStatus } from "./uploads";
import {
  blockStat,
  createPin,
  createToken,
  dagGet,
  deletePin,
  exportCar,
  exportNameRecord,
  getBlockResponse,
  getPin,
  importCar,
  importPublicCid,
  kuboAdd,
  kuboPinList,
  listAudit,
  listNames,
  listPins,
  listTokens,
  mfsDelete,
  mfsHistory,
  mfsList,
  mfsMutate,
  publishName,
  resolveName,
  revokeToken,
  systemHealth,
  unsupportedKubo
} from "./api";
import { gatewayResponse } from "./gateway";
import { createJob, first } from "./db";
import { getJob, handleJob } from "./jobs";
import { jsonError, normalizePath, nowIso } from "./utils";
import { getBlock, parseCid } from "./ipfs";
import {
  activeProjectIdForSlug,
  bindProjectById,
  bindProjectBySlug,
  consumePreviewToken,
  createPreviewToken,
  createProject,
  createProjectKey,
  currentProjectId,
  deleteProject,
  effectivePublication,
  getNavigationPreferences,
  getProject,
  listProjectKeys,
  listProjects,
  projectStats,
  projectCanAccessCid,
  queuePublication,
  restoreProject,
  revokeProjectKey,
  rotateProjectKey,
  saveNavigationPreferences,
  setPublication,
  updateProject
} from "./projects";
import { verifyReplicationTicket } from "./replication";
import { enforceRateLimit, mutationRateLimit } from "./rate-limit";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function isPublicGateway(c: { req: { url: string }; env: Env }): boolean {
  return new URL(c.req.url).hostname.toLowerCase() === c.env.GATEWAY_HOST.toLowerCase();
}

async function servePublicProjectGateway(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  slug: string,
  cid: string,
  path: string
): Promise<Response> {
  if (!isPublicGateway(c)) return jsonError(c, 404, "NOT_FOUND", "Route does not exist");
  const blocked = await enforceRateLimit(c, `gateway:${slug}`, Number(c.env.PUBLIC_GATEWAY_RATE_PER_MINUTE ?? 600), 60);
  if (blocked) return blocked;
  const projectId = await activeProjectIdForSlug(c.env, slug);
  if (!projectId) return jsonError(c, 404, "IPFS_NOT_FOUND", "Content is not publicly available");
  return gatewayResponse(c, cid, path, { projectId, publicOnly: true });
}

async function servePublicProjectName(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  slug: string,
  name: string,
  path: string
): Promise<Response> {
  if (!isPublicGateway(c)) return jsonError(c, 404, "NOT_FOUND", "Route does not exist");
  const blocked = await enforceRateLimit(c, `gateway:${slug}`, Number(c.env.PUBLIC_GATEWAY_RATE_PER_MINUTE ?? 600), 60);
  if (blocked) return blocked;
  const projectId = await activeProjectIdForSlug(c.env, slug);
  if (!projectId) return jsonError(c, 404, "IPNS_NOT_FOUND", "Stable link is not publicly available");
  const row = await first<{ cid: string }>(c.env.DB.prepare("SELECT cid FROM ipns_names WHERE project_id = ? AND name = ?").bind(projectId, name));
  if (!row) return jsonError(c, 404, "IPNS_NOT_FOUND", "Stable link is not publicly available");
  return gatewayResponse(c, row.cid, path, { projectId, publicOnly: true });
}

app.use("*", async (c, next) => {
  const origin = c.env.APP_ORIGIN ?? new URL(c.req.url).origin;
  if (isPublicGateway(c)) {
    return cors({
      origin: "*",
      allowHeaders: ["Content-Type", "Range", "If-None-Match"],
      allowMethods: ["GET", "HEAD", "OPTIONS"],
      exposeHeaders: ["ETag", "Content-Range", "Content-Length", "Accept-Ranges"],
      maxAge: 86_400,
      credentials: false
    })(c, next);
  }
  return cors({
    origin,
    allowHeaders: ["Authorization", "Content-Type", "X-Chunk-Cids", "CF-Access-Jwt-Assertion"],
    allowMethods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"],
    exposeHeaders: ["ETag", "Content-Range", "X-Request-Id"],
    maxAge: 86_400,
    credentials: true
  })(c, next);
});

app.use("*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === "/healthz" || path === "/openapi.json" || path === "/api/v1/session/login" || path === "/api/v1/session/access" || path.startsWith("/internal/replication/car/")) return next();
  if (isPublicGateway(c)) return next();
  const protectedPath = path.startsWith("/api/") || path.startsWith("/ipfs/") || path.startsWith("/ipns/");
  if (!protectedPath) return next();
  return authMiddleware(c, next);
});

app.use("/api/*", csrfMiddleware);
app.use("/api/*", mutationRateLimit());

app.get("/healthz", (c) => c.json({ status: "ok", service: "orbitcid", time: nowIso() }));

app.get("/openapi.json", (c) => c.json({
  openapi: "3.1.0",
  info: { title: "OrbitCID API", version: "0.1.0" },
  servers: [{ url: c.env.APP_ORIGIN ?? new URL(c.req.url).origin }],
  paths: {
    "/api/v1/projects": { get: { summary: "List isolated projects" }, post: { summary: "Create a project" } },
    "/api/v1/projects/{projectId}/keys": { get: { summary: "List project API keys" }, post: { summary: "Create a named project API key" } },
    "/api/v1/uploads": { post: { summary: "Create a resumable upload" } },
    "/api/v1/uploads/{id}/parts/{part}": { post: { summary: "Upload and verify a multipart part" } },
    "/api/v1/uploads/{id}/dag": { post: { summary: "Upload verified DAG blocks" } },
    "/api/v1/uploads/{id}/complete": { post: { summary: "Complete and pin an upload" } },
    "/api/v1/pins": { get: { summary: "List pins" }, post: { summary: "Create pin" } },
    "/{projectSlug}/ipfs/{cid}/{path}": { get: { summary: "Project public gateway" }, head: { summary: "Project public IPFS metadata" } },
    "/ipfs/{cid}/{path}": { get: { summary: "Authenticated or public-alias IPFS gateway" }, head: { summary: "IPFS metadata" } }
  }
}));

app.post("/api/v1/session/login", csrfMiddleware, loginWithPassword);
app.get("/api/v1/session/access", async (c) => {
  const identity = await accessIdentity(c);
  return c.json({ verified: !!identity, identity: identity ?? null }, identity ? 200 : 401);
});
app.post("/api/v1/session/logout", csrfMiddleware, logoutAdmin);
app.get("/api/v1/session/me", (c) => c.json({ authenticated: true, actor: c.get("auth").actor, method: c.get("auth").method }));
app.get("/api/v1/config", requireScope("read"), (c) => c.json({ gatewayHost: c.env.GATEWAY_HOST, appOrigin: c.env.APP_ORIGIN ?? new URL(c.req.url).origin }));

app.get("/api/v1/navigation", requireScope("read"), getNavigationPreferences);
app.put("/api/v1/navigation", requireScope("manage"), saveNavigationPreferences);

app.get("/api/v1/projects", requireScope("read"), listProjects);
app.post("/api/v1/projects", requireScope("manage"), createProject);
app.get("/api/v1/projects/:projectId", requireScope("read"), bindProjectById, getProject);
app.patch("/api/v1/projects/:projectId", requireScope("manage"), bindProjectById, updateProject);
app.delete("/api/v1/projects/:projectId", requireScope("manage"), bindProjectById, deleteProject);
app.post("/api/v1/projects/:projectId/restore", requireScope("manage"), restoreProject);
app.get("/api/v1/projects/:projectId/usage", requireScope("read"), bindProjectById, projectStats);
app.get("/api/v1/projects/:projectId/keys", requireScope("manage"), bindProjectById, listProjectKeys);
app.post("/api/v1/projects/:projectId/keys", requireScope("manage"), bindProjectById, createProjectKey);
app.post("/api/v1/projects/:projectId/keys/:keyId/rotate", requireScope("manage"), bindProjectById, rotateProjectKey);
app.delete("/api/v1/projects/:projectId/keys/:keyId", requireScope("manage"), bindProjectById, revokeProjectKey);
app.put("/api/v1/projects/:projectId/publications/:cid", requireScope("manage"), bindProjectById, setPublication);
app.post("/api/v1/projects/:projectId/preview/:cid", requireScope("read"), bindProjectById, createPreviewToken);

app.post("/api/v1/projects/:projectId/uploads", requireScope("write"), bindProjectById, createUpload);
app.get("/api/v1/projects/:projectId/uploads/:id", requireScope("read"), bindProjectById, getUploadStatus);
app.post("/api/v1/projects/:projectId/uploads/:id/parts/:part", requireScope("write"), bindProjectById, uploadPart);
app.post("/api/v1/projects/:projectId/uploads/:id/dag", requireScope("write"), bindProjectById, uploadDag);
app.post("/api/v1/projects/:projectId/uploads/:id/complete", requireScope("write"), bindProjectById, completeUpload);
app.get("/api/v1/projects/:projectId/pins", requireScope("read"), bindProjectById, listPins);
app.post("/api/v1/projects/:projectId/pins", requireScope("pin"), bindProjectById, createPin);
app.get("/api/v1/projects/:projectId/pins/:id", requireScope("read"), bindProjectById, getPin);
app.delete("/api/v1/projects/:projectId/pins/:id", requireScope("pin"), bindProjectById, deletePin);
app.get("/api/v1/projects/:projectId/files", requireScope("read"), bindProjectById, mfsList);
app.get("/api/v1/projects/:projectId/files/history", requireScope("read"), bindProjectById, mfsHistory);
app.post("/api/v1/projects/:projectId/files", requireScope("write"), bindProjectById, mfsMutate);
app.delete("/api/v1/projects/:projectId/files", requireScope("write"), bindProjectById, mfsDelete);
app.get("/api/v1/projects/:projectId/stable-links", requireScope("read"), bindProjectById, listNames);
app.post("/api/v1/projects/:projectId/stable-links", requireScope("write"), bindProjectById, publishName);
app.get("/api/v1/projects/:projectId/stable-links/:name/record", requireScope("export"), bindProjectById, exportNameRecord);
app.post("/api/v1/projects/:projectId/imports/cid", requireScope("write"), bindProjectById, importPublicCid);
app.post("/api/v1/projects/:projectId/imports/car", requireScope("write"), bindProjectById, importCar);
app.get("/api/v1/projects/:projectId/audit", requireScope("manage"), bindProjectById, listAudit);
app.get("/api/v1/projects/:projectId/jobs", requireScope("read"), bindProjectById, async (c) => {
  const result = await c.env.DB.prepare("SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 100").bind(currentProjectId(c)).all<Record<string, unknown>>();
  return c.json({ results: result.results ?? [] });
});

app.use("/api/v1/p/:slug/*", bindProjectBySlug);
app.post("/api/v1/p/:slug/uploads", requireScope("write"), createUpload);
app.get("/api/v1/p/:slug/uploads/:id", requireScope("read"), getUploadStatus);
app.post("/api/v1/p/:slug/uploads/:id/parts/:part", requireScope("write"), uploadPart);
app.post("/api/v1/p/:slug/uploads/:id/dag", requireScope("write"), uploadDag);
app.post("/api/v1/p/:slug/uploads/:id/complete", requireScope("write"), completeUpload);
app.get("/api/v1/p/:slug/pins", requireScope("read"), listPins);
app.post("/api/v1/p/:slug/pins", requireScope("pin"), createPin);
app.delete("/api/v1/p/:slug/pins/:id", requireScope("pin"), deletePin);
app.get("/api/v1/p/:slug/files", requireScope("read"), mfsList);
app.post("/api/v1/p/:slug/files", requireScope("write"), mfsMutate);
app.delete("/api/v1/p/:slug/files", requireScope("write"), mfsDelete);
app.get("/api/v1/p/:slug/stable-links", requireScope("read"), listNames);
app.post("/api/v1/p/:slug/stable-links", requireScope("write"), publishName);
app.post("/api/v1/p/:slug/imports/cid", requireScope("write"), importPublicCid);
app.get("/api/v1/p/:slug/car/:cid", requireScope("export"), exportCar);
app.put("/api/v1/p/:slug/publications/:cid", requireScope("publish"), setPublication);

app.post("/api/v1/uploads", requireScope("write"), createUpload);
app.get("/api/v1/uploads/:id", requireScope("read"), getUploadStatus);
app.post("/api/v1/uploads/:id/parts/:part", requireScope("write"), uploadPart);
app.post("/api/v1/uploads/:id/dag", requireScope("write"), uploadDag);
app.post("/api/v1/uploads/:id/complete", requireScope("write"), completeUpload);

app.get("/api/v1/jobs/:id", requireScope("read"), async (c) => {
  const job = await first<Record<string, unknown>>(c.env.DB.prepare("SELECT * FROM jobs WHERE id = ? AND project_id = ?").bind(c.req.param("id") ?? "", currentProjectId(c)));
  return job ? c.json(job) : jsonError(c, 404, "JOB_NOT_FOUND", "Job does not exist");
});
app.get("/api/v1/jobs", requireScope("read"), async (c) => {
  const result = await c.env.DB.prepare("SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 100").bind(currentProjectId(c)).all<Record<string, unknown>>();
  return c.json({ results: result.results ?? [] });
});
app.get("/api/v1/health", requireScope("read"), systemHealth);
app.get("/api/v1/stats", requireScope("read"), async (c) => {
  const projectId = currentProjectId(c);
  const [objects, pins, blocks, jobs, uploads] = await Promise.all([
    c.env.DB.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM project_objects WHERE project_id = ?").bind(projectId).first<{ count: number; bytes: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) AS count FROM pins WHERE project_id = ? AND status = 'pinned'").bind(projectId).first<{ count: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) AS count FROM project_blocks WHERE project_id = ?").bind(projectId).first<{ count: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) AS count, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed FROM jobs WHERE project_id = ? AND status IN ('queued','running','failed')").bind(projectId).first<{ count: number; failed: number | null }>(),
    c.env.DB.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM uploads WHERE project_id = ? AND created_at >= ?").bind(projectId, new Date(Date.now() - 86_400_000).toISOString()).first<{ count: number; bytes: number }>()
  ]);
  return c.json({
    storedBytes: objects?.bytes ?? 0,
    objects: objects?.count ?? 0,
    pins: pins?.count ?? 0,
    blocks: blocks?.count ?? 0,
    activeJobs: Math.max(0, (jobs?.count ?? 0) - (jobs?.failed ?? 0)),
    failedJobs: jobs?.failed ?? 0,
    uploads24h: uploads?.count ?? 0,
    uploadedBytes24h: uploads?.bytes ?? 0,
    storageQuotaBytes: Number(c.env.STORAGE_QUOTA_BYTES || 10 * 1024 * 1024 * 1024)
  });
});

app.get("/api/v1/pins", requireScope("read"), listPins);
app.post("/api/v1/pins", requireScope("pin"), createPin);
app.get("/api/v1/pins/:id", requireScope("read"), getPin);
app.delete("/api/v1/pins/:id", requireScope("pin"), deletePin);

app.get("/api/v1/files", requireScope("read"), mfsList);
app.get("/api/v1/files/history", requireScope("read"), mfsHistory);
app.post("/api/v1/files", requireScope("write"), mfsMutate);
app.delete("/api/v1/files", requireScope("write"), mfsDelete);

app.get("/api/v1/names", requireScope("read"), listNames);
app.post("/api/v1/names", requireScope("write"), publishName);
app.get("/api/v1/names/:name/record", requireScope("export"), exportNameRecord);

app.get("/api/v1/tokens", requireScope("manage"), listTokens);
app.post("/api/v1/tokens", requireScope("manage"), createToken);
app.delete("/api/v1/tokens/:id", requireScope("manage"), revokeToken);
app.get("/api/v1/audit", requireScope("manage"), listAudit);

app.post("/api/v1/import/cid", requireScope("write"), importPublicCid);
app.post("/api/v1/car/import", requireScope("write"), importCar);
app.get("/api/v1/car/export/:cid", requireScope("export"), exportCar);
app.get("/api/v1/blocks/:cid", requireScope("read"), getBlockResponse);
app.get("/api/v1/blocks/:cid/stat", requireScope("read"), blockStat);
app.get("/api/v1/dag/:cid", requireScope("read"), dagGet);

app.get("/internal/replication/car/:cid", async (c) => {
  const cid = c.req.param("cid") ?? "";
  const authorization = c.req.header("Authorization") ?? "";
  const ticket = authorization.startsWith("OrbitCID-Replication ") ? authorization.slice("OrbitCID-Replication ".length) : "";
  const verified = await verifyReplicationTicket(c.env, ticket, cid);
  if (!verified) return jsonError(c, 401, "INVALID_REPLICATION_TICKET", "Replication authorization is invalid or expired");
  const publication = await effectivePublication(c.env, verified.projectId, cid);
  if (!publication?.public) return jsonError(c, 404, "IPFS_NOT_FOUND", "Content is not available for public replication");
  c.set("projectId", verified.projectId);
  return exportCar(c);
});

app.on(["GET", "HEAD"], "/_preview/:token/ipfs/:cid", async (c) => {
  if (!isPublicGateway(c)) return jsonError(c, 404, "NOT_FOUND", "Route does not exist");
  const projectId = await consumePreviewToken(c.env, c.req.param("token") ?? "", c.req.param("cid") ?? "");
  if (!projectId) return jsonError(c, 404, "PREVIEW_NOT_FOUND", "Preview link is invalid, expired, or already used");
  return gatewayResponse(c, c.req.param("cid") ?? "", "", { projectId });
});
app.on(["GET", "HEAD"], "/_preview/:token/ipfs/:cid/*", async (c) => {
  if (!isPublicGateway(c)) return jsonError(c, 404, "NOT_FOUND", "Route does not exist");
  const projectId = await consumePreviewToken(c.env, c.req.param("token") ?? "", c.req.param("cid") ?? "");
  if (!projectId) return jsonError(c, 404, "PREVIEW_NOT_FOUND", "Preview link is invalid, expired, or already used");
  return gatewayResponse(c, c.req.param("cid") ?? "", c.req.param("*") ?? "", { projectId });
});

app.on(["GET", "HEAD"], "/:slug/ipfs/:cid", (c) => servePublicProjectGateway(c, c.req.param("slug") ?? "", c.req.param("cid") ?? "", ""));
app.on(["GET", "HEAD"], "/:slug/ipfs/:cid/*", (c) => servePublicProjectGateway(c, c.req.param("slug") ?? "", c.req.param("cid") ?? "", c.req.param("*") ?? ""));
app.on(["GET", "HEAD"], "/:slug/ipns/:name", (c) => servePublicProjectName(c, c.req.param("slug") ?? "", c.req.param("name") ?? "", ""));
app.on(["GET", "HEAD"], "/:slug/ipns/:name/*", (c) => servePublicProjectName(c, c.req.param("slug") ?? "", c.req.param("name") ?? "", c.req.param("*") ?? ""));

app.on(["GET", "HEAD"], "/ipfs/:cid", async (c) => {
  if (isPublicGateway(c)) {
    const blocked = await enforceRateLimit(c, "gateway:alias", Number(c.env.PUBLIC_GATEWAY_RATE_PER_MINUTE ?? 600), 60);
    if (blocked) return blocked;
    return gatewayResponse(c, c.req.param("cid") ?? "", "", { publicOnly: true });
  }
  return gatewayResponse(c, c.req.param("cid") ?? "", "");
});
app.on(["GET", "HEAD"], "/ipfs/:cid/*", async (c) => {
  if (isPublicGateway(c)) {
    const blocked = await enforceRateLimit(c, "gateway:alias", Number(c.env.PUBLIC_GATEWAY_RATE_PER_MINUTE ?? 600), 60);
    if (blocked) return blocked;
    return gatewayResponse(c, c.req.param("cid") ?? "", c.req.param("*") ?? "", { publicOnly: true });
  }
  return gatewayResponse(c, c.req.param("cid") ?? "", c.req.param("*") ?? "");
});
app.on(["GET", "HEAD"], "/ipns/:name", (c) => isPublicGateway(c) ? jsonError(c, 404, "IPNS_NOT_FOUND", "Use a project-scoped stable-link URL") : resolveName(c, c.req.param("name") ?? "", ""));
app.on(["GET", "HEAD"], "/ipns/:name/*", (c) => isPublicGateway(c) ? jsonError(c, 404, "IPNS_NOT_FOUND", "Use a project-scoped stable-link URL") : resolveName(c, c.req.param("name") ?? "", c.req.param("*") ?? ""));

app.post("/api/v0/add", requireScope("write"), kuboAdd);
app.post("/api/v0/cat", requireScope("read"), async (c) => {
  const arg = c.req.query("arg") ?? "";
  const match = arg.match(/^(?:\/ipfs\/)?([^/]+)(?:\/(.*))?$/);
  return match ? gatewayResponse(c, match[1] ?? "", match[2] ?? "") : jsonError(c, 400, "INVALID_IPFS_PATH", "arg is invalid");
});
app.post("/api/v0/get", requireScope("read"), async (c) => {
  const arg = c.req.query("arg") ?? "";
  const match = arg.match(/^(?:\/ipfs\/)?([^/]+)(?:\/(.*))?$/);
  return match ? gatewayResponse(c, match[1] ?? "", match[2] ?? "") : jsonError(c, 400, "INVALID_IPFS_PATH", "arg is invalid");
});
app.post("/api/v0/ls", requireScope("read"), async (c) => {
  const arg = c.req.query("arg") ?? "";
  const match = arg.match(/^(?:\/ipfs\/)?([^/]+)(?:\/(.*))?$/);
  return match ? gatewayResponse(c, match[1] ?? "", match[2] ?? "") : jsonError(c, 400, "INVALID_IPFS_PATH", "arg is invalid");
});
app.post("/api/v0/block/get", requireScope("read"), getBlockResponse);
app.post("/api/v0/block/stat", requireScope("read"), blockStat);
app.post("/api/v0/dag/get", requireScope("read"), dagGet);
app.post("/api/v0/dag/import", requireScope("write"), importCar);
app.post("/api/v0/dag/export", requireScope("export"), async (c) => {
  const cid = c.req.query("arg") ?? "";
  const url = new URL(c.req.url);
  url.pathname = `/api/v1/car/export/${cid}`;
  return app.fetch(new Request(url, c.req.raw), c.env, c.executionCtx);
});
app.post("/api/v0/pin/ls", requireScope("read"), kuboPinList);
app.post("/api/v0/pin/add", requireScope("pin"), async (c) => {
  const cid = c.req.query("arg") ?? "";
  let parsed;
  try { parsed = parseCid(cid); } catch { return jsonError(c, 400, "INVALID_CID", "CID is invalid"); }
  const projectId = currentProjectId(c);
  if (!(await getBlock(c.env, parsed)) || !(await projectCanAccessCid(c.env, projectId, cid))) return jsonError(c, 404, "BLOCK_NOT_FOUND", "Root block has not been imported into this project");
  const existing = await c.env.DB.prepare("SELECT request_id, status FROM pins WHERE project_id = ? AND cid = ?").bind(projectId, cid).first<{ request_id: string; status: string }>();
  if (existing) return c.json({ Pins: [cid], Status: existing.status });
  const requestId = crypto.randomUUID();
  const now = nowIso();
  await c.env.DB.prepare("INSERT INTO pins (request_id, project_id, cid, status, recursive, mode, metadata_json, created_by_key_id, created_at, updated_at) VALUES (?, ?, ?, 'pinning', 1, 'standard', '{}', ?, ?, ?)")
    .bind(requestId, projectId, cid, c.get("auth").keyId ?? null, now, now).run();
  const jobId = await createJob(c.env, "verify_pin", { cid, requestId, projectId }, projectId);
  await c.env.JOBS.send({ id: jobId, type: "verify_pin", payload: { cid, requestId, projectId } });
  return c.json({ Pins: [cid], Status: "pinning" });
});
app.post("/api/v0/name/resolve", requireScope("read"), async (c) => {
  const name = (c.req.query("arg") ?? "").replace(/^\/ipns\//, "");
  const row = await first<{ cid: string }>(c.env.DB.prepare("SELECT cid FROM ipns_names WHERE project_id = ? AND name = ?").bind(currentProjectId(c), name));
  return row ? c.json({ Path: `/ipfs/${row.cid}` }) : jsonError(c, 404, "IPNS_NOT_FOUND", "Private IPNS name does not exist");
});
app.all("/api/v0/*", unsupportedKubo);

app.on(["GET", "HEAD"], "*", async (c) => {
  if (isPublicGateway(c)) return jsonError(c, 404, "NOT_FOUND", "Gateway route does not exist");
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((error, c) => {
  console.error("request_failed", { message: error.message, path: c.req.path });
  return jsonError(c, 500, "INTERNAL_ERROR", c.env.ENVIRONMENT === "production" ? "Internal server error" : error.message);
});

export class UploadLock implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/acquire" && request.method === "POST") {
      const acquiredAt = await this.state.storage.get<number>("acquiredAt");
      if (acquiredAt && Date.now() - acquiredAt < 60_000) return new Response("busy", { status: 409 });
      await this.state.storage.put("acquiredAt", Date.now());
      return new Response("acquired");
    }
    if (path === "/release" && request.method === "POST") {
      await this.state.storage.delete("acquiredAt");
      return new Response("released");
    }
    const acquiredAt = await this.state.storage.get<number>("acquiredAt");
    return new Response(JSON.stringify({ busy: !!acquiredAt && Date.now() - acquiredAt < 60_000 }), { headers: { "Content-Type": "application/json" } });
  }
}

async function scheduledMaintenance(env: Env): Promise<void> {
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < datetime(?, '-7 days'))").bind(now, now),
    env.DB.prepare("DELETE FROM gateway_preview_tokens WHERE expires_at < ? OR used_at IS NOT NULL").bind(now)
  ]);
  const expired = await env.DB.prepare("SELECT id, object_key, multipart_id FROM uploads WHERE state IN ('created','uploading') AND expires_at < ? LIMIT 100")
    .bind(now).all<{ id: string; object_key: string; multipart_id: string }>();
  for (const upload of expired.results ?? []) {
    try { await env.OBJECTS.resumeMultipartUpload(upload.object_key, upload.multipart_id).abort(); } catch { /* already completed or aborted */ }
    await env.DB.prepare("DELETE FROM block_locations WHERE object_key = ?").bind(upload.object_key).run();
    await env.DB.prepare("DELETE FROM upload_parts WHERE upload_id = ?").bind(upload.id).run();
    await env.DB.prepare("DELETE FROM upload_chunks WHERE upload_id = ?").bind(upload.id).run();
    await env.DB.prepare("DELETE FROM blocks WHERE ref_count = 0 AND r2_key = ? AND NOT EXISTS (SELECT 1 FROM block_locations WHERE block_locations.cid = blocks.cid)")
      .bind(`object:${upload.object_key}`).run();
    await env.DB.prepare("UPDATE uploads SET state = 'expired', updated_at = ? WHERE id = ?").bind(nowIso(), upload.id).run();
  }

  const purgeable = await env.DB.prepare("SELECT id FROM projects WHERE state = 'deleted' AND purge_after <= ? AND id != 'default' LIMIT 25")
    .bind(now).all<{ id: string }>();
  for (const project of purgeable.results ?? []) {
    const uploads = await env.DB.prepare("SELECT object_key, multipart_id FROM uploads WHERE project_id = ?").bind(project.id).all<{ object_key: string; multipart_id: string | null }>();
    for (const upload of uploads.results ?? []) {
      if (upload.multipart_id) {
        try { await env.OBJECTS.resumeMultipartUpload(upload.object_key, upload.multipart_id).abort(); } catch { /* already completed */ }
      }
    }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM upload_parts WHERE upload_id IN (SELECT id FROM uploads WHERE project_id = ?)").bind(project.id),
      env.DB.prepare("DELETE FROM upload_chunks WHERE upload_id IN (SELECT id FROM uploads WHERE project_id = ?)").bind(project.id),
      env.DB.prepare("DELETE FROM uploads WHERE project_id = ?").bind(project.id),
      env.DB.prepare("DELETE FROM pin_blocks WHERE project_id = ?").bind(project.id),
      env.DB.prepare("DELETE FROM pins WHERE project_id = ?").bind(project.id),
      env.DB.prepare("DELETE FROM project_blocks WHERE project_id = ?").bind(project.id),
      env.DB.prepare("DELETE FROM project_objects WHERE project_id = ?").bind(project.id),
      env.DB.prepare("DELETE FROM project_replicas WHERE project_id = ?").bind(project.id),
      env.DB.prepare("DELETE FROM project_publications WHERE project_id = ?").bind(project.id),
      env.DB.prepare("DELETE FROM mfs_versions WHERE project_id = ?").bind(project.id),
      env.DB.prepare("DELETE FROM mfs_entries WHERE project_id = ?").bind(project.id),
      env.DB.prepare("DELETE FROM ipns_names WHERE project_id = ?").bind(project.id),
      env.DB.prepare("DELETE FROM project_api_keys WHERE project_id = ?").bind(project.id),
      env.DB.prepare("DELETE FROM quotas WHERE project_id = ?").bind(project.id),
      env.DB.prepare("DELETE FROM usage_daily WHERE project_id = ?").bind(project.id),
      env.DB.prepare("DELETE FROM jobs WHERE project_id = ?").bind(project.id),
      env.DB.prepare("DELETE FROM audit_logs WHERE project_id = ?").bind(project.id),
      env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(project.id),
      env.DB.prepare("UPDATE blocks SET ref_count = (SELECT COUNT(*) FROM pin_blocks WHERE pin_blocks.cid = blocks.cid)")
    ]);
  }
  for (const type of ["gc", "recovery_snapshot"] as const) {
    const id = await createJob(env, type, {});
    await env.JOBS.send({ id, type, payload: {} });
  }
  const publicPins = await env.DB.prepare(
    `SELECT pins.project_id, pins.cid FROM pins
     JOIN projects ON projects.id = pins.project_id
     LEFT JOIN project_publications ON project_publications.project_id = pins.project_id AND project_publications.cid = pins.cid
     WHERE pins.status = 'pinned' AND projects.state = 'active' AND projects.gateway_enabled = 1
       AND CASE WHEN project_publications.visibility IS NOT NULL AND project_publications.visibility != 'inherit'
         THEN project_publications.visibility ELSE projects.default_visibility END = 'public'
     ORDER BY COALESCE(project_publications.updated_at, pins.updated_at) ASC LIMIT 100`
  ).all<{ project_id: string; cid: string }>();
  for (const pin of publicPins.results ?? []) await queuePublication(env, pin.project_id, pin.cid);
}

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try { await handleJob(env, message.body); message.ack(); }
      catch { message.retry({ delaySeconds: Math.min(3600, 2 ** message.attempts * 10) }); }
    }
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(scheduledMaintenance(env));
  }
};

export { ReplicationWorkflow } from "./replication";
export { SecurityGate } from "./rate-limit";
