import assert from "node:assert/strict";
import test from "node:test";

import { isDiagnosticsAdmin } from "../lib/adminPolicy";
import {
  DiagnosticEventStore,
  diagnosticFailureFromMessage,
  sanitizeDiagnosticText,
  toPublicCarrierStatus,
  toPublicCarrierStatuses,
} from "../lib/carrierDiagnostics";

test("diagnostics admin policy accepts only rop.uwz@gmail.com", () => {
  assert.equal(isDiagnosticsAdmin("rop.uwz@gmail.com"), true);
  assert.equal(isDiagnosticsAdmin(" ROP.UWZ@GMAIL.COM "), true);
  assert.equal(isDiagnosticsAdmin("manager@example.com"), false);
  assert.equal(isDiagnosticsAdmin("rop.uwz@gmail.com.attacker.test"), false);
});

test("diagnostic text redacts credentials, token headers and email addresses", () => {
  const sanitized = sanitizeDiagnosticText(
    "Token: secret-token-value Bearer bearer-value eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature user@example.com refreshToken=example-refresh-secret client_secret:example-client-secret api_key=example-api-key"
  );

  assert.equal(sanitized.includes("secret-token-value"), false);
  assert.equal(sanitized.includes("bearer-value"), false);
  assert.equal(sanitized.includes("eyJhbGci"), false);
  assert.equal(sanitized.includes("user@example.com"), false);
  assert.equal(sanitized.includes("example-refresh-secret"), false);
  assert.equal(sanitized.includes("example-client-secret"), false);
  assert.equal(sanitized.includes("example-api-key"), false);
  assert.match(sanitized, /\[REDACTED\]/);
});

test("diagnostic event store keeps only the newest sanitized events", () => {
  const store = new DiagnosticEventStore(2);
  store.add({
    carrier: "magicTrans",
    status: "down",
    stage: "auth",
    code: "MT_ACCESS_401",
    reason: "Token: secret-value user@example.com",
    latencyMs: 100,
    checkedAt: "2026-07-22T00:00:01.000Z",
  });
  store.add({
    carrier: "cdek",
    status: "ok",
    stage: "ready",
    code: "OK",
    reason: "Доступен",
    latencyMs: 50,
    checkedAt: "2026-07-22T00:00:02.000Z",
  });
  store.add({
    carrier: "dellin",
    status: "down",
    stage: "network",
    code: "DL_TIMEOUT",
    reason: "Таймаут",
    latencyMs: 8000,
    checkedAt: "2026-07-22T00:00:03.000Z",
  });

  const events = store.list();
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.carrier), ["dellin", "cdek"]);
  assert.equal(events.some((event) => event.reason.includes("secret-value")), false);
});

test("public carrier status strips diagnostic details", () => {
  assert.deepEqual(
    toPublicCarrierStatus({
      carrier: "magicTrans",
      status: "down",
      stage: "auth",
      code: "MT_ACCESS_401",
      reason: "Magic Trans отклонили токен авторизации.",
      httpStatus: 401,
      latencyMs: 820,
      checkedAt: "2026-07-22T00:00:00.000Z",
    }),
    {
      status: "down",
      checkedAt: "2026-07-22T00:00:00.000Z",
      latencyMs: 820,
    }
  );
});

test("public health response strips details from recorded carrier diagnostics", () => {
  const diagnostics = {
    cdek: {
      carrier: "cdek" as const,
      status: "ok" as const,
      stage: "ready" as const,
      code: "OK",
      reason: "Интеграция отвечает.",
      latencyMs: 50,
      checkedAt: "2026-07-22T00:00:00.000Z",
    },
    dellin: {
      carrier: "dellin" as const,
      status: "ok" as const,
      stage: "ready" as const,
      code: "OK",
      reason: "Интеграция отвечает.",
      latencyMs: 70,
      checkedAt: "2026-07-22T00:00:01.000Z",
    },
    magicTrans: {
      carrier: "magicTrans" as const,
      status: "down" as const,
      stage: "auth" as const,
      code: "MT_AUTH_REJECTED",
      reason: "Magic Trans отклонили токен авторизации.",
      httpStatus: 401,
      latencyMs: 820,
      checkedAt: "2026-07-22T00:00:02.000Z",
    },
  };

  assert.deepEqual(toPublicCarrierStatuses(diagnostics), {
    cdek: { status: "ok", checkedAt: "2026-07-22T00:00:00.000Z", latencyMs: 50 },
    dellin: { status: "ok", checkedAt: "2026-07-22T00:00:01.000Z", latencyMs: 70 },
    magicTrans: { status: "down", checkedAt: "2026-07-22T00:00:02.000Z", latencyMs: 820 },
  });
  assert.equal(diagnostics.magicTrans.reason, "Magic Trans отклонили токен авторизации.");
});

test("diagnostic failure classifier assigns safe carrier-specific codes", () => {
  assert.deepEqual(
    diagnosticFailureFromMessage(
      "magicTrans",
      "auth",
      "Magic Trans отклонили токен авторизации (HTTP 401)."
    ),
    {
      stage: "auth",
      code: "MT_AUTH_REJECTED",
      reason: "Magic Trans отклонили токен авторизации (HTTP 401).",
      httpStatus: 401,
      status: "down",
    }
  );

  assert.equal(
    diagnosticFailureFromMessage("dellin", "network", "Таймаут соединения").code,
    "DL_TIMEOUT"
  );
  assert.equal(
    diagnosticFailureFromMessage(
      "cdek",
      "config",
      "Интеграция СДЭК не настроена: задайте переменные окружения."
    ).status,
    "misconfigured"
  );
  assert.equal(
    diagnosticFailureFromMessage(
      "magicTrans",
      "calculator",
      "Magic Trans не вернули стоимость основного тарифа публичного калькулятора."
    ).stage,
    "public-calculator"
  );
});
