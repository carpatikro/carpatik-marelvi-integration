import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ service: "carpatik-marelvi-integration", status: "ready" }, { headers: { "cache-control": "no-store" } });
}
