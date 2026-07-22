"use client";

import { useCallback, useState } from "react";
import type {
  CarrierDiagnostic,
  CarrierKey,
  DiagnosticEvent,
  DiagnosticStage,
} from "@/lib/carrierDiagnostics";
import styles from "./diagnostics.module.css";

type DiagnosticsResponse = {
  ok: true;
  checks: Record<CarrierKey, CarrierDiagnostic>;
  events: DiagnosticEvent[];
};

const CARRIER_LABELS: Record<CarrierKey, string> = {
  cdek: "СДЭК",
  dellin: "Деловые Линии",
  magicTrans: "Magic Trans",
};

const STAGE_LABELS: Record<DiagnosticStage, string> = {
  config: "Конфигурация",
  network: "Сеть",
  auth: "Авторизация",
  directory: "Справочники",
  terminals: "Терминалы",
  calculator: "Тарифный API",
  "public-calculator": "Публичный калькулятор",
  response: "Формат ответа",
  ready: "Готово",
};

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("ru-RU", {
        timeZone: "Europe/Moscow",
        dateStyle: "short",
        timeStyle: "medium",
      });
}

export default function DiagnosticsPanel({
  initialChecks,
  initialEvents,
}: {
  initialChecks: Record<CarrierKey, CarrierDiagnostic>;
  initialEvents: DiagnosticEvent[];
}) {
  const [checks, setChecks] = useState<Record<CarrierKey, CarrierDiagnostic>>(initialChecks);
  const [events, setEvents] = useState<DiagnosticEvent[]>(initialEvents);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/diagnostics/carriers", {
        cache: "no-store",
        credentials: "same-origin",
      });
      const data = (await response.json()) as DiagnosticsResponse | { ok: false; message?: string };
      if (!response.ok || !data.ok) {
        throw new Error("message" in data && data.message ? data.message : `HTTP ${response.status}`);
      }
      setChecks(data.checks);
      setEvents(data.events);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось выполнить диагностику.");
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <>
      <section className="card">
        <div className={styles.headingRow}>
          <div>
            <h2>Текущая проверка</h2>
            <p className="meta-line">
              Выполняются безопасные запросы авторизации и справочников. Токены и тела ответов не отображаются.
            </p>
          </div>
          <button className="button" type="button" onClick={() => void refresh()} disabled={loading}>
            {loading ? "Проверяем…" : "Проверить сейчас"}
          </button>
        </div>
        {error ? <div className="error-message">{error}</div> : null}
        <div className={styles.cardGrid} aria-live="polite">
          {(Object.keys(CARRIER_LABELS) as CarrierKey[]).map((carrier) => {
            const check = checks?.[carrier];
            const available = check?.status === "ok";
            return (
              <article className={styles.carrierCard} key={carrier}>
                <div className={styles.carrierTitle}>
                  <strong>{CARRIER_LABELS[carrier]}</strong>
                  <span className={`status ${available ? "ok" : "error"}`}>
                    {check ? (available ? "работает" : "ошибка") : "ожидание"}
                  </span>
                </div>
                {check ? (
                  <dl className={styles.details}>
                    <div><dt>Этап</dt><dd>{STAGE_LABELS[check.stage]}</dd></div>
                    <div><dt>Код</dt><dd><code>{check.code}</code></dd></div>
                    {check.httpStatus ? <div><dt>HTTP</dt><dd>{check.httpStatus}</dd></div> : null}
                    <div><dt>Задержка</dt><dd>{check.latencyMs} мс</dd></div>
                    <div><dt>Проверено</dt><dd>{formatTime(check.checkedAt)} МСК</dd></div>
                    <div className={styles.reason}><dt>Причина</dt><dd>{check.reason}</dd></div>
                    {check.requestId ? <div className={styles.reason}><dt>Request ID</dt><dd><code>{check.requestId}</code></dd></div> : null}
                  </dl>
                ) : (
                  <p className="meta-line">Диагностика ещё не выполнялась.</p>
                )}
              </article>
            );
          })}
        </div>
      </section>

      <section className="card">
        <h2>Последние диагностические события</h2>
        <p className="meta-line">
          Буфер хранится в памяти процесса и очищается при перезапуске приложения. Структурированные события также попадают в journald без секретов и персональных данных.
        </p>
        {events.length === 0 ? (
          <p className="meta-line">Событий пока нет.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Время, МСК</th>
                  <th>Перевозчик</th>
                  <th>Статус</th>
                  <th>Этап</th>
                  <th>Код</th>
                  <th>Причина</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td>{formatTime(event.checkedAt)}</td>
                    <td>{CARRIER_LABELS[event.carrier]}</td>
                    <td><span className={`status ${event.status === "ok" ? "ok" : "error"}`}>{event.status === "ok" ? "ok" : "ошибка"}</span></td>
                    <td>{STAGE_LABELS[event.stage]}</td>
                    <td><code>{event.code}</code></td>
                    <td className={styles.eventReason}>{event.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
