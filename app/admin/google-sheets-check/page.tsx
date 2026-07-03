import Link from "next/link";
import { readSession } from "@/lib/session";
import { getValidAccessToken } from "@/lib/googleAuth";
import {
  runUserDiagnostics,
  type SheetDiagnostics,
} from "@/lib/googleSheets";
import { UserBar } from "@/components/UserBar";

// Диагностика всегда выполняется на сервере при каждом открытии страницы —
// без кэширования, чтобы менеджер видел актуальное состояние доступа.
export const dynamic = "force-dynamic";

/** 0 → A, 1 → B, … 26 → AA (как буквы колонок в Google Sheets) */
function columnLetter(index: number): string {
  let letters = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function StatusChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`status ${ok ? "ok" : "error"}`}>
      {ok ? "✓" : "✗"} {label}
    </span>
  );
}

function SheetCard({ sheet }: { sheet: SheetDiagnostics }) {
  const columnCount = Math.max(
    sheet.headers.length,
    ...sheet.sampleRows.map((row) => row.length),
    1
  );

  return (
    <div className="card">
      <h2>Лист «{sheet.title}»</h2>
      <p className="meta-line">
        Размер листа: {sheet.rowCount} строк × {sheet.columnCount} колонок.
        {sheet.headerRowNumber !== null
          ? ` Шапка: строка ${sheet.headerRowNumber}.`
          : " Шапка не найдена."}
      </p>

      {sheet.headers.length > 0 && (
        <>
          <p className="meta-line">Найденные шапки колонок:</p>
          <div className="chip-list">
            {sheet.headers.map((header, i) =>
              header === "" ? (
                <span key={i} className="chip empty">
                  (колонка {i + 1}: без названия)
                </span>
              ) : (
                <span key={i} className="chip">
                  {header}
                </span>
              )
            )}
          </div>
        </>
      )}

      {sheet.warnings.length > 0 && (
        <ul className="warning-list">
          {sheet.warnings.map((warning, i) => (
            <li key={i}>⚠️ {warning}</li>
          ))}
        </ul>
      )}

      {sheet.sampleRows.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="row-number">#</th>
                {Array.from({ length: columnCount }, (_, i) => (
                  <th key={i}>{columnLetter(i)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheet.sampleRows.map((row, rowIndex) => (
                <tr
                  key={rowIndex}
                  className={
                    rowIndex + 1 === sheet.headerRowNumber ? "header-row" : ""
                  }
                >
                  <td className="row-number">{rowIndex + 1}</td>
                  {Array.from({ length: columnCount }, (_, colIndex) => (
                    <td key={colIndex}>{row[colIndex] ?? ""}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="meta-line">Лист пуст.</p>
      )}
    </div>
  );
}

export default async function GoogleSheetsCheckPage() {
  const session = await readSession();

  if (!session) {
    return (
      <main>
        <h1>Диагностика доступа к Google Таблице</h1>
        <p className="subtitle">
          <Link href="/">← На главную</Link>
        </p>
        <div className="card">
          <h2>
            Вы не авторизованы <span className="status error">нет входа</span>
          </h2>
          <p>Диагностика выполняется от имени вашего Google-аккаунта.</p>
          <a href="/api/auth/signin" className="button">
            Войти через Google
          </a>
        </div>
      </main>
    );
  }

  const accessToken = await getValidAccessToken(session);
  if (!accessToken) {
    return (
      <main>
        <h1>Диагностика доступа к Google Таблице</h1>
        <p className="subtitle">
          <Link href="/">← На главную</Link>
        </p>
        <UserBar email={session.email} name={session.name} />
        <div className="card">
          <h2>
            Сессия истекла <span className="status error">нужен вход</span>
          </h2>
          <p>Токен Google больше не действует. Выйдите и войдите заново.</p>
          <a href="/api/auth/signin" className="button">
            Войти через Google
          </a>
        </div>
      </main>
    );
  }

  const diagnostics = await runUserDiagnostics(accessToken);
  const metadataOk = diagnostics.metadata.ok;
  const rowsOk = diagnostics.rows?.ok === true;

  return (
    <main>
      <h1>Диагностика доступа к Google Таблице</h1>
      <p className="subtitle">
        <Link href="/">← На главную</Link>
      </p>

      <UserBar email={session.email} name={session.name} />

      <div className="card">
        <h2>Результат проверки</h2>
        <div className="chip-list" style={{ marginTop: 12 }}>
          <StatusChip ok label={`Вошли как ${session.email}`} />
          <StatusChip
            ok={metadataOk}
            label={
              metadataOk
                ? "Доступ к таблице есть (metadata прочитана)"
                : "Нет доступа к таблице"
            }
          />
          {diagnostics.rows !== null && (
            <StatusChip
              ok={rowsOk}
              label={
                rowsOk
                  ? "Первые строки листов прочитаны"
                  : "Не удалось прочитать строки"
              }
            />
          )}
        </div>

        {diagnostics.metadata.ok ? (
          <>
            <p className="meta-line">
              Таблица:{" "}
              <strong>{diagnostics.metadata.spreadsheetTitle}</strong>
            </p>
            <p className="meta-line">
              Листов: {diagnostics.metadata.sheetTitles.length}
              {diagnostics.metadata.sheetTitles.length > 0 &&
                ` (${diagnostics.metadata.sheetTitles
                  .map((t) => `«${t}»`)
                  .join(", ")})`}
            </p>
          </>
        ) : (
          <div className="error-message">
            <p style={{ margin: 0 }}>{diagnostics.metadata.message}</p>
            <p style={{ marginBottom: 0 }}>
              Ваш email для выдачи доступа: <code>{session.email}</code>
            </p>
            {diagnostics.metadata.details && (
              <p className="error-details">
                Техническая информация: {diagnostics.metadata.details}
              </p>
            )}
          </div>
        )}

        {diagnostics.rows && !diagnostics.rows.ok && (
          <div className="error-message">
            <p style={{ margin: 0 }}>{diagnostics.rows.message}</p>
            {diagnostics.rows.details && (
              <p className="error-details">
                Техническая информация: {diagnostics.rows.details}
              </p>
            )}
          </div>
        )}
      </div>

      {diagnostics.rows?.ok &&
        diagnostics.rows.sheets.map((sheet) => (
          <SheetCard key={sheet.title} sheet={sheet} />
        ))}
    </main>
  );
}
