import { CarReader, CarWriter } from "@ipld/car";
import * as dagPb from "@ipld/dag-pb";
import { UnixFS } from "ipfs-unixfs";
import { importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import type { Context } from "hono";
import { z } from "zod";
import type { Env, Variables } from "./types";
import { all, audit, createJob, first } from "./db";
import { blockKey, codecName, getBlock, parseCid, putBlock, resolveUnixFs, walkDag } from "./ipfs";
import { gatewayResponse } from "./gateway";
import { CHUNK_SIZE, MAX_DAG_BLOCK_SIZE, base64ToBytes, bytesToBase64, jsonError, normalizePath, nowIso } from "./utils";
import { hashProjectKeyForStorage } from "./auth";
import { currentProjectId, projectCanAccessCid, queuePublication, queueUnpublication } from "./projects";

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

const pinSchema = z.object({
  cid: z.string().min(1),
  name: z.string().max(255).optional(),
  origins: z.array(z.string()).optional(),
  meta: z.record(z.string(), z.unknown()).default({})
});

const nameSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/),
  cid: z.string().min(1),
  ttlSeconds: z.number().int().min(60).max(31_536_000).default(86_400)
});

const tokenSchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.enum(["read", "write", "pin", "publish", "export"])).min(1),
  expiresAt: z.string().datetime().nullable().default(null)
});

const importSchema = z.object({ cid: z.string().min(1) });

function pinView(row: Record<string, unknown>): Record<string, unknown> {
  return {
    requestid: row.request_id,
    status: row.status,
    created: row.created_at,
    pin: {
      cid: row.cid,
      name: row.name,
      origins: [],
      meta: JSON.parse(String(row.metadata_json ?? "{}"))
    },
    delegates: [],
    info: { ...(row.error ? { error: row.error } : {}), mode: row.mode, size: row.size, visibility: row.visibility ?? "inherit", publicationStatus: row.publication_status ?? "private", createdByKeyId: row.created_by_key_id ?? null, createdByKeyName: row.created_by_key_name ?? "Owner console" }
  };
}

async function cidIsPinned(env: Env, projectId: string, cid: string): Promise<boolean> {
  const row = await first<{ allowed: number }>(env.DB.prepare(
    "SELECT 1 AS allowed FROM pins LEFT JOIN pin_blocks ON pin_blocks.request_id = pins.request_id WHERE pins.project_id = ? AND pins.status = 'pinned' AND (pins.cid = ? OR pin_blocks.cid = ?) LIMIT 1"
  ).bind(projectId, cid, cid));
  return row?.allowed === 1;
}

export async function listPins(c: AppContext): Promise<Response> {
  const status = c.req.query("status");
  const cid = c.req.query("cid");
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 50)));
  let sql = "SELECT pins.*, project_api_keys.name AS created_by_key_name, project_publications.visibility, project_publications.status AS publication_status FROM pins LEFT JOIN project_api_keys ON project_api_keys.id = pins.created_by_key_id LEFT JOIN project_publications ON project_publications.project_id = pins.project_id AND project_publications.cid = pins.cid WHERE pins.project_id = ?";
  const bindings: unknown[] = [currentProjectId(c)];
  if (status) { sql += " AND status = ?"; bindings.push(status); }
  if (cid) { sql += " AND cid = ?"; bindings.push(cid); }
  sql += " ORDER BY created_at DESC LIMIT ?";
  bindings.push(limit);
  const rows = await all<Record<string, unknown>>(c.env.DB.prepare(sql).bind(...bindings));
  return c.json({ count: rows.length, results: rows.map(pinView) });
}

export async function getPin(c: AppContext): Promise<Response> {
  const row = await first<Record<string, unknown>>(c.env.DB.prepare(
    "SELECT pins.*, project_api_keys.name AS created_by_key_name FROM pins LEFT JOIN project_api_keys ON project_api_keys.id = pins.created_by_key_id WHERE pins.request_id = ? AND pins.project_id = ?"
  ).bind(c.req.param("id") ?? "", currentProjectId(c)));
  if (!row) return jsonError(c, 404, "PIN_NOT_FOUND", "Pin request does not exist");
  return c.json(pinView(row));
}

export async function createPin(c: AppContext): Promise<Response> {
  const parsed = pinSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(c, 400, "INVALID_PIN", "Pin payload is invalid", parsed.error.flatten());
  let cid;
  try { cid = parseCid(parsed.data.cid); } catch { return jsonError(c, 400, "INVALID_CID", "CID is invalid"); }
  const projectId = currentProjectId(c);
  if (!(await projectCanAccessCid(c.env, projectId, cid.toString())) || !(await getBlock(c.env, cid))) return jsonError(c, 404, "BLOCK_NOT_FOUND", "Root block has not been imported into this project");
  const existing = await first<Record<string, unknown>>(c.env.DB.prepare("SELECT * FROM pins WHERE project_id = ? AND cid = ?").bind(projectId, cid.toString()));
  if (existing) return c.json(pinView(existing), 202);
  const requestId = crypto.randomUUID();
  const now = nowIso();
  await c.env.DB.prepare(
    "INSERT INTO pins (request_id, project_id, cid, name, status, recursive, size, mode, metadata_json, created_by_key_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'pinning', 1, 0, 'standard', ?, ?, ?, ?)"
  ).bind(requestId, projectId, cid.toString(), parsed.data.name ?? null, JSON.stringify(parsed.data.meta), c.get("auth").keyId ?? null, now, now).run();
  const jobId = await createJob(c.env, "verify_pin", { cid: cid.toString(), requestId, projectId }, projectId);
  await c.env.JOBS.send({ id: jobId, type: "verify_pin", payload: { cid: cid.toString(), requestId, projectId } });
  c.executionCtx.waitUntil(audit(c.env, c.get("auth").actor, "pin.create", cid.toString(), { requestId, jobId }, c.req.header("CF-Connecting-IP"), projectId));
  return c.json(pinView({ request_id: requestId, cid: cid.toString(), name: parsed.data.name, status: "pinning", created_at: now, metadata_json: JSON.stringify(parsed.data.meta) }), 202);
}

export async function deletePin(c: AppContext): Promise<Response> {
  const id = c.req.param("id") ?? "";
  const projectId = currentProjectId(c);
  const pin = await first<{ cid: string }>(c.env.DB.prepare("SELECT cid FROM pins WHERE request_id = ? AND project_id = ?").bind(id, projectId));
  if (!pin) return jsonError(c, 404, "PIN_NOT_FOUND", "Pin request does not exist");
  await queueUnpublication(c.env, projectId, pin.cid);
  const cids = await all<{ cid: string }>(c.env.DB.prepare("SELECT cid FROM pin_blocks WHERE request_id = ?").bind(id));
  await c.env.DB.prepare("DELETE FROM pin_blocks WHERE request_id = ?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM pins WHERE request_id = ?").bind(id).run();
  const statements = cids.map((item) => c.env.DB.prepare(
    "UPDATE blocks SET ref_count = (SELECT COUNT(*) FROM pin_blocks WHERE pin_blocks.cid = blocks.cid) WHERE cid = ?"
  ).bind(item.cid));
  for (let index = 0; index < statements.length; index += 80) await c.env.DB.batch(statements.slice(index, index + 80));
  c.executionCtx.waitUntil(audit(c.env, c.get("auth").actor, "pin.delete", pin.cid, { requestId: id }, c.req.header("CF-Connecting-IP"), projectId));
  return new Response(null, { status: 202 });
}

export async function mfsList(c: AppContext): Promise<Response> {
  let path: string;
  try { path = normalizePath(c.req.query("path") ?? "/"); } catch { return jsonError(c, 400, "INVALID_PATH", "MFS path is invalid"); }
  const prefix = path === "/" ? "/" : `${path}/`;
  const rows = await all<Record<string, unknown>>(c.env.DB.prepare("SELECT * FROM mfs_entries WHERE project_id = ? AND path LIKE ? ORDER BY path LIMIT 1000").bind(currentProjectId(c), `${prefix}%`));
  const depth = prefix.split("/").length;
  const entries = rows.filter((row) => String(row.path).split("/").length === depth);
  return c.json({ path, entries });
}

interface MfsRow {
  path: string;
  cid: string;
  type: "file" | "directory";
  size: number;
  mode: number | null;
  mtime: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

async function recordMfsVersions(env: Env, projectId: string, rows: MfsRow[], action: string, deleted = false): Promise<void> {
  const recordedAt = nowIso();
  const statements = rows.map((row) => env.DB.prepare(
    "INSERT INTO mfs_versions (project_id, path, cid, type, size, mode, mtime, version, action, deleted, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(projectId, row.path, row.cid, row.type, row.size, row.mode, row.mtime, row.version, action, deleted ? 1 : 0, recordedAt));
  for (let index = 0; index < statements.length; index += 80) await env.DB.batch(statements.slice(index, index + 80));
}

async function mfsTree(env: Env, projectId: string, path: string): Promise<MfsRow[]> {
  return all<MfsRow>(env.DB.prepare("SELECT * FROM mfs_entries WHERE project_id = ? AND (path = ? OR path LIKE ?) ORDER BY path").bind(projectId, path, `${path}/%`));
}

export async function mfsMutate(c: AppContext): Promise<Response> {
  const projectId = currentProjectId(c);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body.op !== "string") return jsonError(c, 400, "INVALID_MFS_OPERATION", "MFS operation is required");
  const op = body.op;
  let path: string;
  try { path = normalizePath(String(body.path ?? "/")); } catch { return jsonError(c, 400, "INVALID_PATH", "MFS path is invalid"); }
  const now = nowIso();
  if (op === "mkdir" || op === "write") {
    if (path === "/") return jsonError(c, 400, "INVALID_PATH", "Root path cannot be overwritten");
    const type = op === "mkdir" ? "directory" : "file";
    const cid = String(body.cid ?? "");
    if (op === "write") {
      try { parseCid(cid); } catch { return jsonError(c, 400, "INVALID_CID", "CID is invalid"); }
      if (!(await cidIsPinned(c.env, projectId, cid))) return jsonError(c, 409, "CID_NOT_PINNED", "MFS entries must reference verified pinned content");
    }
    await c.env.DB.prepare(
      "INSERT INTO mfs_entries (project_id, path, cid, type, size, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT(project_id, path) DO UPDATE SET cid = excluded.cid, type = excluded.type, size = excluded.size, version = mfs_entries.version + 1, updated_at = excluded.updated_at"
    ).bind(projectId, path, op === "mkdir" ? "directory" : cid, type, Number(body.size ?? 0), now, now).run();
    const current = await first<MfsRow>(c.env.DB.prepare("SELECT * FROM mfs_entries WHERE project_id = ? AND path = ?").bind(projectId, path));
    if (current) await recordMfsVersions(c.env, projectId, [current], op);
  } else if (op === "rm") {
    if (path === "/") return jsonError(c, 400, "INVALID_PATH", "Root path cannot be removed");
    const removed = await mfsTree(c.env, projectId, path);
    if (!removed.length) return jsonError(c, 404, "MFS_NOT_FOUND", "Path does not exist");
    await recordMfsVersions(c.env, projectId, removed, "rm", true);
    await c.env.DB.prepare("DELETE FROM mfs_entries WHERE project_id = ? AND (path = ? OR path LIKE ?)").bind(projectId, path, `${path}/%`).run();
  } else if (op === "mv" || op === "cp") {
    let destination: string;
    try { destination = normalizePath(String(body.destination ?? "")); } catch { return jsonError(c, 400, "INVALID_PATH", "Destination path is invalid"); }
    if (destination === "/" || destination === path || destination.startsWith(`${path}/`)) return jsonError(c, 400, "INVALID_DESTINATION", "Destination cannot be the root or inside the source tree");
    const source = await mfsTree(c.env, projectId, path);
    if (!source.length) return jsonError(c, 404, "MFS_NOT_FOUND", "Source path does not exist");
    const overwritten = await mfsTree(c.env, projectId, destination);
    if (overwritten.length) await recordMfsVersions(c.env, projectId, overwritten, `${op}.overwrite`, true);
    const statements = source.map((row) => {
      const targetPath = `${destination}${row.path.slice(path.length)}`;
      return c.env.DB.prepare(
        "INSERT OR REPLACE INTO mfs_entries (project_id, path, cid, type, size, mode, mtime, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(projectId, targetPath, row.cid, row.type, row.size, row.mode, row.mtime, row.version + 1, now, now);
    });
    for (let index = 0; index < statements.length; index += 80) await c.env.DB.batch(statements.slice(index, index + 80));
    if (op === "mv") {
      await recordMfsVersions(c.env, projectId, source, "mv.source", true);
      await c.env.DB.prepare("DELETE FROM mfs_entries WHERE project_id = ? AND (path = ? OR path LIKE ?)").bind(projectId, path, `${path}/%`).run();
    }
    await recordMfsVersions(c.env, projectId, await mfsTree(c.env, projectId, destination), op);
  } else if (op === "rollback") {
    const historyId = Number(body.historyId);
    if (!Number.isSafeInteger(historyId) || historyId < 1) return jsonError(c, 400, "INVALID_HISTORY", "historyId is required for rollback");
    const snapshot = await first<MfsRow & { id: number }>(c.env.DB.prepare("SELECT * FROM mfs_versions WHERE id = ? AND project_id = ? AND path = ?").bind(historyId, projectId, path));
    if (!snapshot) return jsonError(c, 404, "MFS_VERSION_NOT_FOUND", "Requested MFS version does not exist");
    if (snapshot.type === "file" && !(await cidIsPinned(c.env, projectId, snapshot.cid))) return jsonError(c, 409, "CID_NOT_PINNED", "The historical CID must be pinned before rollback");
    const current = await first<{ version: number }>(c.env.DB.prepare("SELECT version FROM mfs_entries WHERE project_id = ? AND path = ?").bind(projectId, path));
    await c.env.DB.prepare(
      "INSERT OR REPLACE INTO mfs_entries (project_id, path, cid, type, size, mode, mtime, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(projectId, path, snapshot.cid, snapshot.type, snapshot.size, snapshot.mode, snapshot.mtime, (current?.version ?? snapshot.version) + 1, now, now).run();
    const restored = await first<MfsRow>(c.env.DB.prepare("SELECT * FROM mfs_entries WHERE project_id = ? AND path = ?").bind(projectId, path));
    if (restored) await recordMfsVersions(c.env, projectId, [restored], "rollback");
  } else {
    return jsonError(c, 400, "UNSUPPORTED_MFS_OPERATION", `Unsupported operation ${op}`);
  }
  c.executionCtx.waitUntil(audit(c.env, c.get("auth").actor, `mfs.${op}`, path, body, c.req.header("CF-Connecting-IP"), projectId));
  return c.json({ ok: true, op, path });
}

export async function mfsHistory(c: AppContext): Promise<Response> {
  let path: string;
  try { path = normalizePath(c.req.query("path") ?? ""); } catch { return jsonError(c, 400, "INVALID_PATH", "MFS path is invalid"); }
  const results = await all<Record<string, unknown>>(c.env.DB.prepare("SELECT * FROM mfs_versions WHERE project_id = ? AND path = ? ORDER BY recorded_at DESC, id DESC LIMIT 100").bind(currentProjectId(c), path));
  return c.json({ path, results });
}

export async function mfsDelete(c: AppContext): Promise<Response> {
  const projectId = currentProjectId(c);
  let path: string;
  try { path = normalizePath(c.req.query("path") ?? ""); } catch { return jsonError(c, 400, "INVALID_PATH", "MFS path is invalid"); }
  if (path === "/") return jsonError(c, 400, "INVALID_PATH", "Root path cannot be removed");
  const removed = await mfsTree(c.env, projectId, path);
  if (!removed.length) return jsonError(c, 404, "MFS_NOT_FOUND", "Path does not exist");
  await recordMfsVersions(c.env, projectId, removed, "delete", true);
  await c.env.DB.prepare("DELETE FROM mfs_entries WHERE project_id = ? AND (path = ? OR path LIKE ?)").bind(projectId, path, `${path}/%`).run();
  c.executionCtx.waitUntil(audit(c.env, c.get("auth").actor, "mfs.delete", path, {}, c.req.header("CF-Connecting-IP"), projectId));
  return new Response(null, { status: 204 });
}

export async function listNames(c: AppContext): Promise<Response> {
  return c.json({ results: await all<Record<string, unknown>>(c.env.DB.prepare("SELECT * FROM ipns_names WHERE project_id = ? ORDER BY name").bind(currentProjectId(c))) });
}

async function signPrivateNameRecord(env: Env, name: string, cid: string, sequence: number, ttlSeconds: number, issuedAt: string): Promise<{ publicKey: string; record: Record<string, unknown> }> {
  if (!env.IPNS_SIGNING_KEY) throw new Error("IPNS_SIGNING_KEY is not configured");
  const seed = base64ToBytes(env.IPNS_SIGNING_KEY);
  if (seed.length !== 32) throw new Error("IPNS_SIGNING_KEY must decode to exactly 32 bytes");
  const prefix = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
  const pkcs8 = new Uint8Array(prefix.length + seed.length);
  pkcs8.set(prefix); pkcs8.set(seed, prefix.length);
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  if (!jwk.x) throw new Error("Could not derive Ed25519 public key");
  const value = `/ipfs/${cid}`;
  const validUntil = new Date(Date.parse(issuedAt) + ttlSeconds * 1000).toISOString();
  const payload = { name, value, sequence, ttlSeconds, issuedAt, validUntil };
  const signatureBytes = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(JSON.stringify(payload))));
  const signature = bytesToBase64(signatureBytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return { publicKey: jwk.x, record: { version: 1, signatureType: "Ed25519", publicKey: jwk.x, ...payload, signature } };
}

export async function publishName(c: AppContext): Promise<Response> {
  const projectId = currentProjectId(c);
  const parsed = nameSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(c, 400, "INVALID_NAME", "IPNS payload is invalid", parsed.error.flatten());
  try { parseCid(parsed.data.cid); } catch { return jsonError(c, 400, "INVALID_CID", "CID is invalid"); }
  if (!(await cidIsPinned(c.env, projectId, parsed.data.cid))) return jsonError(c, 409, "CID_NOT_PINNED", "Stable Links must reference verified project content");
  const now = nowIso();
  const existing = await first<{ sequence: number }>(c.env.DB.prepare("SELECT sequence FROM ipns_names WHERE project_id = ? AND name = ?").bind(projectId, parsed.data.name));
  const sequence = existing ? existing.sequence + 1 : 0;
  let signed;
  try { signed = await signPrivateNameRecord(c.env, parsed.data.name, parsed.data.cid, sequence, parsed.data.ttlSeconds, now); }
  catch (error) { return jsonError(c, 503, "IPNS_SIGNING_UNAVAILABLE", error instanceof Error ? error.message : "IPNS signing is unavailable"); }
  await c.env.DB.prepare(
    "INSERT INTO ipns_names (project_id, name, cid, sequence, ttl_seconds, public_key, record_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, name) DO UPDATE SET cid = excluded.cid, sequence = excluded.sequence, ttl_seconds = excluded.ttl_seconds, public_key = excluded.public_key, record_json = excluded.record_json, updated_at = excluded.updated_at"
  ).bind(projectId, parsed.data.name, parsed.data.cid, sequence, parsed.data.ttlSeconds, signed.publicKey, JSON.stringify(signed.record), now).run();
  c.executionCtx.waitUntil(audit(c.env, c.get("auth").actor, "ipns.publish", parsed.data.name, { cid: parsed.data.cid }, c.req.header("CF-Connecting-IP"), projectId));
  return c.json({ name: parsed.data.name, value: `/ipfs/${parsed.data.cid}`, ttl: parsed.data.ttlSeconds, sequence, record: signed.record });
}

export async function exportNameRecord(c: AppContext): Promise<Response> {
  const row = await first<{ record_json: string }>(c.env.DB.prepare("SELECT record_json FROM ipns_names WHERE project_id = ? AND name = ?").bind(currentProjectId(c), c.req.param("name") ?? ""));
  if (!row) return jsonError(c, 404, "IPNS_NOT_FOUND", "Private IPNS name does not exist");
  return new Response(row.record_json, { headers: { "Content-Type": "application/vnd.ipfs.ipns-record+json", "Content-Disposition": `attachment; filename="${c.req.param("name")}.ipns.json"` } });
}

export async function resolveName(c: AppContext, name: string, path = ""): Promise<Response> {
  const row = await first<{ cid: string }>(c.env.DB.prepare("SELECT cid FROM ipns_names WHERE project_id = ? AND name = ?").bind(currentProjectId(c), name));
  if (!row) return jsonError(c, 404, "IPNS_NOT_FOUND", "Private IPNS name does not exist");
  return gatewayResponse(c, row.cid, path, { projectId: currentProjectId(c) });
}

function randomTokenPart(length = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function createToken(c: AppContext): Promise<Response> {
  const parsed = tokenSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(c, 400, "INVALID_TOKEN", "Token payload is invalid", parsed.error.flatten());
  const pepper = c.env.PROJECT_KEY_PEPPER;
  if (!pepper) return jsonError(c, 503, "TOKEN_AUTH_NOT_CONFIGURED", "PROJECT_KEY_PEPPER must be configured before creating API keys");
  const id = crypto.randomUUID();
  const prefix = randomTokenPart(6);
  const token = `orbitcid_proj_${prefix}_${randomTokenPart(32)}`;
  const hash = await hashProjectKeyForStorage(token, pepper);
  const projectId = currentProjectId(c);
  await c.env.DB.prepare(
    "INSERT INTO project_api_keys (id, project_id, prefix, name, secret_hash, scopes_json, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, projectId, prefix, parsed.data.name, hash, JSON.stringify(parsed.data.scopes), parsed.data.expiresAt, nowIso()).run();
  c.executionCtx.waitUntil(audit(c.env, c.get("auth").actor, "project_key.create", id, { name: parsed.data.name, scopes: parsed.data.scopes }, c.req.header("CF-Connecting-IP"), projectId));
  return c.json({ id, name: parsed.data.name, prefix, scopes: parsed.data.scopes, expiresAt: parsed.data.expiresAt, token }, 201);
}

export async function listTokens(c: AppContext): Promise<Response> {
  const rows = await all<Record<string, unknown>>(c.env.DB.prepare(
    "SELECT id, prefix, name, scopes_json, expires_at, last_used_at, revoked_at, created_at FROM project_api_keys WHERE project_id = ? ORDER BY created_at DESC"
  ).bind(currentProjectId(c)));
  return c.json({ results: rows.map((row) => ({ ...row, scopes: JSON.parse(String(row.scopes_json)), scopes_json: undefined })) });
}

export async function revokeToken(c: AppContext): Promise<Response> {
  const id = c.req.param("id") ?? "";
  const projectId = currentProjectId(c);
  await c.env.DB.prepare("UPDATE project_api_keys SET revoked_at = ? WHERE id = ? AND project_id = ?").bind(nowIso(), id, projectId).run();
  c.executionCtx.waitUntil(audit(c.env, c.get("auth").actor, "project_key.revoke", id, {}, c.req.header("CF-Connecting-IP"), projectId));
  return new Response(null, { status: 204 });
}

export async function listAudit(c: AppContext): Promise<Response> {
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 100)));
  return c.json({ results: await all<Record<string, unknown>>(c.env.DB.prepare("SELECT * FROM audit_logs WHERE project_id = ? OR project_id IS NULL ORDER BY created_at DESC LIMIT ?").bind(currentProjectId(c), limit)) });
}

interface ServiceHealth {
  status: "operational" | "degraded" | "disabled";
  latencyMs: number;
  detail: string;
}

async function measureHealth(check: () => Promise<string>): Promise<ServiceHealth> {
  const started = Date.now();
  try {
    const detail = await check();
    return { status: "operational", latencyMs: Date.now() - started, detail };
  } catch (error) {
    return { status: "degraded", latencyMs: Date.now() - started, detail: error instanceof Error ? error.message : "Health check failed" };
  }
}

export async function systemHealth(c: AppContext): Promise<Response> {
  const started = Date.now();
  const nodeHealth = (url: string | undefined, token: string | undefined, label: string, required: boolean): Promise<ServiceHealth> => {
    if (!url && !required) return Promise.resolve({ status: "disabled", latencyMs: 0, detail: `${label} is an optional upgrade replica` });
    return measureHealth(async () => {
    if (!url || !token) throw new Error(`${label} bridge URL or token is not configured`);
    const response = await fetch(new URL("/healthz", url), { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`${label} bridge returned ${response.status}`);
    const body = await response.json<{ peerId?: string; peers?: number }>();
    if (!body.peerId) throw new Error(`${label} Kubo peer ID is unavailable`);
    return `${label} peer ${body.peerId} · ${body.peers ?? 0} swarm peers`;
    });
  };
  const [d1, objects, blocks, cache, queue, secondary, primary] = await Promise.all([
    measureHealth(async () => {
      const row = await c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
      if (row?.ok !== 1) throw new Error("D1 query failed");
      return "Metadata query succeeded";
    }),
    measureHealth(async () => {
      await c.env.OBJECTS.list({ limit: 1 });
      return "Canonical object bucket reachable";
    }),
    measureHealth(async () => {
      await c.env.BLOCKS.list({ limit: 1 });
      return "Content-addressed block bucket reachable";
    }),
    measureHealth(async () => {
      await c.env.CACHE.get("health:probe");
      return "Edge configuration cache reachable";
    }),
    measureHealth(async () => {
      const row = await c.env.DB.prepare(
        "SELECT SUM(CASE WHEN status IN ('queued','running') THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed FROM jobs"
      ).first<{ active: number | null; failed: number | null }>();
      return `${row?.active ?? 0} active, ${row?.failed ?? 0} failed jobs`;
    }),
    nodeHealth(c.env.KUBO_NODE_SECONDARY_URL, c.env.KUBO_NODE_SECONDARY_TOKEN, "Secondary replica", false),
    nodeHealth(c.env.KUBO_NODE_PRIMARY_URL, c.env.KUBO_NODE_PRIMARY_TOKEN, "Primary node", true)
  ]);
  const services = { worker: { status: "operational" as const, latencyMs: 0, detail: "Request handler online" }, d1, objects, blocks, cache, queue, primary, secondary };
  const status = Object.values(services).every((service) => service.status === "operational" || service.status === "disabled") ? "operational" : "degraded";
  return c.json({ status, latencyMs: Date.now() - started, checkedAt: nowIso(), services });
}

export async function importPublicCid(c: AppContext): Promise<Response> {
  const parsed = importSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(c, 400, "INVALID_IMPORT", "Import payload is invalid", parsed.error.flatten());
  try { parseCid(parsed.data.cid); } catch { return jsonError(c, 400, "INVALID_CID", "CID is invalid"); }
  const requestId = crypto.randomUUID();
  const projectId = currentProjectId(c);
  const createdByKeyId = c.get("auth").keyId ?? null;
  const jobId = await createJob(c.env, "import_cid", { cid: parsed.data.cid, requestId, projectId, createdByKeyId }, projectId);
  await c.env.JOBS.send({ id: jobId, type: "import_cid", payload: { cid: parsed.data.cid, requestId, projectId, createdByKeyId } });
  c.executionCtx.waitUntil(audit(c.env, c.get("auth").actor, "import.cid", parsed.data.cid, { jobId, requestId }, c.req.header("CF-Connecting-IP"), projectId));
  return c.json({ jobId, requestId, cid: parsed.data.cid, status: "queued" }, 202);
}

export async function importCar(c: AppContext): Promise<Response> {
  const length = Number(c.req.header("Content-Length") ?? 0);
  if (length > 64 * 1024 * 1024) return jsonError(c, 413, "CAR_TOO_LARGE", "Direct CAR import is limited to 64 MiB");
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.length > 64 * 1024 * 1024) return jsonError(c, 413, "CAR_TOO_LARGE", "Direct CAR import is limited to 64 MiB");
  let reader: CarReader;
  try { reader = await CarReader.fromBytes(bytes); } catch { return jsonError(c, 400, "INVALID_CAR", "CAR file could not be decoded"); }
  const roots = await reader.getRoots();
  if (!roots.length) return jsonError(c, 400, "CAR_ROOT_REQUIRED", "CAR archive must declare at least one root CID");
  let count = 0;
  const projectId = currentProjectId(c);
  const ownership: D1PreparedStatement[] = [];
  for await (const block of reader.blocks()) {
    if (block.bytes.length > MAX_DAG_BLOCK_SIZE) return jsonError(c, 413, "CAR_BLOCK_TOO_LARGE", `Block ${block.cid} exceeds ${MAX_DAG_BLOCK_SIZE} bytes`);
    if (count >= 100_000) return jsonError(c, 413, "CAR_BLOCK_LIMIT", "CAR archive contains too many blocks");
    await putBlock(c.env, block.cid, block.bytes);
    ownership.push(c.env.DB.prepare("INSERT OR IGNORE INTO project_blocks (project_id, cid, source, created_at) VALUES (?, ?, 'car', ?)").bind(projectId, block.cid.toString(), nowIso()));
    if (ownership.length >= 80) await c.env.DB.batch(ownership.splice(0));
    count += 1;
  }
  if (ownership.length) await c.env.DB.batch(ownership);
  c.executionCtx.waitUntil(audit(c.env, c.get("auth").actor, "import.car", roots.map((root) => root.toString()).join(","), { blocks: count, bytes: bytes.length }, c.req.header("CF-Connecting-IP"), projectId));
  return c.json({ roots: roots.map((root) => root.toString()), blocks: count }, 201);
}

export async function exportCar(c: AppContext): Promise<Response> {
  let root;
  try { root = parseCid(c.req.param("cid") ?? ""); } catch { return jsonError(c, 400, "INVALID_CID", "CID is invalid"); }
  if (!(await projectCanAccessCid(c.env, currentProjectId(c), root.toString()))) return jsonError(c, 404, "DAG_NOT_FOUND", "DAG is not available in this project");
  let cids;
  try { cids = await walkDag(c.env, root, Number(c.env.MAX_DAG_DEPTH || 1024)); } catch (error) {
    return jsonError(c, 404, "DAG_NOT_FOUND", error instanceof Error ? error.message : "DAG could not be exported");
  }
  const { writer, out } = CarWriter.create([root]);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        try {
          const drain = (async () => { for await (const chunk of out) controller.enqueue(chunk); })();
          for (const cid of cids) {
            const block = await getBlock(c.env, cid);
            if (!block) throw new Error(`Missing block ${cid}`);
            await writer.put(block);
          }
          await writer.close();
          await drain;
          controller.close();
        } catch (error) { controller.error(error); }
      })();
    }
  });
  return new Response(stream, { headers: { "Content-Type": "application/vnd.ipld.car", "Content-Disposition": `attachment; filename="${root}.car"` } });
}

export async function getBlockResponse(c: AppContext): Promise<Response> {
  const value = c.req.query("arg") ?? c.req.param("cid") ?? "";
  let cid;
  try { cid = parseCid(value); } catch { return jsonError(c, 400, "INVALID_CID", "CID is invalid"); }
  if (!(await projectCanAccessCid(c.env, currentProjectId(c), cid.toString()))) return jsonError(c, 404, "BLOCK_NOT_FOUND", "Block does not exist in this project");
  const block = await getBlock(c.env, cid);
  if (!block) return jsonError(c, 404, "BLOCK_NOT_FOUND", "Block does not exist");
  return new Response(new Uint8Array(block.bytes).buffer, { headers: { "Content-Type": "application/vnd.ipld.raw", ETag: `"${cid}"` } });
}

export async function blockStat(c: AppContext): Promise<Response> {
  const value = c.req.query("arg") ?? c.req.param("cid") ?? "";
  if (!(await projectCanAccessCid(c.env, currentProjectId(c), value))) return jsonError(c, 404, "BLOCK_NOT_FOUND", "Block does not exist in this project");
  const row = await first<{ cid: string; size: number; codec: string }>(c.env.DB.prepare("SELECT cid, size, codec FROM blocks WHERE cid = ?").bind(value));
  if (!row) return jsonError(c, 404, "BLOCK_NOT_FOUND", "Block does not exist");
  return c.json({ Key: row.cid, Size: row.size, Codec: row.codec });
}

export async function dagGet(c: AppContext): Promise<Response> {
  const value = c.req.query("arg") ?? c.req.param("cid") ?? "";
  let cid;
  try { cid = parseCid(value); } catch { return jsonError(c, 400, "INVALID_CID", "CID is invalid"); }
  if (!(await projectCanAccessCid(c.env, currentProjectId(c), cid.toString()))) return jsonError(c, 404, "BLOCK_NOT_FOUND", "Block does not exist in this project");
  const block = await getBlock(c.env, cid);
  if (!block) return jsonError(c, 404, "BLOCK_NOT_FOUND", "Block does not exist");
  if (cid.code === dagPb.code) {
    const node = dagPb.decode(block.bytes);
    const unixfs = node.Data ? UnixFS.unmarshal(node.Data) : null;
    return c.json({ cid: cid.toString(), codec: codecName(cid.code), unixfs: unixfs ? { type: unixfs.type, size: Number(unixfs.fileSize()) } : null, links: node.Links.map((link) => ({ name: link.Name, cid: link.Hash.toString(), size: Number(link.Tsize ?? 0) })) });
  }
  return c.json({ cid: cid.toString(), codec: codecName(cid.code), bytes: bytesToBase64(block.bytes) });
}

export async function kuboAdd(c: AppContext): Promise<Response> {
  const form = await c.req.raw.formData();
  const files = form.getAll("file").filter((value): value is File => value instanceof File);
  if (!files.length) return jsonError(c, 400, "FILE_REQUIRED", "Multipart field 'file' is required");
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > 64 * 1024 * 1024) return jsonError(c, 413, "ADD_TOO_LARGE", "Kubo-compatible add is limited to 64 MiB; use resumable uploads for larger content");
  const stored = new Map<string, Uint8Array>();
  const blockstore = {
    put: async (cid: ReturnType<typeof parseCid>, bytes: Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>) => {
      if (!(bytes instanceof Uint8Array)) throw new Error("Streaming block writes are not supported by this adapter");
      stored.set(cid.toString(), bytes);
      await putBlock(c.env, cid, bytes);
      return cid;
    }
  };
  const source = await Promise.all(files.map(async (file) => ({ path: file.name, content: new Uint8Array(await file.arrayBuffer()) })));
  const results: Array<{ Name: string; Hash: string; Size: string }> = [];
  let root = "";
  for await (const entry of importer(source, blockstore, {
    cidVersion: 1,
    rawLeaves: true,
    chunker: fixedSize({ chunkSize: CHUNK_SIZE }),
    wrapWithDirectory: c.req.query("wrap-with-directory") === "true"
  })) {
    root = entry.cid.toString();
    results.push({ Name: entry.path ?? "", Hash: root, Size: entry.size.toString() });
  }
  const requestId = crypto.randomUUID();
  const now = nowIso();
  const projectId = currentProjectId(c);
  await c.env.DB.prepare("INSERT OR IGNORE INTO pins (request_id, project_id, cid, name, status, recursive, size, mode, metadata_json, created_by_key_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'pinned', 1, ?, 'standard', '{}', ?, ?, ?)")
    .bind(requestId, projectId, root, files[0]?.name ?? root, total, c.get("auth").keyId ?? null, now, now).run();
  const pin = await first<{ request_id: string }>(c.env.DB.prepare("SELECT request_id FROM pins WHERE project_id = ? AND cid = ?").bind(projectId, root));
  if (pin) {
    const cids = await walkDag(c.env, parseCid(root), Number(c.env.MAX_DAG_DEPTH || 1024));
    const statements: D1PreparedStatement[] = [];
    for (const cid of cids) {
      statements.push(
        c.env.DB.prepare("INSERT OR IGNORE INTO pin_blocks (request_id, project_id, cid) VALUES (?, ?, ?)").bind(pin.request_id, projectId, cid.toString()),
        c.env.DB.prepare("UPDATE blocks SET ref_count = (SELECT COUNT(*) FROM pin_blocks WHERE pin_blocks.cid = blocks.cid) WHERE cid = ?").bind(cid.toString())
      );
      if (statements.length >= 80) await c.env.DB.batch(statements.splice(0));
    }
    if (statements.length) await c.env.DB.batch(statements);
  }
  c.executionCtx.waitUntil(Promise.all([
    audit(c.env, c.get("auth").actor, "kubo.add", root, { files: files.length, bytes: total }, c.req.header("CF-Connecting-IP"), projectId),
    queuePublication(c.env, projectId, root)
  ]));
  const body = `${results.map((result) => JSON.stringify(result)).join("\n")}\n`;
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson" } });
}

export async function kuboPinList(c: AppContext): Promise<Response> {
  const rows = await all<{ cid: string }>(c.env.DB.prepare("SELECT cid FROM pins WHERE project_id = ? AND status = 'pinned'").bind(currentProjectId(c)));
  return c.json({ Keys: Object.fromEntries(rows.map((row) => [row.cid, { Type: "recursive" }])) });
}

export async function kuboLs(c: AppContext): Promise<Response> {
  const arg = c.req.query("arg") ?? "";
  const match = arg.match(/^(?:\/ipfs\/)?([^/]+)(?:\/(.*))?$/);
  if (!match) return jsonError(c, 400, "INVALID_IPFS_PATH", "arg is invalid");
  let root;
  try { root = parseCid(match[1] ?? ""); } catch { return jsonError(c, 400, "INVALID_CID", "CID is invalid"); }
  if (!(await projectCanAccessCid(c.env, currentProjectId(c), root.toString()))) return jsonError(c, 404, "IPFS_NOT_FOUND", "Content does not exist in this project");
  try {
    const resolved = await resolveUnixFs(c.env, root, (match[2] ?? "").split("/").filter(Boolean));
    if (resolved.type !== "directory") {
      const block = await getBlock(c.env, resolved.cid);
      return c.json({ Objects: [{ Hash: resolved.cid.toString(), Type: "File", Size: block?.bytes.length ?? 0, Links: [] }] });
    }
    const block = await getBlock(c.env, resolved.cid);
    if (!block) return jsonError(c, 404, "BLOCK_NOT_FOUND", "Directory block is missing");
    const node = dagPb.decode(block.bytes);
    return c.json({ Objects: [{ Hash: resolved.cid.toString(), Type: "Directory", Size: Number(node.Links.reduce((sum, link) => sum + Number(link.Tsize ?? 0), 0)), Links: node.Links.map((link) => ({ Name: link.Name ?? "", Hash: link.Hash.toString(), Size: Number(link.Tsize ?? 0), Type: 0 })) }] });
  } catch (error) {
    return jsonError(c, 404, "IPFS_NOT_FOUND", error instanceof Error ? error.message : "Content was not found");
  }
}

export async function unsupportedKubo(c: AppContext): Promise<Response> {
  return jsonError(c, 501, "NOT_SUPPORTED", "This command requires a real Kubo/libp2p node and is intentionally unavailable in the Cloudflare-only deployment");
}
