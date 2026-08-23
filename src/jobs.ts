import { CarReader } from "@ipld/car";
import type { Env, JobMessage } from "./types";
import { all, first, setJobState } from "./db";
import { blockKey, parseCid, putBlock, walkDag } from "./ipfs";
import { MAX_DAG_BLOCK_SIZE, base64ToBytes, bytesToBase64, nowIso } from "./utils";
import { queuePublication } from "./projects";
import { replicatePublicContent, unpublishPublicContent } from "./replication";

async function verifyPin(env: Env, message: JobMessage): Promise<void> {
  const cidValue = String(message.payload.cid ?? "");
  const requestId = String(message.payload.requestId ?? "");
  const uploadId = message.payload.uploadId ? String(message.payload.uploadId) : null;
  const projectId = String(message.payload.projectId ?? "default");
  const root = parseCid(cidValue);
  const cids = await walkDag(env, root, Number(env.MAX_DAG_DEPTH || 1024));
  const statements: D1PreparedStatement[] = [];
  for (const cid of cids) {
    statements.push(
      env.DB.prepare("INSERT OR IGNORE INTO pin_blocks (request_id, project_id, cid) VALUES (?, ?, ?)").bind(requestId, projectId, cid.toString()),
      env.DB.prepare("INSERT OR IGNORE INTO project_blocks (project_id, cid, source, created_at) VALUES (?, ?, 'pin', ?)").bind(projectId, cid.toString(), nowIso()),
      env.DB.prepare("UPDATE blocks SET ref_count = (SELECT COUNT(*) FROM pin_blocks WHERE pin_blocks.cid = blocks.cid) WHERE cid = ?")
        .bind(cid.toString())
    );
    if (statements.length >= 80) {
      await env.DB.batch(statements.splice(0));
    }
  }
  if (statements.length) await env.DB.batch(statements);
  const now = nowIso();
  await env.DB.prepare("UPDATE pins SET status = 'pinned', updated_at = ?, error = NULL WHERE project_id = ? AND (request_id = ? OR cid = ?)")
    .bind(now, projectId, requestId, cidValue).run();
  if (uploadId) await env.DB.prepare("UPDATE uploads SET state = 'pinned', updated_at = ? WHERE id = ?").bind(now, uploadId).run();
  await queuePublication(env, projectId, cidValue);
}

async function importCid(env: Env, message: JobMessage): Promise<void> {
  const cidValue = String(message.payload.cid ?? "");
  let requestId = String(message.payload.requestId ?? crypto.randomUUID());
  const projectId = String(message.payload.projectId ?? "default");
  const createdByKeyId = message.payload.createdByKeyId ? String(message.payload.createdByKeyId) : null;
  const gateways = env.IMPORT_GATEWAYS.split(",").map((value) => value.trim()).filter(Boolean);
  let bytes: Uint8Array | null = null;
  let lastError = "No import gateway succeeded";
  for (const gateway of gateways) {
    try {
      const url = new URL(`/ipfs/${encodeURIComponent(cidValue)}`, gateway);
      url.searchParams.set("format", "car");
      const response = await fetch(url, { headers: { Accept: "application/vnd.ipld.car" }, redirect: "error" });
      if (!response.ok || !response.body) throw new Error(`Gateway returned ${response.status}`);
      const length = Number(response.headers.get("Content-Length") ?? 0);
      if (length > 64 * 1024 * 1024) throw new Error("Import exceeds 64 MiB asynchronous import limit");
      bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > 64 * 1024 * 1024) throw new Error("Import exceeds 64 MiB asynchronous import limit");
      break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Gateway import failed";
    }
  }
  if (!bytes) throw new Error(lastError);
  const reader = await CarReader.fromBytes(bytes);
  const roots = await reader.getRoots();
  if (!roots.some((root) => root.toString() === cidValue)) throw new Error("CAR root does not match requested CID");
  let count = 0;
  for await (const block of reader.blocks()) {
    if (block.bytes.length > MAX_DAG_BLOCK_SIZE) throw new Error(`CAR block ${block.cid} exceeds the configured block-size limit`);
    if (count >= 100_000) throw new Error("CAR archive contains too many blocks");
    await putBlock(env, block.cid, block.bytes);
    count += 1;
  }
  const now = nowIso();
  const existing = await first<{ request_id: string }>(env.DB.prepare("SELECT request_id FROM pins WHERE project_id = ? AND cid = ?").bind(projectId, cidValue));
  if (existing) requestId = existing.request_id;
  await env.DB.prepare(
    "INSERT INTO pins (request_id, project_id, cid, name, status, recursive, size, mode, metadata_json, created_by_key_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'pinning', 1, 0, 'standard', '{}', ?, ?, ?) ON CONFLICT(project_id, cid) DO UPDATE SET status = 'pinning', created_by_key_id = excluded.created_by_key_id, updated_at = excluded.updated_at"
  ).bind(requestId, projectId, cidValue, `Imported ${cidValue.slice(0, 16)}`, createdByKeyId, now, now).run();
  await verifyPin(env, { ...message, type: "verify_pin", payload: { cid: cidValue, requestId, projectId } });
}

async function garbageCollect(env: Env): Promise<void> {
  const threshold = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const objects = await all<{ root_cid: string; object_key: string }>(env.DB.prepare(
    "SELECT objects.root_cid, objects.object_key FROM objects LEFT JOIN pins ON pins.cid = objects.root_cid AND pins.status = 'pinned' WHERE pins.cid IS NULL AND objects.created_at < ? LIMIT 100"
  ).bind(threshold));
  for (const object of objects) {
    await env.OBJECTS.delete(object.object_key);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM block_locations WHERE object_key = ?").bind(object.object_key),
      env.DB.prepare("DELETE FROM objects WHERE root_cid = ?").bind(object.root_cid)
    ]);
  }
  const blocks = await all<{ cid: string; r2_key: string }>(
    env.DB.prepare("SELECT cid, r2_key FROM blocks WHERE ref_count = 0 AND created_at < ? LIMIT 500").bind(threshold)
  );
  for (const block of blocks) {
    if (!block.r2_key.startsWith("object:")) await env.BLOCKS.delete(block.r2_key || blockKey(block.cid));
    await env.DB.prepare("DELETE FROM blocks WHERE cid = ? AND ref_count = 0").bind(block.cid).run();
  }
}

async function recoverySnapshot(env: Env): Promise<void> {
  if (!env.RECOVERY_KEY) throw new Error("RECOVERY_KEY is not configured");
  const keyBytes = base64ToBytes(env.RECOVERY_KEY);
  if (keyBytes.length !== 32) throw new Error("RECOVERY_KEY must decode to exactly 32 bytes");
  const keyMaterial = new Uint8Array(keyBytes.length); keyMaterial.set(keyBytes);
  const key = await crypto.subtle.importKey("raw", keyMaterial, { name: "AES-GCM" }, false, ["encrypt"]);
  const timestamp = nowIso().replace(/[:.]/g, "-");
  const prefix = `snapshots/${timestamp}`;
  const tables = ["projects", "uploads", "upload_chunks", "upload_parts", "blocks", "block_locations", "objects", "pins", "pin_blocks", "project_blocks", "project_objects", "mfs_entries", "mfs_versions", "ipns_names", "jobs", "project_api_keys", "quotas", "project_publications", "project_replicas", "navigation_preferences", "usage_daily", "audit_logs"] as const;
  const manifest: { version: number; createdAt: string; tables: Array<{ name: string; rows: number; pages: string[] }> } = { version: 2, createdAt: nowIso(), tables: [] };
  const encrypt = async (value: unknown, aad: string): Promise<string> => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const additionalData = new TextEncoder().encode(aad);
    const plaintext = new TextEncoder().encode(JSON.stringify(value));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, key, plaintext));
    return JSON.stringify({ version: 2, algorithm: "AES-256-GCM", aad, iv: bytesToBase64(iv), ciphertext: bytesToBase64(ciphertext) });
  };
  for (const table of tables) {
    let offset = 0;
    const entry = { name: table, rows: 0, pages: [] as string[] };
    while (true) {
      const rows = await all<Record<string, unknown>>(env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid LIMIT 250 OFFSET ?`).bind(offset));
      if (!rows.length) break;
      const page = String(entry.pages.length).padStart(6, "0");
      const objectKey = `${prefix}/${table}/${page}.json.enc`;
      await env.RECOVERY.put(objectKey, await encrypt({ table, offset, rows }, objectKey), { httpMetadata: { contentType: "application/vnd.orbitcid.recovery+json" } });
      entry.pages.push(objectKey);
      entry.rows += rows.length;
      offset += rows.length;
      if (rows.length < 250) break;
    }
    manifest.tables.push(entry);
  }
  const manifestKey = `${prefix}/manifest.json.enc`;
  await env.RECOVERY.put(manifestKey, await encrypt(manifest, manifestKey), { httpMetadata: { contentType: "application/vnd.orbitcid.recovery+json" } });
  await env.RECOVERY.put("snapshots/latest.txt", manifestKey, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
}

export async function handleJob(env: Env, message: JobMessage): Promise<void> {
  await setJobState(env, message.id, "running");
  try {
    if (message.type === "verify_pin") await verifyPin(env, message);
    else if (message.type === "import_cid") await importCid(env, message);
    else if (message.type === "gc") await garbageCollect(env);
    else if (message.type === "recovery_snapshot") await recoverySnapshot(env);
    else if (message.type === "replicate_public") await replicatePublicContent(env, String(message.payload.projectId ?? "default"), String(message.payload.cid ?? ""));
    else if (message.type === "unpublish_public") await unpublishPublicContent(env, String(message.payload.projectId ?? "default"), String(message.payload.cid ?? ""));
    await setJobState(env, message.id, "completed");
  } catch (error) {
    const text = error instanceof Error ? error.message : "Job failed";
    await setJobState(env, message.id, "failed", text);
    const requestId = message.payload.requestId ? String(message.payload.requestId) : null;
    const uploadId = message.payload.uploadId ? String(message.payload.uploadId) : null;
    if (requestId) await env.DB.prepare("UPDATE pins SET status = 'failed', error = ?, updated_at = ? WHERE request_id = ?").bind(text, nowIso(), requestId).run();
    if (uploadId) await env.DB.prepare("UPDATE uploads SET state = 'failed', error = ?, updated_at = ? WHERE id = ?").bind(text, nowIso(), uploadId).run();
    throw error;
  }
}

export async function getJob(env: Env, id: string): Promise<Record<string, unknown> | null> {
  return first<Record<string, unknown>>(env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id));
}
