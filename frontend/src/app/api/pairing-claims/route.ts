import { NextResponse } from "next/server";
import { z } from "zod";
import { recordActivity } from "@/lib/activity";
import { withTenant } from "@/lib/database";
import { newPairingCode, sha256 } from "@/lib/security";
import { assertSameOrigin, requireSession, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
const inputSchema = z.object({ label: z.string().trim().min(1).max(80) }).strict();

export async function POST(request: Request) {
  try { assertSameOrigin(request); } catch { return NextResponse.json({ error: { code: "ORIGIN_MISMATCH", message: "Request origin is not allowed" } }, { status: 403 }); }
  const session = await requireSession(request.headers);
  if (!session) return unauthorized();
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_INPUT", message: "A backend name between 1 and 80 characters is required" } }, { status: 400 });
  const code = newPairingCode();
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  await withTenant(session.user.id, async (client) => {
    await client.query("DELETE FROM pairing_claims WHERE consumed_at IS NOT NULL OR expires_at < now()");
    await client.query("INSERT INTO pairing_claims(id, user_id, code_hash, label, expires_at) VALUES ($1, $2, $3, $4, $5)", [id, session.user.id, sha256(code), parsed.data.label, expiresAt]);
    await recordActivity(client, session.user.id, "pairing.created", parsed.data.label);
  });
  return NextResponse.json({ id, code, expiresAt: expiresAt.toISOString() }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
}
