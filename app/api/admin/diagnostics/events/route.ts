import { NextRequest, NextResponse } from "next/server";
import { requireDiagnosticsAdmin } from "@/lib/adminAuth";
import { getRecentCarrierDiagnostics } from "@/lib/runCarrierDiagnostics";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const admin = await requireDiagnosticsAdmin();
  if (!admin.ok) {
    return NextResponse.json(
      { ok: false, message: admin.message },
      { status: admin.status, headers: { "Cache-Control": "no-store" } }
    );
  }

  const requestedLimit = Number(request.nextUrl.searchParams.get("limit") ?? 100);
  const limit = Number.isInteger(requestedLimit) ? requestedLimit : 100;
  return NextResponse.json(
    { ok: true, events: getRecentCarrierDiagnostics(limit) },
    { headers: { "Cache-Control": "no-store" } }
  );
}
