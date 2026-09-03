import { NextResponse } from "next/server";
import { z } from "zod";
import { getOwnerPool } from "@/lib/database";
import { serverEnv } from "@/lib/env";
import { sha256, verifyBackendProof } from "@/lib/security";

export const runtime = "nodejs";

const inputSchema = z.object({
  code: z.string().regex(/^orb_pair_[A-Za-z0-9_-]{40,}$/),
  endpoint: z.string().url().max(2048),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/),
  timestamp: z.number().int(),
  publicKey: z.object({ kty: z.literal("OKP"), crv: z.literal("Ed25519"), x: z.string().min(40).max(60) }).passthrough(),
  signature: z.string().min(40).max(200)
}).strict();

function endpointOrigin(value: string) {
  const url = new URL(value);
  const local = process.env.NODE_ENV !== "production" && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) throw new Error("Backend endpoint must use HTTPS");
  if (url.username || url.password || url.search || url.hash) throw new Error("Backend endpoint must not include credentials, query, or fragment");
  return url.origin;
}

export async function POST(request: Request) {
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_CLAIM", message: "Pairing claim is malformed" } }, { status: 400 });
  let endpoint: string;
  try { endpoint = endpointOrigin(parsed.data.endpoint); } catch (error) { return NextResponse.json({ error: { code: "INVALID_ENDPOINT", message: error instanceof Error ? error.message : "Backend endpoint is invalid" } }, { status: 400 }); }
  if (Math.abs(Date.now() - parsed.data.timestamp) > 5 * 60_000) return NextResponse.json({ error: { code: "STALE_PROOF", message: "Pairing proof has expired" } }, { status: 400 });
  const message = `${parsed.data.code}\n${endpoint}\n${parsed.data.nonce}\n${parsed.data.timestamp}`;
  if (!await verifyBackendProof(parsed.data.publicKey, message, parsed.data.signature)) return NextResponse.json({ error: { code: "INVALID_PROOF", message: "Backend key proof is invalid" } }, { status: 401 });

  const pool = getOwnerPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimResult = await client.query<{ id: string; user_id: string; label: string; attempts: number; expires_at: Date; consumed_at: Date | null }>(
      "SELECT id, user_id, label, attempts, expires_at, consumed_at FROM pairing_claims WHERE code_hash = $1 FOR UPDATE", [sha256(parsed.data.code)]);
    const claim = claimResult.rows[0];
    if (!claim || claim.consumed_at || claim.expires_at.getTime() < Date.now() || claim.attempts >= 5) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: { code: "CLAIM_UNAVAILABLE", message: "Pairing code is invalid, expired, or already used" } }, { status: 404 });
    }
    const connectionId = crypto.randomUUID();
    const fingerprint = sha256(JSON.stringify(parsed.data.publicKey));
    await client.query(
      "INSERT INTO backend_connections(id, user_id, name, endpoint, public_key, key_fingerprint) VALUES ($1, $2, $3, $4, $5::jsonb, $6)",
      [connectionId, claim.user_id, claim.label, endpoint, JSON.stringify(parsed.data.publicKey), fingerprint]
    );
    await client.query("UPDATE pairing_claims SET consumed_at = now() WHERE id = $1", [claim.id]);
    await client.query("UPDATE user_profiles SET onboarding_state = 'ready' WHERE user_id = $1", [claim.user_id]);
    await client.query("INSERT INTO user_activity(id, user_id, connection_id, action, subject) VALUES ($1, $2, $3, 'backend.paired', $4)", [crypto.randomUUID(), claim.user_id, connectionId, claim.label]);
    await client.query("COMMIT");
    const issuer = serverEnv().baseUrl;
    return NextResponse.json({ connectionId, ownerId: claim.user_id, issuer, audience: connectionId, frontendOrigin: issuer, jwksUri: `${issuer}/api/.well-known/orbitcid-jwks.json`, keyFingerprint: fingerprint }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    const conflict = typeof error === "object" && error !== null && "code" in error && error.code === "23505";
    return NextResponse.json({ error: { code: conflict ? "CONNECTION_EXISTS" : "PAIRING_FAILED", message: conflict ? "This backend name or endpoint is already connected" : "Pairing could not be completed" } }, { status: conflict ? 409 : 500 });
  } finally {
    client.release();
  }
}
