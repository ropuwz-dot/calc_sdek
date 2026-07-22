import "server-only";

import { randomUUID } from "node:crypto";
import {
  DiagnosticEventStore,
  diagnosticFailureFromMessage,
  type CarrierDiagnostic,
  type CarrierKey,
  type CarrierProbeResult,
  type DiagnosticEvent,
  type DiagnosticStage,
} from "@/lib/carrierDiagnostics";
import { checkCdekHealth } from "@/lib/cdek";
import { checkDellinHealth } from "@/lib/dellin";
import { checkMagicTransHealth } from "@/lib/magicTrans";

const HEALTH_TIMEOUT_MS = 8_000;
const MAX_EVENTS = 300;

const globalDiagnostics = globalThis as typeof globalThis & {
  __carrierDiagnosticStore?: DiagnosticEventStore;
};

const diagnosticStore =
  globalDiagnostics.__carrierDiagnosticStore ?? new DiagnosticEventStore(MAX_EVENTS);
globalDiagnostics.__carrierDiagnosticStore = diagnosticStore;

const checks: Record<CarrierKey, () => Promise<CarrierProbeResult>> = {
  cdek: () => checkCdekHealth(HEALTH_TIMEOUT_MS),
  dellin: () => checkDellinHealth(HEALTH_TIMEOUT_MS),
  magicTrans: () => checkMagicTransHealth(),
};

function writeSafeLog(event: DiagnosticEvent): void {
  const line = {
    kind: "carrier_diagnostic",
    id: event.id,
    carrier: event.carrier,
    status: event.status,
    stage: event.stage,
    code: event.code,
    httpStatus: event.httpStatus,
    latencyMs: event.latencyMs,
    checkedAt: event.checkedAt,
    requestId: event.requestId,
  };
  if (event.status === "ok") {
    console.info(JSON.stringify(line));
  } else {
    console.warn(JSON.stringify(line));
  }
}

function storeDiagnostic(diagnostic: CarrierDiagnostic): CarrierDiagnostic {
  const event = diagnosticStore.add(diagnostic);
  writeSafeLog(event);
  return { ...event };
}

export async function runCarrierDiagnostic(carrier: CarrierKey): Promise<CarrierDiagnostic> {
  const startedAt = Date.now();
  const requestId = randomUUID();
  let probe: CarrierProbeResult;
  try {
    probe = await checks[carrier]();
  } catch {
    probe = {
      ok: false,
      stage: "response",
      message: "Непредвиденная внутренняя ошибка диагностической проверки.",
    };
  }

  const latencyMs = Date.now() - startedAt;
  const checkedAt = new Date().toISOString();
  if (probe.ok) {
    return storeDiagnostic({
      carrier,
      status: "ok",
      stage: "ready",
      code: "OK",
      reason: "Интеграция отвечает на диагностический запрос.",
      latencyMs,
      checkedAt,
      requestId,
    });
  }

  const failure = diagnosticFailureFromMessage(carrier, probe.stage, probe.message);
  return storeDiagnostic({
    carrier,
    ...failure,
    latencyMs,
    checkedAt,
    requestId,
  });
}

export async function runAllCarrierDiagnostics(): Promise<Record<CarrierKey, CarrierDiagnostic>> {
  const [cdek, dellin, magicTrans] = await Promise.all([
    runCarrierDiagnostic("cdek"),
    runCarrierDiagnostic("dellin"),
    runCarrierDiagnostic("magicTrans"),
  ]);
  return { cdek, dellin, magicTrans };
}

export function recordCarrierFailure(params: {
  carrier: CarrierKey;
  stage: DiagnosticStage;
  message: string;
  latencyMs?: number;
  requestId?: string;
}): CarrierDiagnostic {
  const failure = diagnosticFailureFromMessage(params.carrier, params.stage, params.message);
  return storeDiagnostic({
    carrier: params.carrier,
    ...failure,
    latencyMs: Math.max(0, params.latencyMs ?? 0),
    checkedAt: new Date().toISOString(),
    requestId: params.requestId ?? randomUUID(),
  });
}

export function getRecentCarrierDiagnostics(limit = 100): DiagnosticEvent[] {
  return diagnosticStore.list(Math.max(1, Math.min(limit, 100)));
}
