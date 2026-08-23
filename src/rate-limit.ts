import type { Context, MiddlewareHandler } from "hono";
import type { Env, Variables } from "./types";
import { jsonError } from "./utils";

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function enforceRateLimit(
  c: AppContext,
  bucket: string,
  limit: number,
  windowSeconds: number
): Promise<Response | null> {
  if (!Number.isFinite(limit) || limit < 1) return null;
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const key = await digest(`${bucket}:${ip}`);
  const id = c.env.SECURITY_GATE.idFromName(key);
  const response = await c.env.SECURITY_GATE.get(id).fetch("https://security-gate/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ limit, windowSeconds })
  });
  if (response.ok) return null;
  const retryAfter = response.headers.get("Retry-After") ?? String(windowSeconds);
  const blocked = jsonError(c, 429, "RATE_LIMITED", "Too many requests; retry after the indicated delay");
  blocked.headers.set("Retry-After", retryAfter);
  return blocked;
}

export function mutationRateLimit(): MiddlewareHandler<{ Bindings: Env; Variables: Variables }> {
  return async (c, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
    if (c.req.path === "/api/v1/session/login") return next();
    const limit = Number(c.env.MUTATION_RATE_LIMIT_PER_MINUTE ?? 120);
    const blocked = await enforceRateLimit(c, `mutation:${c.get("auth")?.actor ?? "anonymous"}`, limit, 60);
    if (blocked) return blocked;
    return next();
  };
}

export function publicGatewayRateLimit(project: string): MiddlewareHandler<{ Bindings: Env; Variables: Variables }> {
  return async (c, next) => {
    const limit = Number(c.env.PUBLIC_GATEWAY_RATE_PER_MINUTE ?? 600);
    const blocked = await enforceRateLimit(c, `gateway:${project}`, limit, 60);
    if (blocked) return blocked;
    return next();
  };
}

interface CounterState {
  count: number;
  resetAt: number;
}

export class SecurityGate implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    const input: { limit?: number; windowSeconds?: number } = await request.json<{ limit?: number; windowSeconds?: number }>().catch(() => ({}));
    const limit = Math.max(1, Math.min(100_000, Math.floor(input.limit ?? 1)));
    const windowMs = Math.max(1_000, Math.min(86_400_000, Math.floor((input.windowSeconds ?? 60) * 1000)));
    const now = Date.now();
    let result: CounterState = { count: 1, resetAt: now + windowMs };
    await this.state.storage.transaction(async (storage) => {
      const current = await storage.get<CounterState>("counter");
      result = !current || current.resetAt <= now
        ? { count: 1, resetAt: now + windowMs }
        : { count: current.count + 1, resetAt: current.resetAt };
      await storage.put("counter", result);
      await storage.setAlarm(result.resetAt);
    });
    const remaining = Math.max(0, limit - result.count);
    const headers = new Headers({
      "Content-Type": "application/json",
      "RateLimit-Limit": String(limit),
      "RateLimit-Remaining": String(remaining),
      "RateLimit-Reset": String(Math.ceil(result.resetAt / 1000))
    });
    if (result.count > limit) {
      headers.set("Retry-After", String(Math.max(1, Math.ceil((result.resetAt - now) / 1000))));
      return new Response(JSON.stringify({ allowed: false }), { status: 429, headers });
    }
    return new Response(JSON.stringify({ allowed: true, remaining }), { headers });
  }

  async alarm(): Promise<void> {
    await this.state.storage.delete("counter");
  }
}
