import { NextResponse } from "next/server";
import { tenantRows } from "@/lib/database";
import { requireSession, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ConnectionRow { id: string; name: string; endpoint: string; key_fingerprint: string; state: string; last_seen_at: string | null; created_at: string }

export async function GET(request: Request) {
  const session = await requireSession(request.headers);
  if (!session) return unauthorized();
  const connections = await tenantRows<ConnectionRow>(session.user.id,
    "SELECT id, name, endpoint, key_fingerprint, state, last_seen_at, created_at FROM backend_connections WHERE state <> 'revoked' ORDER BY created_at DESC");
  return NextResponse.json({ connections }, { headers: { "Cache-Control": "private, no-store" } });
}
