import { NextResponse } from "next/server";
import { requireSheetsUser } from "@/lib/apiAuth";
import {
  toPublicCarrierStatuses,
  type CarrierKey,
  type PublicCarrierStatus,
} from "@/lib/carrierDiagnostics";
import { runAllCarrierDiagnostics } from "@/lib/runCarrierDiagnostics";

const HEALTH_CACHE_TTL_MS = 60 * 1000;
type HealthResponse = Record<CarrierKey, PublicCarrierStatus>;

let healthCache: { value: HealthResponse; at: number } | null = null;
let pendingCheck: Promise<HealthResponse> | null = null;

async function checkCarriers(): Promise<HealthResponse> {
  if (healthCache && Date.now() - healthCache.at < HEALTH_CACHE_TTL_MS) {
    return healthCache.value;
  }
  if (pendingCheck) return pendingCheck;

  pendingCheck = runAllCarrierDiagnostics().then((diagnostics) => {
    const value = toPublicCarrierStatuses(diagnostics);
    healthCache = { value, at: Date.now() };
    return value;
  });
  try {
    return await pendingCheck;
  } finally {
    pendingCheck = null;
  }
}

export async function GET() {
  const user = await requireSheetsUser();
  if (!user.ok) {
    return NextResponse.json(
      { ok: false, message: user.message },
      { status: user.status }
    );
  }

  return NextResponse.json(await checkCarriers());
}
