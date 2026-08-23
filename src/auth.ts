import type { Context, MiddlewareHandler } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env, Variables, AuthContext } from "./types";
import { bytesToHex, jsonError, nowIso } from "./utils";
import { first } from "./db";
import { enforceRateLimit } from "./rate-limit";

interface AccessPayload {
  email?: string;
  common_name?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
}

const accessKeySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const ADMIN_SESSION_COOKIE = "__Host-orbitcid_admin_session";

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64UrlEncode(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
}

async function sessionHash(token: string, secret: string): Promise<string> {
  return hmac(`session:${token}`, secret);
}

async function verifySession(c: Context<{ Bindings: Env; Variables: Variables }>, token: string | null, email: string): Promise<boolean> {
  if (!token || !c.env.SESSION_SECRET) return false;
  const hash = await sessionHash(token, c.env.SESSION_SECRET);
  const row = await first<{ email: string; expires_at: string; revoked_at: string | null; user_agent_hash: string | null }>(c.env.DB.prepare(
    "SELECT email, expires_at, revoked_at, user_agent_hash FROM admin_sessions WHERE session_hash = ?"
  ).bind(hash));
  if (!row || row.revoked_at || row.email.toLowerCase() !== email.toLowerCase() || Date.parse(row.expires_at) <= Date.now()) return false;
  const userAgent = c.req.header("User-Agent") ?? "";
  if (row.user_agent_hash && (!userAgent || !constantTimeEqual(row.user_agent_hash, await tokenHash(userAgent, c.env.SESSION_SECRET)))) return false;
  c.executionCtx.waitUntil(c.env.DB.prepare("UPDATE admin_sessions SET last_seen_at = ? WHERE session_hash = ?").bind(nowIso(), hash).run());
  return true;
}

async function createSession(c: Context<{ Bindings: Env; Variables: Variables }>, email: string): Promise<string> {
  if (!c.env.SESSION_SECRET) throw new Error("SESSION_SECRET is not configured");
  const token = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  const userAgent = c.req.header("User-Agent") ?? "";
  const userAgentHash = userAgent ? await tokenHash(userAgent, c.env.SESSION_SECRET) : null;
  await c.env.DB.prepare(
    "INSERT INTO admin_sessions (session_hash, email, created_at, expires_at, last_seen_at, user_agent_hash) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(await sessionHash(token, c.env.SESSION_SECRET), email.toLowerCase(), createdAt, expiresAt, createdAt, userAgentHash).run();
  return token;
}

async function verifiedAccessPayload(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<AccessPayload | null> {
  const accessToken = c.req.header("CF-Access-Jwt-Assertion");
  if (!accessToken) return null;
  if (!c.env.ACCESS_TEAM_DOMAIN || !c.env.ACCESS_AUD) return null;
  let payload: AccessPayload | null = null;
  try {
    const teamDomain = c.env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const certsUrl = `https://${teamDomain}/cdn-cgi/access/certs`;
    let keySet = accessKeySets.get(certsUrl);
    if (!keySet) {
      keySet = createRemoteJWKSet(new URL(certsUrl));
      accessKeySets.set(certsUrl, keySet);
    }
    const verified = await jwtVerify(accessToken, keySet, {
      audience: c.env.ACCESS_AUD,
      issuer: `https://${teamDomain}`
    });
    payload = verified.payload as AccessPayload;
  } catch {
    return null;
  }
  const audiences = Array.isArray(payload?.aud) ? payload.aud : payload?.aud ? [payload.aud] : [];
  const validAudience = !c.env.ACCESS_AUD || audiences.includes(c.env.ACCESS_AUD);
  const validExpiry = !payload?.exp || payload.exp * 1000 > Date.now();
  return payload && validAudience && validExpiry ? payload : null;
}

export async function accessIdentity(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<string | null> {
  const payload = await verifiedAccessPayload(c);
  if (c.env.ENVIRONMENT === "production" && !c.env.ALLOWED_EMAIL) return null;
  const validEmail = !!payload?.email && (!c.env.ALLOWED_EMAIL || payload.email.toLowerCase() === c.env.ALLOWED_EMAIL.toLowerCase());
  return validEmail ? payload.email! : null;
}

async function accessServicePrincipal(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<string | null> {
  const payload = await verifiedAccessPayload(c);
  if (!payload) return null;
  if (payload.email) {
    if (c.env.ENVIRONMENT === "production" && !c.env.ALLOWED_EMAIL) return null;
    return !c.env.ALLOWED_EMAIL || payload.email.toLowerCase() === c.env.ALLOWED_EMAIL.toLowerCase() ? payload.email : null;
  }
  return payload.common_name ?? payload.sub ?? null;
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, iterationText, saltText, expectedText] = encoded.split("$");
  if (algorithm !== "pbkdf2-sha256" || !iterationText || !saltText || !expectedText) return false;
  const iterations = Number(iterationText);
  if (!Number.isInteger(iterations) || iterations < 100_000) return false;
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = base64UrlDecode(saltText);
  const saltCopy = new Uint8Array(salt.byteLength);
  saltCopy.set(salt);
  const actual = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: saltCopy, iterations }, material, 256));
  const expected = base64UrlDecode(expectedText);
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) difference |= actual[index]! ^ expected[index]!;
  return difference === 0;
}

async function tokenHash(token: string, pepper: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${token}:${pepper}`));
  return bytesToHex(new Uint8Array(digest));
}

async function authenticateProjectKey(c: Context<{ Bindings: Env; Variables: Variables }>, token: string): Promise<AuthContext | null> {
  if (!token.startsWith("orbitcid_proj_")) return null;
  const parts = token.split("_");
  if (parts.length < 4) return null;
  const prefix = parts[2];
  const row = await first<{
    id: string;
    project_id: string;
    project_slug: string;
    secret_hash: string;
    scopes_json: string;
    expires_at: string | null;
    revoked_at: string | null;
  }>(c.env.DB.prepare(
    `SELECT project_api_keys.id, project_api_keys.project_id, projects.slug AS project_slug,
            project_api_keys.secret_hash, project_api_keys.scopes_json,
            project_api_keys.expires_at, project_api_keys.revoked_at
     FROM project_api_keys JOIN projects ON projects.id = project_api_keys.project_id
     WHERE project_api_keys.prefix = ?`
  ).bind(prefix));
  if (!row || row.revoked_at || (row.expires_at && Date.parse(row.expires_at) <= Date.now())) return null;
  const pepper = c.env.PROJECT_KEY_PEPPER;
  if (!pepper) return null;
  const actual = await tokenHash(token, pepper);
  if (!constantTimeEqual(actual, row.secret_hash)) return null;
  c.executionCtx.waitUntil(c.env.DB.prepare("UPDATE project_api_keys SET last_used_at = ? WHERE id = ?").bind(nowIso(), row.id).run());
  return { actor: `project-key:${row.id}`, method: "project_key", scopes: JSON.parse(row.scopes_json) as string[], projectId: row.project_id, keyId: row.id };
}

export const authMiddleware: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  const authorization = c.req.header("Authorization");
  if (authorization?.startsWith("Bearer ")) {
    const key = await authenticateProjectKey(c, authorization.slice(7));
    if (key) {
      const machineRoute = c.req.path.startsWith("/api/v1/p/") || c.req.path.startsWith("/api/v0/");
      if (!machineRoute) return jsonError(c, 403, "PROJECT_ROUTE_REQUIRED", "Project API keys are accepted only on project machine routes or the Kubo facade");
      c.set("auth", key);
      await next();
      return;
    }
  }

  const email = await accessIdentity(c);
  if (email) {
    if (c.env.ENVIRONMENT === "production" && (!c.env.ADMIN_PASSWORD_HASH || !c.env.SESSION_SECRET)) {
      return jsonError(c, 503, "PASSWORD_AUTH_NOT_CONFIGURED", "Production requires ADMIN_PASSWORD_HASH and SESSION_SECRET");
    }
    const passwordEnabled = !!c.env.ADMIN_PASSWORD_HASH;
    const sessionValid = !passwordEnabled || await verifySession(c, cookieValue(c.req.header("Cookie"), ADMIN_SESSION_COOKIE), email);
    if (sessionValid) {
      c.set("auth", { actor: email, method: "access", scopes: ["read", "write", "pin", "manage", "export"] });
      await next();
      return;
    }
    return jsonError(c, 401, "PASSWORD_SESSION_REQUIRED", "Admin password verification is required");
  }

  return jsonError(c, 401, "AUTH_REQUIRED", "Cloudflare Access or a valid project API key is required");
};

export function requireScope(scope: string): MiddlewareHandler<{ Bindings: Env; Variables: Variables }> {
  return async (c, next) => {
    const auth = c.get("auth");
    if (!auth.scopes.includes(scope) && !auth.scopes.includes("manage")) {
      return jsonError(c, 403, "SCOPE_REQUIRED", `The ${scope} scope is required`);
    }
    await next();
  };
}

export const csrfMiddleware: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    await next();
    return;
  }
  if (c.get("auth")?.method === "project_key") {
    await next();
    return;
  }
  const origin = c.req.header("Origin");
  const expected = c.env.DASHBOARD_ORIGIN ?? c.env.APP_ORIGIN;
  if (!expected) return jsonError(c, 503, "DASHBOARD_ORIGIN_NOT_CONFIGURED", "DASHBOARD_ORIGIN or APP_ORIGIN must be configured");
  if (!origin || origin !== expected) return jsonError(c, 403, "INVALID_ORIGIN", "A same-origin browser request is required");
  await next();
};

export async function hashPatForStorage(token: string, pepper: string): Promise<string> {
  return tokenHash(token, pepper);
}

export async function hashProjectKeyForStorage(token: string, pepper: string): Promise<string> {
  return tokenHash(token, pepper);
}

export async function loginWithPassword(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<Response> {
  const blocked = await enforceRateLimit(c, "admin-login", Number(c.env.LOGIN_RATE_LIMIT_PER_15_MINUTES ?? 10), 15 * 60);
  if (blocked) return blocked;
  const email = await accessIdentity(c);
  if (!email) return jsonError(c, 401, "GOOGLE_LOGIN_REQUIRED", "Sign in through Cloudflare Access with the allowed Google account");
  if (!c.env.ADMIN_PASSWORD_HASH || !c.env.SESSION_SECRET) {
    return jsonError(c, 503, "PASSWORD_AUTH_NOT_CONFIGURED", "ADMIN_PASSWORD_HASH and SESSION_SECRET must be configured as secrets");
  }
  const body = await c.req.json<{ password?: string }>().catch(() => ({ password: undefined }));
  if (!body.password || !(await verifyPassword(body.password, c.env.ADMIN_PASSWORD_HASH))) {
    return jsonError(c, 401, "INVALID_ADMIN_PASSWORD", "Admin password is incorrect");
  }
  const session = await createSession(c, email);
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append("Set-Cookie", `${ADMIN_SESSION_COOKIE}=${session}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`);
  return new Response(JSON.stringify({ authenticated: true, email, expiresIn: 43_200 }), { status: 200, headers });
}

export async function logoutAdmin(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<Response> {
  const token = cookieValue(c.req.header("Cookie"), ADMIN_SESSION_COOKIE);
  if (token && c.env.SESSION_SECRET) {
    await c.env.DB.prepare("UPDATE admin_sessions SET revoked_at = ? WHERE session_hash = ?")
      .bind(nowIso(), await sessionHash(token, c.env.SESSION_SECRET)).run();
  }
  return new Response(JSON.stringify({ authenticated: false }), {
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `${ADMIN_SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`
    }
  });
}
