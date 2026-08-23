import { CID } from "multiformats/cid";
import * as dagPb from "@ipld/dag-pb";
import { UnixFS } from "ipfs-unixfs";
import type { Context } from "hono";
import type { Env, ObjectRow, Variables } from "./types";
import { first } from "./db";
import { getBlock, parseCid, resolveUnixFs } from "./ipfs";
import { jsonError, normalizePath, safeFilename } from "./utils";
import { projectHasPinnedCid, publicProjectForCid, recordProjectUsage } from "./projects";

interface GatewayOptions {
  projectId?: string;
  publicOnly?: boolean;
}

async function findObject(env: Env, projectId: string, cid: string): Promise<ObjectRow | null> {
  const owned = await first<ObjectRow>(env.DB.prepare("SELECT root_cid, object_key, size, mime, name, mode, metadata_json, created_at FROM project_objects WHERE project_id = ? AND root_cid = ?").bind(projectId, cid));
  if (owned) return owned;
  const shared = await first<ObjectRow>(env.DB.prepare("SELECT * FROM objects WHERE root_cid = ?").bind(cid));
  return shared ? { ...shared, mime: "application/octet-stream", name: `${cid}.bin`, mode: "standard", metadata_json: "{}" } : null;
}

function securityHeaders(headers: Headers, mime: string, cid: string, isPublic = false): void {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cross-Origin-Resource-Policy", isPublic ? "cross-origin" : "same-site");
  if (isPublic) headers.set("Access-Control-Allow-Origin", "*");
  headers.set("ETag", `"${cid}"`);
  headers.set("Cache-Control", `${isPublic ? "public" : "private"}, max-age=31536000, immutable`);
  if (mime.includes("html") || mime.includes("svg")) {
    headers.set("Content-Security-Policy", "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'");
  }
}

async function directObjectResponse(request: Request, env: Env, object: ObjectRow, cid: string, isPublic: boolean): Promise<Response> {
  const responseMime = object.mode === "sealed" ? "application/octet-stream" : object.mime;
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch?.split(",").some((value) => value.trim() === `"${cid}"` || value.trim() === "*")) {
    const headers = new Headers();
    securityHeaders(headers, responseMime, cid, isPublic);
    return new Response(null, { status: 304, headers });
  }
  if (request.method === "HEAD") {
    const head = await env.OBJECTS.head(object.object_key);
    if (!head) return new Response("Not found", { status: 404 });
    const headers = new Headers({
      "Content-Type": responseMime,
      "Content-Length": String(head.size),
      "Content-Disposition": `inline; filename="${safeFilename(object.name)}"`
    });
    securityHeaders(headers, responseMime, cid, isPublic);
    return new Response(null, { status: 200, headers });
  }
  const rangeRequested = request.headers.has("Range");
  const stored = rangeRequested
    ? await env.OBJECTS.get(object.object_key, { range: request.headers })
    : await env.OBJECTS.get(object.object_key);
  if (!stored) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  stored.writeHttpMetadata(headers);
  headers.set("Content-Type", responseMime);
  headers.set("Content-Disposition", `inline; filename="${safeFilename(object.name)}"`);
  headers.set("Accept-Ranges", "bytes");
  if (rangeRequested && stored.range) {
    const offset = "offset" in stored.range && stored.range.offset !== undefined ? stored.range.offset : 0;
    const length = "length" in stored.range && stored.range.length !== undefined ? stored.range.length : stored.size;
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("Content-Length", String(length));
  } else {
    headers.set("Content-Length", String(stored.size));
  }
  securityHeaders(headers, responseMime, cid, isPublic);
  return new Response(stored.body, { status: rangeRequested && stored.range ? 206 : 200, headers });
}

function unixfsStream(env: Env, root: CID): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const visit = async (cid: CID): Promise<void> => {
          const block = await getBlock(env, cid);
          if (!block) throw new Error(`Missing block ${cid}`);
          if (cid.code !== dagPb.code) {
            controller.enqueue(block.bytes);
            return;
          }
          const node = dagPb.decode(block.bytes);
          const unixfs = node.Data ? UnixFS.unmarshal(node.Data) : null;
          if (unixfs?.data?.length) controller.enqueue(unixfs.data);
          for (const link of node.Links) await visit(link.Hash);
        };
        await visit(root);
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    }
  });
}

function trackedStream(c: Context<{ Bindings: Env; Variables: Variables }>, projectId: string, stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let bytes = 0;
  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
    flush() {
      c.executionCtx.waitUntil(recordProjectUsage(c.env, projectId, c.req.method === "HEAD" ? 0 : bytes));
    }
  }));
}

function trackResponse(c: Context<{ Bindings: Env; Variables: Variables }>, projectId: string, bytes: number, error = false): void {
  c.executionCtx.waitUntil(recordProjectUsage(c.env, projectId, c.req.method === "HEAD" ? 0 : bytes, error));
}

export async function gatewayResponse(c: Context<{ Bindings: Env; Variables: Variables }>, cidValue: string, rawPath: string, options: GatewayOptions = {}): Promise<Response> {
  let root: CID;
  let path: string;
  try {
    root = parseCid(cidValue);
    path = normalizePath(rawPath);
  } catch {
    return jsonError(c, 400, "INVALID_IPFS_PATH", "CID or path is invalid");
  }
  let projectId = options.projectId;
  if (!projectId && options.publicOnly) {
    projectId = await publicProjectForCid(c.env, root.toString()) ?? undefined;
  }
  projectId ??= c.get("projectId") ?? "default";
  if (options.publicOnly) {
    if (!(await publicProjectForCid(c.env, root.toString(), projectId))) return jsonError(c, 404, "IPFS_NOT_FOUND", "Content is not publicly available");
  }
  if (!(await projectHasPinnedCid(c.env, projectId, root.toString()))) {
    return jsonError(c, 404, "IPFS_NOT_PINNED", "Content is unavailable until its verified pin is committed");
  }
  const segments = path.split("/").filter(Boolean);
  try {
    const resolved = await resolveUnixFs(c.env, root, segments);
    const ifNoneMatch = c.req.header("If-None-Match");
    if (ifNoneMatch?.split(",").some((value) => value.trim() === `"${resolved.cid}"` || value.trim() === "*")) {
      const headers = new Headers();
      securityHeaders(headers, "application/octet-stream", resolved.cid.toString(), !!options.publicOnly);
      return new Response(null, { status: 304, headers });
    }
    if (resolved.type === "directory") {
      const block = await getBlock(c.env, resolved.cid);
      if (!block) {
        const fallback = await kuboFallbackResponse(c, root.toString(), path, !!options.publicOnly);
        return fallback ?? jsonError(c, 404, "BLOCK_NOT_FOUND", "Directory block is missing");
      }
      const node = dagPb.decode(block.bytes);
      const body = JSON.stringify({ cid: resolved.cid.toString(), type: "directory", entries: node.Links.map((link) => ({ name: link.Name, cid: link.Hash.toString(), size: Number(link.Tsize ?? 0) })) });
      const headers = new Headers({ "Content-Type": "application/json; charset=UTF-8" });
      securityHeaders(headers, "application/json", resolved.cid.toString(), !!options.publicOnly);
      headers.set("Content-Length", String(new TextEncoder().encode(body).byteLength));
      trackResponse(c, projectId, headers.get("Content-Length") ? Number(headers.get("Content-Length")) : 0);
      return new Response(c.req.method === "HEAD" ? null : body, { headers });
    }
    const object = await findObject(c.env, projectId, resolved.cid.toString());
    if (object) {
      let response: Response;
      try {
        response = await directObjectResponse(c.req.raw, c.env, object, resolved.cid.toString(), !!options.publicOnly);
      } catch {
        const fallback = await kuboFallbackResponse(c, root.toString(), path, !!options.publicOnly);
        if (fallback) { trackResponse(c, projectId, Number(fallback.headers.get("Content-Length") ?? 0)); return fallback; }
        throw new Error("Primary object storage and Kubo fallback are unavailable");
      }
      if (response.status === 404) {
        const fallback = await kuboFallbackResponse(c, root.toString(), path, !!options.publicOnly);
        if (fallback) { trackResponse(c, projectId, Number(fallback.headers.get("Content-Length") ?? 0)); return fallback; }
      }
      trackResponse(c, projectId, response.ok ? Number(response.headers.get("Content-Length") ?? object.size) : 0, !response.ok);
      return response;
    }
    if (resolved.inlineData) {
      const headers = new Headers({ "Content-Type": "application/octet-stream", "Content-Length": String(resolved.inlineData.length) });
      securityHeaders(headers, "application/octet-stream", resolved.cid.toString(), !!options.publicOnly);
      const body = c.req.method === "HEAD" ? null : new Uint8Array(resolved.inlineData).buffer;
      trackResponse(c, projectId, resolved.inlineData.length);
      return new Response(body, { headers });
    }
    const headers = new Headers({ "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${resolved.cid}.bin"` });
    securityHeaders(headers, "application/octet-stream", resolved.cid.toString(), !!options.publicOnly);
    if (c.req.method === "HEAD") {
      trackResponse(c, projectId, 0);
      return new Response(null, { headers });
    }
    return new Response(trackedStream(c, projectId, unixfsStream(c.env, resolved.cid)), { headers });
  } catch (error) {
    const fallback = await kuboFallbackResponse(c, root.toString(), path, !!options.publicOnly);
    if (fallback) {
      trackResponse(c, projectId, Number(fallback.headers.get("Content-Length") ?? 0));
      return fallback;
    }
    if (projectId) trackResponse(c, projectId, 0, true);
    return jsonError(c, 404, "IPFS_NOT_FOUND", error instanceof Error ? error.message : "Content was not found");
  }
}

async function kuboFallbackResponse(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  cid: string,
  path: string,
  isPublic: boolean
): Promise<Response | null> {
  const segments = path.split("/").filter(Boolean).map((segment) => encodeURIComponent(segment));
  const candidates = [
    { id: "primary", url: c.env.KUBO_NODE_PRIMARY_URL, token: c.env.KUBO_NODE_PRIMARY_TOKEN },
    { id: "secondary", url: c.env.KUBO_NODE_SECONDARY_URL, token: c.env.KUBO_NODE_SECONDARY_TOKEN }
  ];
  for (const node of candidates) {
    if (!node.url || !node.token) continue;
    const url = new URL(`/v1/ipfs/${encodeURIComponent(cid)}${segments.length ? `/${segments.join("/")}` : ""}`, node.url);
    const requestHeaders = new Headers({ Authorization: `Bearer ${node.token}` });
    for (const name of ["Range", "If-None-Match", "If-Modified-Since"]) {
      const value = c.req.header(name);
      if (value) requestHeaders.set(name, value);
    }
    let upstream: Response;
    try {
      upstream = await fetch(url, { method: c.req.method, headers: requestHeaders, redirect: "error", signal: AbortSignal.timeout(10 * 60_000) });
    } catch {
      continue;
    }
    if (!upstream.ok && ![206, 304].includes(upstream.status)) continue;
    const headers = new Headers();
    for (const name of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set("X-OrbitCID-Source", `kubo-${node.id}`);
    securityHeaders(headers, headers.get("Content-Type") ?? "application/octet-stream", cid, isPublic);
    return new Response(c.req.method === "HEAD" || upstream.status === 304 ? null : upstream.body, { status: upstream.status, headers });
  }
  return null;
}
