import type { Context } from "hono";
import { z } from "zod";
import type { Env, UploadRow, Variables } from "./types";
import { all, audit, createJob, first } from "./db";
import { CHUNK_SIZE, MAX_PART_SIZE, addHours, clampPartSize, jsonError, nowIso, parseJson, safeFilename } from "./utils";
import { codecName, parseCid, putBlock, rawCid, verifyBlock } from "./ipfs";
import { currentProjectId, effectivePublication } from "./projects";

const createUploadSchema = z.object({
  name: z.string().min(1).max(255),
  size: z.number().int().min(0),
  mime: z.string().min(1).max(255).default("application/octet-stream"),
  mode: z.enum(["standard", "sealed"]).default("standard"),
  partSize: z.number().int().positive().optional(),
  metadata: z.record(z.string(), z.unknown()).default({})
});

const dagBlockSchema = z.object({
  cid: z.string().min(1),
  bytes: z.string().min(1)
});

const dagUploadSchema = z.object({ blocks: z.array(dagBlockSchema).max(512) });

const completeSchema = z.object({
  rootCid: z.string().min(1),
  pin: z.boolean().default(true),
  metadata: z.record(z.string(), z.unknown()).default({})
});

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function getUpload(env: Env, id: string, projectId: string): Promise<UploadRow | null> {
  return first<UploadRow>(env.DB.prepare("SELECT * FROM uploads WHERE id = ? AND project_id = ?").bind(id, projectId));
}

async function contentLinks(env: Env, projectId: string, cid: string): Promise<Record<string, unknown>> {
  const project = await first<{ slug: string }>(env.DB.prepare("SELECT slug FROM projects WHERE id = ?").bind(projectId));
  const publication = await first<{ status: string }>(env.DB.prepare("SELECT status FROM project_publications WHERE project_id = ? AND cid = ?").bind(projectId, cid));
  const effective = await effectivePublication(env, projectId, cid);
  const slug = project?.slug ?? "default";
  return {
    ipfsUri: `ipfs://${cid}`,
    canonicalGatewayUrl: `https://${env.GATEWAY_HOST}/${slug}/ipfs/${cid}`,
    visibility: effective?.public ? "public" : "private",
    replicationStatus: publication?.status ?? "private"
  };
}

async function acquireLock(env: Env, id: string): Promise<DurableObjectStub> {
  const stub = env.UPLOAD_LOCKS.get(env.UPLOAD_LOCKS.idFromName(id));
  const response = await stub.fetch("https://upload-lock/acquire", { method: "POST" });
  if (!response.ok) throw new Error("Upload is currently being modified by another request");
  return stub;
}

async function releaseLock(stub: DurableObjectStub): Promise<void> {
  await stub.fetch("https://upload-lock/release", { method: "POST" });
}

export async function createUpload(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<Response> {
  const parsed = createUploadSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(c, 400, "INVALID_UPLOAD", "Upload metadata is invalid", parsed.error.flatten());
  const input = parsed.data;
  const maxBytes = Number(c.env.MAX_UPLOAD_BYTES || 0);
  if (!Number.isSafeInteger(input.size) || input.size > maxBytes) {
    return jsonError(c, 413, "UPLOAD_TOO_LARGE", `Maximum upload size is ${maxBytes} bytes`);
  }
  const projectId = currentProjectId(c);
  const project = await first<{ quota_bytes: number; daily_upload_bytes: number }>(c.env.DB.prepare(
    "SELECT quota_bytes, daily_upload_bytes FROM projects WHERE id = ? AND state = 'active'"
  ).bind(projectId));
  if (!project) return jsonError(c, 404, "PROJECT_NOT_FOUND", "Active project does not exist");
  const storageLimit = Number(project.quota_bytes);
  const dailyLimit = Number(project.daily_upload_bytes);
  const [stored, active, daily] = await Promise.all([
    c.env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS bytes FROM pins WHERE project_id = ? AND status = 'pinned'").bind(projectId).first<{ bytes: number }>(),
    c.env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS bytes FROM uploads WHERE project_id = ? AND state IN ('created','uploading')").bind(projectId).first<{ bytes: number }>(),
    c.env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS bytes FROM uploads WHERE project_id = ? AND created_at >= ? AND state NOT IN ('failed','expired')")
      .bind(projectId, new Date(Date.now() - 86_400_000).toISOString()).first<{ bytes: number }>()
  ]);
  const reservedBytes = (stored?.bytes ?? 0) + (active?.bytes ?? 0);
  if (!Number.isSafeInteger(storageLimit) || storageLimit <= 0 || reservedBytes + input.size > storageLimit) {
    return jsonError(c, 507, "STORAGE_QUOTA_EXCEEDED", "This upload would exceed the configured private storage quota", { used: reservedBytes, limit: storageLimit });
  }
  if (!Number.isSafeInteger(dailyLimit) || dailyLimit <= 0 || (daily?.bytes ?? 0) + input.size > dailyLimit) {
    return jsonError(c, 429, "DAILY_UPLOAD_QUOTA_EXCEEDED", "This upload would exceed the configured 24-hour upload allowance", { used: daily?.bytes ?? 0, limit: dailyLimit });
  }

  const id = crypto.randomUUID();
  const partSize = clampPartSize(input.size, input.partSize);
  const partCount = Math.max(1, Math.ceil(input.size / partSize));
  if (partCount > 10_000) return jsonError(c, 413, "TOO_MANY_PARTS", "Upload requires more than 10,000 multipart parts");
  const objectKey = `projects/${projectId}/objects/${id}/${safeFilename(input.name)}`;
  const multipart = await c.env.OBJECTS.createMultipartUpload(objectKey, {
    httpMetadata: { contentType: input.mime },
    customMetadata: { uploadId: id, projectId, mode: input.mode }
  });
  const now = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO uploads
      (id, project_id, object_key, multipart_id, name, mime, size, chunk_size, part_size, part_count, mode, state, metadata_json, created_by_key_id, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?)`
  ).bind(
    id, projectId, objectKey, multipart.uploadId, input.name, input.mime, input.size, CHUNK_SIZE, partSize, partCount,
    input.mode, JSON.stringify(input.metadata), c.get("auth").keyId ?? null, now, now, addHours(new Date(), 24)
  ).run();
  const auth = c.get("auth");
  c.executionCtx.waitUntil(audit(c.env, auth.actor, "upload.create", id, { size: input.size, mode: input.mode }, c.req.header("CF-Connecting-IP"), projectId));
  return c.json({ id, state: "created", chunkSize: CHUNK_SIZE, partSize, partCount, expiresAt: addHours(new Date(), 24) }, 201);
}

export async function uploadPart(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<Response> {
  const id = c.req.param("id") ?? "";
  const partNumber = Number(c.req.param("part") ?? "");
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
    return jsonError(c, 400, "INVALID_PART", "Part number must be between 1 and 10,000");
  }
  try {
    const upload = await getUpload(c.env, id, currentProjectId(c));
    if (!upload) return jsonError(c, 404, "UPLOAD_NOT_FOUND", "Upload does not exist");
    if (!["created", "uploading"].includes(upload.state)) return jsonError(c, 409, "INVALID_UPLOAD_STATE", `Upload is ${upload.state}`);
    if (partNumber > upload.part_count) return jsonError(c, 400, "INVALID_PART", "Part number exceeds upload part count");

    const expectedLength = partNumber === upload.part_count
      ? upload.size - upload.part_size * (upload.part_count - 1)
      : upload.part_size;
    const contentLengthHeader = c.req.header("Content-Length");
    const contentLength = contentLengthHeader === undefined ? null : Number(contentLengthHeader);
    if (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength < 0)) {
      return jsonError(c, 400, "INVALID_CONTENT_LENGTH", "Content-Length is invalid");
    }
    if (contentLength !== null && contentLength > MAX_PART_SIZE) return jsonError(c, 413, "PART_TOO_LARGE", `Part exceeds ${MAX_PART_SIZE} bytes`);
    if (contentLength !== null && contentLength !== expectedLength) {
      return jsonError(c, 400, "PART_SIZE_MISMATCH", `Expected ${expectedLength} bytes but received ${contentLength}`);
    }

    const declared = parseJson<string[]>(c.req.header("X-Chunk-Cids"), []);
    const chunks: Array<{ cid: string; offset: number; length: number; index: number }> = [];
    const baseOffset = (partNumber - 1) * upload.part_size;
    const multipart = c.env.OBJECTS.resumeMultipartUpload(upload.object_key, upload.multipart_id);
    let uploaded: R2UploadedPart;
    if (expectedLength === 0) {
      const empty = new Uint8Array();
      const cid = await rawCid(empty);
      if (declared.length && declared[0] !== cid.toString()) {
        return jsonError(c, 422, "CHUNK_CID_MISMATCH", "Declared CID does not match empty file block");
      }
      await putBlock(c.env, cid, empty);
      chunks.push({ cid: cid.toString(), offset: baseOffset, length: 0, index: 0 });
      uploaded = await multipart.uploadPart(partNumber, empty);
    } else {
      if (!c.req.raw.body) return jsonError(c, 400, "PART_BODY_REQUIRED", "Upload part body is required");
      let received = 0;
      let logicalOffset = 0;
      let pending = new Uint8Array(upload.chunk_size);
      let pendingLength = 0;
      const commitChunk = async () => {
        if (!pendingLength) return;
        const data = pending.slice(0, pendingLength);
        const cid = await rawCid(data);
        const chunkIndex = Math.floor((baseOffset + logicalOffset) / upload.chunk_size);
        if (declared.length && declared[chunks.length] !== cid.toString()) {
          throw new Error(`Declared CID does not match chunk ${chunkIndex}`);
        }
        chunks.push({ cid: cid.toString(), offset: baseOffset + logicalOffset, length: data.length, index: chunkIndex });
        logicalOffset += data.length;
        pending = new Uint8Array(upload.chunk_size);
        pendingLength = 0;
      };
      const verifier = new TransformStream<Uint8Array, Uint8Array>({
        async transform(data, controller) {
          received += data.length;
          if (received > expectedLength) throw new Error(`Expected ${expectedLength} bytes but received more data`);
          let sourceOffset = 0;
          while (sourceOffset < data.length) {
            const length = Math.min(upload.chunk_size - pendingLength, data.length - sourceOffset);
            pending.set(data.subarray(sourceOffset, sourceOffset + length), pendingLength);
            pendingLength += length;
            sourceOffset += length;
            if (pendingLength === upload.chunk_size) await commitChunk();
          }
          controller.enqueue(data);
        },
        async flush() {
          if (received !== expectedLength) throw new Error(`Expected ${expectedLength} bytes but received ${received}`);
          await commitChunk();
        }
      });
      const fixedLength = new FixedLengthStream(expectedLength);
      const pipe = c.req.raw.body.pipeThrough(verifier).pipeTo(fixedLength.writable);
      const uploadPromise = multipart.uploadPart(partNumber, fixedLength.readable);
      [uploaded] = await Promise.all([uploadPromise, pipe.then(() => undefined)]);
    }
    const now = nowIso();
    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare("DELETE FROM upload_chunks WHERE upload_id = ? AND part_number = ?").bind(id, partNumber),
      c.env.DB.prepare("INSERT OR REPLACE INTO upload_parts (upload_id, part_number, etag, size, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(id, partNumber, uploaded.etag, expectedLength, now),
      c.env.DB.prepare("UPDATE uploads SET state = 'uploading', updated_at = ? WHERE id = ?").bind(now, id)
    ];
    for (const chunk of chunks) {
      statements.push(
        c.env.DB.prepare(
          "INSERT INTO upload_chunks (upload_id, cid, offset, length, part_number, chunk_index) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(id, chunk.cid, chunk.offset, chunk.length, partNumber, chunk.index),
        c.env.DB.prepare(
          "INSERT INTO blocks (cid, codec, size, r2_key, ref_count, created_at, last_accessed_at) VALUES (?, 'raw', ?, ?, 0, ?, ?) ON CONFLICT(cid) DO UPDATE SET last_accessed_at = excluded.last_accessed_at"
        ).bind(chunk.cid, chunk.length, `object:${upload.object_key}`, now, now),
        c.env.DB.prepare(
          "INSERT OR REPLACE INTO block_locations (cid, object_key, offset, length) VALUES (?, ?, ?, ?)"
        ).bind(chunk.cid, upload.object_key, chunk.offset, chunk.length)
      );
    }
    await c.env.DB.batch(statements);
    return c.json({ partNumber, etag: uploaded.etag, chunks });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Part upload failed";
    if (message.startsWith("Declared CID does not match")) return jsonError(c, 422, "CHUNK_CID_MISMATCH", message);
    if (message.startsWith("Expected ")) return jsonError(c, 400, "PART_SIZE_MISMATCH", message);
    return jsonError(c, 409, "UPLOAD_PART_FAILED", message);
  }
}

export async function uploadDag(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<Response> {
  const id = c.req.param("id") ?? "";
  const upload = await getUpload(c.env, id, currentProjectId(c));
  if (!upload) return jsonError(c, 404, "UPLOAD_NOT_FOUND", "Upload does not exist");
  const parsed = dagUploadSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(c, 400, "INVALID_DAG", "DAG block payload is invalid", parsed.error.flatten());
  let stored = 0;
  for (const item of parsed.data.blocks) {
    const cid = parseCid(item.cid);
    const bytes = decodeBase64(item.bytes);
    if (bytes.length > 2 * 1024 * 1024) return jsonError(c, 413, "DAG_BLOCK_TOO_LARGE", `Block ${cid} exceeds 2 MiB`);
    if (!(await verifyBlock(cid, bytes))) return jsonError(c, 422, "BLOCK_CID_MISMATCH", `Block ${cid} failed hash verification`);
    await putBlock(c.env, cid, bytes);
    stored += 1;
  }
  return c.json({ stored });
}

export async function completeUpload(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<Response> {
  const id = c.req.param("id") ?? "";
  const parsed = completeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(c, 400, "INVALID_COMPLETION", "Completion payload is invalid", parsed.error.flatten());
  if (!parsed.data.pin) return jsonError(c, 400, "PIN_REQUIRED", "Completed uploads must be verified and pinned before gateway access");
  let lock: DurableObjectStub | null = null;
  try {
    lock = await acquireLock(c.env, id);
    const projectId = currentProjectId(c);
    const upload = await getUpload(c.env, id, projectId);
    if (!upload) return jsonError(c, 404, "UPLOAD_NOT_FOUND", "Upload does not exist");
    if (["verifying", "pinned"].includes(upload.state) && upload.root_cid === parsed.data.rootCid) {
      return c.json({ id, rootCid: upload.root_cid, state: upload.state, idempotent: true, ...await contentLinks(c.env, projectId, upload.root_cid) }, upload.state === "pinned" ? 200 : 202);
    }
    if (!["created", "uploading"].includes(upload.state)) return jsonError(c, 409, "INVALID_UPLOAD_STATE", `Upload is ${upload.state}`);
    const completedRows = await all<{ part_number: number; etag: string }>(
      c.env.DB.prepare("SELECT part_number, etag FROM upload_parts WHERE upload_id = ? ORDER BY part_number").bind(id)
    );
    const completed = completedRows.map((part) => ({ partNumber: part.part_number, etag: part.etag }));
    if (completed.length !== upload.part_count) return jsonError(c, 409, "UPLOAD_INCOMPLETE", "Not all upload parts have been received");
    const root = parseCid(parsed.data.rootCid);
    const rootExists = await first<{ cid: string }>(c.env.DB.prepare("SELECT cid FROM blocks WHERE cid = ?").bind(root.toString()));
    if (!rootExists) return jsonError(c, 422, "ROOT_BLOCK_MISSING", "Root CID has not been uploaded");

    const multipart = c.env.OBJECTS.resumeMultipartUpload(upload.object_key, upload.multipart_id);
    await multipart.complete(completed);
    const now = nowIso();
    const existingPin = await first<{ request_id: string }>(c.env.DB.prepare("SELECT request_id FROM pins WHERE project_id = ? AND cid = ?").bind(projectId, root.toString()));
    const requestId = existingPin?.request_id ?? crypto.randomUUID();
    const metadata = { ...parseJson<Record<string, unknown>>(upload.metadata_json, {}), ...parsed.data.metadata };
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT OR REPLACE INTO objects (root_cid, object_key, size, mime, name, mode, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(root.toString(), upload.object_key, upload.size, upload.mime, upload.name, upload.mode, JSON.stringify(metadata), now),
      c.env.DB.prepare(
        `INSERT INTO project_objects (project_id, root_cid, object_key, size, mime, name, mode, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, root_cid) DO UPDATE SET object_key = excluded.object_key, size = excluded.size, mime = excluded.mime,
           name = excluded.name, mode = excluded.mode, metadata_json = excluded.metadata_json`
      ).bind(projectId, root.toString(), upload.object_key, upload.size, upload.mime, upload.name, upload.mode, JSON.stringify(metadata), now),
      c.env.DB.prepare("UPDATE uploads SET state = 'verifying', root_cid = ?, metadata_json = ?, updated_at = ? WHERE id = ?")
        .bind(root.toString(), JSON.stringify(metadata), now, id),
      c.env.DB.prepare(
        "INSERT INTO pins (request_id, project_id, cid, name, status, recursive, size, mode, metadata_json, created_by_key_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'pinning', 1, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, cid) DO UPDATE SET name = excluded.name, status = 'pinning', size = excluded.size, mode = excluded.mode, metadata_json = excluded.metadata_json, created_by_key_id = excluded.created_by_key_id, updated_at = excluded.updated_at"
      ).bind(requestId, projectId, root.toString(), upload.name, upload.size, upload.mode, JSON.stringify(metadata), upload.created_by_key_id, now, now)
    ]);
    const jobId = await createJob(c.env, "verify_pin", { cid: root.toString(), requestId, uploadId: id, projectId }, projectId);
    await c.env.JOBS.send({ id: jobId, type: "verify_pin", payload: { cid: root.toString(), requestId, uploadId: id, projectId } });
    const auth = c.get("auth");
    c.executionCtx.waitUntil(audit(c.env, auth.actor, "upload.complete", root.toString(), { uploadId: id, jobId }, c.req.header("CF-Connecting-IP"), projectId));
    return c.json({ id, rootCid: root.toString(), state: "verifying", jobId, ...await contentLinks(c.env, projectId, root.toString()) }, 202);
  } catch (error) {
    return jsonError(c, 409, "UPLOAD_COMPLETE_FAILED", error instanceof Error ? error.message : "Upload completion failed");
  } finally {
    if (lock) await releaseLock(lock);
  }
}

export async function getUploadStatus(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<Response> {
  const upload = await getUpload(c.env, c.req.param("id") ?? "", currentProjectId(c));
  if (!upload) return jsonError(c, 404, "UPLOAD_NOT_FOUND", "Upload does not exist");
  const parts = await all<{ part_number: number }>(
    c.env.DB.prepare("SELECT part_number FROM upload_parts WHERE upload_id = ? ORDER BY part_number").bind(upload.id)
  );
  return c.json({
    id: upload.id,
    name: upload.name,
    size: upload.size,
    state: upload.state,
    rootCid: upload.root_cid,
    completedParts: parts.map((part) => part.part_number),
    partCount: upload.part_count,
    expiresAt: upload.expires_at,
    error: upload.error,
    ...(upload.root_cid ? await contentLinks(c.env, upload.project_id, upload.root_cid) : {})
  });
}
