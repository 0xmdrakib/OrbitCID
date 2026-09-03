import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { getAuth } from "./auth";
import { getOwnerPool } from "./database";

export async function currentSession(requestHeaders?: Headers) {
  const incoming = requestHeaders ?? await headers();
  return getAuth().api.getSession({ headers: incoming });
}

export async function requireSession(requestHeaders?: Headers) {
  const session = await currentSession(requestHeaders);
  if (!session?.user?.id) return null;
  await getOwnerPool().query(
    `INSERT INTO user_profiles (user_id, display_name, avatar_url, last_seen_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name, avatar_url = EXCLUDED.avatar_url, last_seen_at = now()`,
    [session.user.id, session.user.name ?? null, session.user.image ?? null]
  );
  return session;
}

export function unauthorized() {
  return NextResponse.json({ error: { code: "AUTH_REQUIRED", message: "Google sign-in is required" } }, { status: 401 });
}

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const expected = new URL(request.url).origin;
  if (!origin || origin !== expected) throw new Error("ORIGIN_MISMATCH");
}
