import { NextResponse } from "next/server";
import { z } from "zod";
import { recordActivity } from "@/lib/activity";
import { tenantRows, withTenant } from "@/lib/database";
import { assertSameOrigin, requireSession, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ActivityRow { id: string; action: string; subject: string | null; connection_id: string | null; metadata: Record<string, unknown>; created_at: string }

export async function GET(request: Request) {
  const session = await requireSession(request.headers);
  if (!session) return unauthorized();
  const activity = await tenantRows<ActivityRow>(session.user.id,
    "SELECT id, action, subject, connection_id, metadata, created_at FROM user_activity ORDER BY created_at DESC LIMIT 100");
  return NextResponse.json({ activity }, { headers: { "Cache-Control": "private, no-store" } });
}

const activityInput = z.object({
  action: z.enum(["file.uploaded", "pin.created", "pin.removed", "backend.checked", "file.downloaded", "backup.configured", "backup.removed", "backup.started"]),
  subject: z.string().max(300).nullable().optional(),
  connectionId: z.string().uuid(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional()
}).strict();

export async function POST(request: Request) {
  try { assertSameOrigin(request); } catch { return NextResponse.json({ error: { code: "ORIGIN_MISMATCH", message: "Request origin is not allowed" } }, { status: 403 }); }
  const session = await requireSession(request.headers);
  if (!session) return unauthorized();
  const parsed = activityInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_INPUT", message: "Activity payload is invalid" } }, { status: 400 });
  const saved = await withTenant(session.user.id, async (client) => {
    const connection = await client.query("SELECT 1 FROM backend_connections WHERE id = $1 AND state = 'active'", [parsed.data.connectionId]);
    if (!connection.rowCount) return false;
    await recordActivity(client, session.user.id, parsed.data.action, parsed.data.subject ?? null, parsed.data.connectionId, parsed.data.metadata ?? {});
    return true;
  });
  if (!saved) return NextResponse.json({ error: { code: "CONNECTION_NOT_FOUND", message: "Active backend connection was not found" } }, { status: 404 });
  return new Response(null, { status: 204 });
}
