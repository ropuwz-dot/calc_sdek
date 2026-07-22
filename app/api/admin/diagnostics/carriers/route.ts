import { NextResponse } from "next/server";
import { requireDiagnosticsAdmin } from "@/lib/adminAuth";
import { getRecentCarrierDiagnostics, runAllCarrierDiagnostics } from "@/lib/runCarrierDiagnostics";

export const dynamic = "force-dynamic";

export async function GET() {
  const admin = await requireDiagnosticsAdmin();
  if (!admin.ok) {
    return NextResponse.json(
      { ok: false, message: admin.message },
      { status: admin.status, headers: { "Cache-Control": "no-store" } }
    );
  }

  const checks = await runAllCarrierDiagnostics();
  return NextResponse.json(
    { ok: true, checks, events: getRecentCarrierDiagnostics(100) },
    { headers: { "Cache-Control": "no-store" } }
  );
}
