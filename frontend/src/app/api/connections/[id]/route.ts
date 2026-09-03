import { NextResponse } from "next/server";
import { recordActivity } from "@/lib/activity";
import { withTenant } from "@/lib/database";
import { assertSameOrigin, requireSession, unauthorized } from "@/lib/session";

export const runtime = "nodejs";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try { assertSameOrigin(request); } catch { return NextResponse.json({ error: { code: "ORIGIN_MISMATCH", message: "Request origin is not allowed" } }, { status: 403 }); }
  const session = await requireSession(request.headers);
  if (!session) return unauthorized();
  const { id } = await context.params;
  const changed = await withTenant(session.user.id, async (client) => {
    const result = await client.query("UPDATE backend_connections SET state = 'revoked', updated_at = now() WHERE id = $1 AND state <> 'revoked' RETURNING name", [id]);
    if (result.rowCount) await recordActivity(client, session.user.id, "backend.revoked", result.rows[0].name, id);
    return result.rowCount;
  });
  if (!changed) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Backend connection was not found" } }, { status: 404 });
  return new Response(null, { status: 204 });
}
