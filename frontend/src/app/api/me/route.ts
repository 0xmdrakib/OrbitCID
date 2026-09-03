import { NextResponse } from "next/server";
import { requireSession, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await requireSession(request.headers);
  if (!session) return unauthorized();
  return NextResponse.json({
    user: { id: session.user.id, name: session.user.name, email: session.user.email, image: session.user.image },
    session: { expiresAt: session.session.expiresAt }
  }, { headers: { "Cache-Control": "private, no-store" } });
}
