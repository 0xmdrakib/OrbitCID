import http from "node:http";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GrantVerifier } from "../../backend/grant-auth.mjs";
import { R2BackupManager } from "../../backend/r2-backup.mjs";

const port = Number(process.env.PORT || 8788);
const kubo = process.env.KUBO_API || "http://kubo:5001";
const kuboGateway = process.env.KUBO_GATEWAY || "http://kubo:8080";
const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES || 536870912000);
const pairingPath = process.env.PAIRING_CONFIG_PATH || "/var/lib/orbitcid/pairing.json";

function loadPairing() {
  try {
    const value = JSON.parse(readFileSync(pairingPath, "utf8"));
    if (value.version !== 1 || !value.connectionId || !value.ownerId || !value.issuer || !value.frontendOrigin || !Array.isArray(value.grantKeys)) {
      throw new Error("pairing config fields are invalid");
    }
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Could not load pairing configuration: ${error instanceof Error ? error.message : "invalid file"}`);
  }
}

const pairing = loadPairing();
const grantVerifier = pairing ? new GrantVerifier(pairing) : null;
const backupManager = pairing ? new R2BackupManager(pairing, { kuboApi: kubo }) : null;
const rateWindows = new Map();

function tenantAuthorized(request, requiredScope, consume = false) {
  if (!pairing || !grantVerifier) return null;
  const supplied = request.headers.authorization?.replace(/^Bearer /, "") || "";
  const payload = grantVerifier.authorize(supplied, requiredScope, { consume });
  if (!payload) return null;
  const origin = request.headers.origin;
  if (origin && origin !== pairing.frontendOrigin) return null;

  const rateKey = `${payload.sub}:${request.socket.remoteAddress || "unknown"}`;
  const minute = Math.floor(Date.now() / 60_000);
  const current = rateWindows.get(rateKey);
  if (current?.minute === minute && current.count >= 300) return null;
  rateWindows.set(rateKey, { minute, count: current?.minute === minute ? current.count + 1 : 1 });
  return payload;
}

function corsHeaders(request) {
  if (!pairing || request.headers.origin !== pairing.frontendOrigin) return {};
  return {
    "access-control-allow-origin": pairing.frontendOrigin,
    "access-control-expose-headers": "content-length, content-range, etag, x-orbitcid-peer-id",
    vary: "Origin"
  };
}

function json(response, status, body, request) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...corsHeaders(request)
  });
  response.end(JSON.stringify(body));
}

async function kuboPost(path, body, headers) {
  const response = await fetch(new URL(path, kubo), {
    method: "POST",
    body,
    headers,
    duplex: body ? "half" : undefined,
    signal: AbortSignal.timeout(10 * 60_000)
  });
  if (!response.ok) throw new Error(`Kubo ${path} returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return response;
}

async function nodeStatus() {
  const [identityResponse, peersResponse] = await Promise.all([
    kuboPost("/api/v0/id"),
    kuboPost("/api/v0/swarm/peers?verbose=false")
  ]);
  const identity = await identityResponse.json();
  const peers = await peersResponse.json();
  return { peerId: String(identity.ID || ""), peers: Array.isArray(peers.Peers) ? peers.Peers.length : 0 };
}

function validCid(value) {
  return /^[A-Za-z0-9]{20,120}$/.test(value);
}

async function readJson(request, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function proxyGateway(request, response) {
  const requested = new URL(request.url || "/", "http://agent.invalid");
  const match = requested.pathname.match(/^\/v1\/ipfs\/([A-Za-z0-9]+)(\/.*)?$/);
  if (!match || !validCid(match[1])) {
    response.writeHead(404);
    response.end("not found");
    return;
  }
  const segments = (match[2] || "").split("/").filter(Boolean).map((segment) => {
    const decoded = decodeURIComponent(segment);
    if (!decoded || decoded === "." || decoded === ".." || decoded.includes("\\") || decoded.includes("\0")) throw new Error("Gateway path is invalid");
    return encodeURIComponent(decoded);
  });
  const target = new URL(`/ipfs/${match[1]}${segments.length ? `/${segments.join("/")}` : ""}`, kuboGateway);
  const headers = new Headers();
  for (const name of ["range", "if-none-match", "if-modified-since"]) {
    const value = request.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }
  const upstream = await fetch(target, { method: request.method, headers, redirect: "error", signal: AbortSignal.timeout(10 * 60_000) });
  const outputHeaders = {
    "cache-control": "private, no-store",
    "content-security-policy": "sandbox; default-src 'none'",
    "x-content-type-options": "nosniff",
    ...corsHeaders(request)
  };
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const value = upstream.headers.get(name);
    if (value) outputHeaders[name] = value;
  }
  response.writeHead(upstream.status, outputHeaders);
  if (request.method === "HEAD" || !upstream.body) return response.end();
  await pipeline(Readable.fromWeb(upstream.body), response);
}

async function proxyAdd(request, response) {
  const contentType = request.headers["content-type"] || "";
  if (!contentType.startsWith("multipart/form-data;")) return json(response, 415, { error: "multipart/form-data is required" }, request);
  const declared = Number(request.headers["content-length"] || 0);
  if (declared > maxUploadBytes) return json(response, 413, { error: "upload exceeds configured limit" }, request);
  let received = 0;
  const limited = Readable.from(request).map((chunk) => {
    received += chunk.length;
    if (received > maxUploadBytes) throw new Error("Upload stream exceeds configured limit");
    return chunk;
  });
  const upstream = await kuboPost(
    "/api/v0/add?cid-version=1&raw-leaves=true&hash=sha2-256&chunker=size-1048576&pin=true&progress=false",
    limited,
    { "content-type": contentType }
  );
  response.writeHead(200, { "content-type": upstream.headers.get("content-type") || "application/x-ndjson", "cache-control": "no-store", ...corsHeaders(request) });
  if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response);
  else response.end();
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") {
      if (!pairing || request.headers.origin !== pairing.frontendOrigin) {
        response.writeHead(403);
        response.end();
        return;
      }
      response.writeHead(204, {
        ...corsHeaders(request),
        "access-control-allow-methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
        "access-control-allow-headers": "authorization, content-type, range",
        "access-control-max-age": "600"
      });
      response.end();
      return;
    }
    if (request.url === "/healthz" && request.method === "GET") {
      await kuboPost("/api/v0/id");
      return json(response, 200, { ok: true, paired: Boolean(pairing) }, request);
    }
    if (request.url === "/v1/tenant/health" && request.method === "GET") {
      if (!tenantAuthorized(request, "read")) return json(response, 401, { error: "unauthorized" }, request);
      return json(response, 200, { ok: true, ...(await nodeStatus()), connectionId: pairing.connectionId }, request);
    }
    if (["GET", "HEAD"].includes(request.method || "") && request.url?.startsWith("/v1/ipfs/")) {
      if (!tenantAuthorized(request, "read")) return json(response, 401, { error: "unauthorized" }, request);
      await proxyGateway(request, response);
      return;
    }
    if (request.method === "POST" && request.url === "/v1/ipfs/add") {
      if (!tenantAuthorized(request, "write", true)) return json(response, 401, { error: "unauthorized" }, request);
      await proxyAdd(request, response);
      return;
    }
    if (request.method === "GET" && request.url === "/v1/pins") {
      if (!tenantAuthorized(request, "read")) return json(response, 401, { error: "unauthorized" }, request);
      const upstream = await kuboPost("/api/v0/pin/ls?type=recursive");
      return json(response, 200, await upstream.json(), request);
    }
    if (request.method === "POST" && request.url === "/v1/pins") {
      if (!tenantAuthorized(request, "pin", true)) return json(response, 401, { error: "unauthorized" }, request);
      const body = await readJson(request);
      if (!validCid(String(body.cid || "")) || !["pin", "unpin"].includes(body.action)) throw new Error("A valid action and CID are required");
      const argument = encodeURIComponent(String(body.cid));
      const endpoint = body.action === "pin" ? `/api/v0/pin/add?recursive=true&arg=${argument}` : `/api/v0/pin/rm?arg=${argument}`;
      await kuboPost(endpoint);
      return json(response, 200, { ok: true, cid: body.cid, action: body.action }, request);
    }
    if (request.url === "/v1/backup/r2" && request.method === "GET") {
      if (!tenantAuthorized(request, "backup")) return json(response, 401, { error: "unauthorized" }, request);
      return json(response, 200, await backupManager.status(), request);
    }
    if (request.url === "/v1/backup/r2" && request.method === "PUT") {
      if (!tenantAuthorized(request, "backup", true)) return json(response, 401, { error: "unauthorized" }, request);
      return json(response, 200, await backupManager.save(await readJson(request, 16 * 1024)), request);
    }
    if (request.url === "/v1/backup/r2" && request.method === "DELETE") {
      if (!tenantAuthorized(request, "backup", true)) return json(response, 401, { error: "unauthorized" }, request);
      return json(response, 200, await backupManager.remove(), request);
    }
    if (request.url === "/v1/backup/r2/run" && request.method === "POST") {
      if (!tenantAuthorized(request, "backup", true)) return json(response, 401, { error: "unauthorized" }, request);
      const result = await backupManager.start();
      return json(response, result.accepted ? 202 : 409, result, request);
    }
    response.writeHead(404, { "cache-control": "no-store" });
    response.end("not found");
  } catch (error) {
    if (response.headersSent) return response.destroy(error instanceof Error ? error : undefined);
    json(response, 500, { error: error instanceof Error ? error.message : "backend failure" }, request);
  }
});

server.listen(port, "0.0.0.0");
