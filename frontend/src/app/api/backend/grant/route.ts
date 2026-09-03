import { NextResponse } from "next/server";
import { z } from "zod";
import { recordActivity } from "@/lib/activity";
import { issueBackendGrant } from "@/lib/security";
import { withTenant } from "@/lib/database";
import { assertSameOrigin, requireSession, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
const scope = z.enum(["read", "write", "pin", "publish", "export"]);
const inputSchema = z.object({ connectionId: z.string().uuid(), scopes: z.array(scope).min(1).max(5) }).strict();

export async function POST(request: Request) {
  try { assertSameOrigin(request); } catch { return NextResponse.json({ error: { code: "ORIGIN_MISMATCH", message: "Request origin is not allowed" } }, { status: 403 }); }
  const session = await requireSession(request.headers);
  if (!session) return unauthorized();
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_INPUT", message: "Connection and scopes are required" } }, { status: 400 });
  const connection = await withTenant(session.user.id, async (client) => {
    const result = await client.query<{ id: string; endpoint: string; state: string }>("SELECT id, endpoint, state FROM backend_connections WHERE id = $1", [parsed.data.connectionId]);
    if (result.rows[0]?.state === "active") await recordActivity(client, session.user.id, "grant.issued", parsed.data.scopes.join(","), parsed.data.connectionId);
    return result.rows[0];
  });
  if (!connection || connection.state !== "active") return NextResponse.json({ error: { code: "CONNECTION_NOT_FOUND", message: "Active backend connection was not found" } }, { status: 404 });
  const token = await issueBackendGrant({ userId: session.user.id, connectionId: connection.id, scopes: [...new Set(parsed.data.scopes)] });
  return NextResponse.json({ token, endpoint: connection.endpoint, expiresIn: 300 }, { headers: { "Cache-Control": "private, no-store" } });
}
