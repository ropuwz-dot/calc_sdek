import { randomUUID } from "node:crypto";

export type CarrierKey = "cdek" | "dellin" | "magicTrans";
export type DiagnosticStatus = "ok" | "down" | "misconfigured";
export type DiagnosticStage =
  | "config"
  | "network"
  | "auth"
  | "directory"
  | "terminals"
  | "calculator"
  | "public-calculator"
  | "response"
  | "ready";

export type CarrierProbeResult =
  | { ok: true }
  | { ok: false; stage: DiagnosticStage; message: string };

export interface CarrierDiagnostic {
  carrier: CarrierKey;
  status: DiagnosticStatus;
  stage: DiagnosticStage;
  code: string;
  reason: string;
  httpStatus?: number;
  latencyMs: number;
  checkedAt: string;
  requestId?: string;
}

export interface DiagnosticEvent extends CarrierDiagnostic {
  id: string;
}

export interface PublicCarrierStatus {
  status: "ok" | "down";
  checkedAt: string;
  latencyMs: number;
}

export function sanitizeDiagnosticText(value: unknown): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text
    .replace(/\b(Token|Authorization)\s*:\s*\S+/gi, "$1: [REDACTED]")
    .replace(
      /\b(access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|password|passwd|secret)\s*[:=]\s*["']?[^\s"',;&]+["']?/gi,
      "$1=[REDACTED]"
    )
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED]")
    .slice(0, 500);
}

function sanitizeDiagnostic(diagnostic: CarrierDiagnostic): CarrierDiagnostic {
  return {
    ...diagnostic,
    code: diagnostic.code.replace(/[^A-Z0-9_-]/gi, "_").slice(0, 80),
    reason: sanitizeDiagnosticText(diagnostic.reason),
    requestId: diagnostic.requestId?.replace(/[^A-Z0-9_-]/gi, "").slice(0, 80),
  };
}

export interface DiagnosticFailure {
  status: Exclude<DiagnosticStatus, "ok">;
  stage: DiagnosticStage;
  code: string;
  reason: string;
  httpStatus?: number;
}

const CARRIER_CODE_PREFIX: Record<CarrierKey, string> = {
  cdek: "CDEK",
  dellin: "DL",
  magicTrans: "MT",
};

export function diagnosticFailureFromMessage(
  carrier: CarrierKey,
  stage: DiagnosticStage,
  message: string
): DiagnosticFailure {
  const reason = sanitizeDiagnosticText(message);
  const normalized = reason.toLowerCase();
  const httpMatch = reason.match(/\bHTTP\s+(\d{3})\b/i);
  const httpStatus = httpMatch ? Number(httpMatch[1]) : undefined;
  const prefix = CARRIER_CODE_PREFIX[carrier];
  let resolvedStage = stage;
  if (stage !== "config") {
    if (/публичн.*калькулят|адресн.*услуг|основн.*тариф/.test(normalized)) {
      resolvedStage = "public-calculator";
    } else if (/терминал/.test(normalized)) {
      resolvedStage = "terminals";
    } else if (/токен|авторизац|credentials|unauthorized|\b401\b/.test(normalized)) {
      resolvedStage = "auth";
    } else if (/таймаут|timeout|timed out|соедин|network|enotfound|econnrefused|dns/.test(normalized)) {
      resolvedStage = "network";
    }
  }

  let suffix = "UNAVAILABLE";
  let status: DiagnosticFailure["status"] = "down";
  if (resolvedStage === "config" || /не настроен|не настроена|переменн.*окружен/.test(normalized)) {
    suffix = "MISCONFIGURED";
    status = "misconfigured";
  } else if (
    resolvedStage === "auth" &&
    (httpStatus === 400 || httpStatus === 401 || /токен|уч[ёе]тн.*данн|авторизац.*отклон/.test(normalized))
  ) {
    suffix = "AUTH_REJECTED";
  } else if (/таймаут|timeout|timed out/.test(normalized)) {
    suffix = "TIMEOUT";
  } else if (/соедин|network|enotfound|econnrefused|dns/.test(normalized)) {
    suffix = "NETWORK";
  } else if (/некорректн.*ответ|не вернул|не вернули|invalid.*response/.test(normalized)) {
    suffix = "INVALID_RESPONSE";
  } else if (httpStatus) {
    suffix = "HTTP_ERROR";
  }

  return {
    stage: resolvedStage,
    code: `${prefix}_${suffix}`,
    reason,
    ...(httpStatus ? { httpStatus } : {}),
    status,
  };
}

export class DiagnosticEventStore {
  private readonly events: DiagnosticEvent[] = [];

  constructor(private readonly maxEvents = 200) {
    if (!Number.isInteger(maxEvents) || maxEvents < 1) {
      throw new Error("maxEvents must be a positive integer");
    }
  }

  add(diagnostic: CarrierDiagnostic): DiagnosticEvent {
    const event: DiagnosticEvent = {
      ...sanitizeDiagnostic(diagnostic),
      id: randomUUID(),
    };
    this.events.unshift(event);
    if (this.events.length > this.maxEvents) {
      this.events.length = this.maxEvents;
    }
    return event;
  }

  list(limit = this.maxEvents): DiagnosticEvent[] {
    const safeLimit = Number.isInteger(limit) ? Math.max(0, Math.min(limit, this.maxEvents)) : 0;
    return this.events.slice(0, safeLimit).map((event) => ({ ...event }));
  }
}

export function toPublicCarrierStatus(diagnostic: CarrierDiagnostic): PublicCarrierStatus {
  return {
    status: diagnostic.status === "ok" ? "ok" : "down",
    checkedAt: diagnostic.checkedAt,
    latencyMs: diagnostic.latencyMs,
  };
}

export function toPublicCarrierStatuses(
  diagnostics: Record<CarrierKey, CarrierDiagnostic>
): Record<CarrierKey, PublicCarrierStatus> {
  return {
    cdek: toPublicCarrierStatus(diagnostics.cdek),
    dellin: toPublicCarrierStatus(diagnostics.dellin),
    magicTrans: toPublicCarrierStatus(diagnostics.magicTrans),
  };
}
