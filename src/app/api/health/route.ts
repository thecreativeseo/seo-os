import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    status: "ok",
    phase: "P0",
    milestone: "M10",
    checkedAt: new Date().toISOString(),
  });
}
