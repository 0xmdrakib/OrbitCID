import { NextResponse } from "next/server";
import { grantPublicJwk } from "@/lib/security";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ keys: [await grantPublicJwk()] }, { headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=3600" } });
}
