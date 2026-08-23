import type { Env } from "./types";
import { bytesToBase64 } from "./utils";

export interface ReplicationTicket {
  projectId: string;
  cid: string;
  exp: number;
}

function base64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function signature(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
}

function equal(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export async function createReplicationTicket(env: Env, projectId: string, cid: string): Promise<string> {
  if (!env.REPLICATION_SIGNING_SECRET) throw new Error("REPLICATION_SIGNING_SECRET is not configured");
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({ projectId, cid, exp: Date.now() + 15 * 60_000 } satisfies ReplicationTicket)));
  return `${payload}.${await signature(payload, env.REPLICATION_SIGNING_SECRET)}`;
}

export async function verifyReplicationTicket(env: Env, ticket: string, cid: string): Promise<ReplicationTicket | null> {
  if (!env.REPLICATION_SIGNING_SECRET) return null;
  const [payload, supplied] = ticket.split(".");
  if (!payload || !supplied || !equal(await signature(payload, env.REPLICATION_SIGNING_SECRET), supplied)) return null;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const parsed = JSON.parse(atob(normalized)) as ReplicationTicket;
    return parsed.cid === cid && parsed.exp > Date.now() ? parsed : null;
  } catch {
    return null;
  }
}
