import { NextResponse } from "next/server";
import { requireSheetsUser } from "@/lib/apiAuth";
import { checkCdekHealth } from "@/lib/cdek";
import { checkDellinHealth } from "@/lib/dellin";

type CarrierStatus = {
  status: "ok" | "down";
  checkedAt: string;
  latencyMs: number;
};

type CarrierKey = "cdek" | "dellin";

const HEALTH_CACHE_TTL_MS = 60 * 1000;
const HEALTH_TIMEOUT_MS = 5 * 1000;

const checks: Record<CarrierKey, () => Promise<{ ok: true } | { ok: false }>> = {
  cdek: () => checkCdekHealth(HEALTH_TIMEOUT_MS),
  dellin: () => checkDellinHealth(HEALTH_TIMEOUT_MS),
};

const healthCache = new Map<CarrierKey, { value: CarrierStatus; at: number }>();
const pendingChecks = new Map<CarrierKey, Promise<CarrierStatus>>();

async function checkCarrier(carrier: CarrierKey): Promise<CarrierStatus> {
  const cached = healthCache.get(carrier);
  if (cached && Date.now() - cached.at < HEALTH_CACHE_TTL_MS) {
    return cached.value;
  }

  const pending = pendingChecks.get(carrier);
  if (pending) return pending;

  const task = (async () => {
    const startedAt = Date.now();
    let ok = false;
    try {
      const result = await checks[carrier]();
      ok = result.ok;
    } catch {
      ok = false;
    }

    const value: CarrierStatus = {
      status: ok ? "ok" : "down",
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
    };
    healthCache.set(carrier, { value, at: Date.now() });
    return value;
  })();

  pendingChecks.set(carrier, task);
  try {
    return await task;
  } finally {
    pendingChecks.delete(carrier);
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

  const [cdek, dellin] = await Promise.all([
    checkCarrier("cdek"),
    checkCarrier("dellin"),
  ]);

  return NextResponse.json({ cdek, dellin });
}
