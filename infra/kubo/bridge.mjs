import http from "node:http";
import { createWriteStream, openAsBlob } from "node:fs";
import { unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { timingSafeEqual } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = Number(process.env.PORT || 8788);
const kubo = process.env.KUBO_API || "http://kubo:5001";
const token = process.env.BRIDGE_TOKEN || "";
const adminOrigin = process.env.ADMIN_ORIGIN || "";
const maxCarBytes = Number(process.env.MAX_CAR_BYTES || 536870912000);

function authorized(request) {
  const supplied = request.headers.authorization?.replace(/^Bearer /, "") || "";
  const left = Buffer.from(supplied); const right = Buffer.from(token);
  return token.length >= 32 && left.length === right.length && timingSafeEqual(left, right);
}

async function kuboPost(path, body) {
  const response = await fetch(new URL(path, kubo), { method: "POST", body, signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok) throw new Error(`Kubo ${path} returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return response;
}

async function peerId() {
  const response = await kuboPost("/api/v0/id");
  return String((await response.json()).ID || "");
}

async function importCar(cid, carUrl, carToken) {
  const source = new URL(carUrl);
  if (!adminOrigin || source.origin !== adminOrigin || source.protocol !== "https:" || !source.pathname.startsWith("/internal/replication/car/")) throw new Error("CAR source URL is not allowed");
  if (typeof carToken !== "string" || carToken.length < 32) throw new Error("CAR authorization token is missing");
  const response = await fetch(source, {
    headers: { Authorization: `OrbitCID-Replication ${carToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(10 * 60_000)
  });
  if (!response.ok || !response.body) throw new Error(`CAR source returned ${response.status}`);
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > maxCarBytes) throw new Error("CAR source exceeds the configured size limit");
  const path = join(tmpdir(), `orbitcid-${crypto.randomUUID()}.car`);
  try {
    let received = 0;
    const limited = Readable.fromWeb(response.body).map((chunk) => {
      received += chunk.length;
      if (received > maxCarBytes) throw new Error("CAR stream exceeds the configured size limit");
      return chunk;
    });
    await pipeline(limited, createWriteStream(path, { flags: "wx", mode: 0o600 }));
    const form = new FormData(); form.append("file", await openAsBlob(path, { type: "application/vnd.ipld.car" }), `${cid}.car`);
    const imported = await kuboPost("/api/v0/dag/import?pin-roots=true&allow-big-block=true", form);
    const output = await imported.text();
    if (!output.includes(cid)) throw new Error("Kubo import response did not contain the requested root CID");
    await kuboPost(`/api/v0/pin/add?recursive=true&arg=${encodeURIComponent(cid)}`);
  } finally { await unlink(path).catch(() => undefined); }
}

async function readJson(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 64 * 1024) throw new Error("Request body is too large"); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.url === "/healthz") { if (!authorized(request)) { response.writeHead(404); response.end("not found"); return; } response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify({ ok: true, peerId: await peerId() })); return; }
    if (request.method !== "POST" || request.url !== "/v1/pins") { response.writeHead(404); response.end("not found"); return; }
    if (!authorized(request)) { response.writeHead(401); response.end("unauthorized"); return; }
    const body = await readJson(request);
    if (!body.cid || !["pin", "unpin"].includes(body.action)) throw new Error("action and cid are required");
    if (body.action === "pin") { if (!body.carUrl) throw new Error("carUrl is required"); await importCar(String(body.cid), String(body.carUrl), body.carToken); }
    else await kuboPost(`/api/v0/pin/rm?arg=${encodeURIComponent(String(body.cid))}`);
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ ok: true, cid: body.cid, action: body.action, peerId: await peerId() }));
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : "bridge failure" }));
  }
});

server.listen(port, "0.0.0.0");
