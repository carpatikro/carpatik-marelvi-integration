import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runMarelviSync } from "@/lib/sync.server";

export const runtime = "nodejs";
export const maxDuration = 300;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get("authorization") || "";
  if (!secret || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function handle(request: Request) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: "CRON_SECRET_NOT_CONFIGURED" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  if (!authorized(request)) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401, headers: { "cache-control": "no-store" } });
  }
  try {
    const result = await runMarelviSync();
    return NextResponse.json(result, { status: result.status === "busy" ? 409 : 200, headers: { "cache-control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "SYNC_FAILED";
    return NextResponse.json({ error: code }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}

export const GET = handle;
export const POST = handle;
