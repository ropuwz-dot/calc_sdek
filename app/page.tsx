import Link from "next/link";
import { readSession, type SessionData } from "@/lib/session";
import { getValidAccessToken, getAuthConfig } from "@/lib/googleAuth";
import { checkSpreadsheetAccess } from "@/lib/googleSheets";
import { isDiagnosticsAdmin } from "@/lib/adminPolicy";
import { UserBar } from "@/components/UserBar";
import Calculator from "@/components/Calculator";

export const dynamic = "force-dynamic";

function LoginView({ error }: { error?: string }) {
  const config = getAuthConfig();
  return (
    <main>
      <h1>Калькулятор доставки СДЭК</h1>
      <p className="subtitle">
        Внутреннее приложение для менеджеров. Вход — через рабочий
        Google-аккаунт.
      </p>
      {error && (
        <div className="error-message" role="alert">
          {error}
        </div>
      )}
      <div className="card">
        <h2>Вход</h2>
        <p>
          Доступ к калькулятору есть у тех, кому владелец открыл доступ к
          Google Таблице со справочником.
        </p>
        {config.ok ? (
          <a href="/api/auth/signin" className="button">
            Войти через Google
          </a>
        ) : (
          <div className="error-message">
            Приложение не настроено. Не заданы переменные окружения:{" "}
            {config.missing.join(", ")}. См. README.
          </div>
        )}
      </div>
    </main>
  );
}

function NoAccessView({
  session,
  message,
  configIssue,
}: {
  session: SessionData;
  message: string;
  configIssue?: boolean;
}) {
  return (
    <main>
      <h1>{configIssue ? "Настройка не завершена" : "Нет доступа к таблице"}</h1>
      <p className="subtitle">Вы вошли, но пользоваться калькулятором пока нельзя.</p>
      <UserBar email={session.email} name={session.name} />
      <div className="card">
        <h2>Что делать</h2>
        <div className="error-message">{message}</div>
        {!configIssue && (
          <p>
            Ваш email для выдачи доступа: <code>{session.email}</code>
          </p>
        )}
        <p className="meta-line">
          После того как владелец таблицы добавит ваш аккаунт через кнопку
          «Поделиться», просто обновите эту страницу. Подробности:{" "}
          <Link href="/admin/google-sheets-check">диагностика доступа</Link>.
        </p>
      </div>
    </main>
  );
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  const session = await readSession();
  if (!session) {
    return <LoginView error={error} />;
  }

  const accessToken = await getValidAccessToken(session);
  if (!accessToken) {
    return (
      <LoginView error="Сессия Google истекла. Войдите заново, чтобы продолжить." />
    );
  }

  const access = await checkSpreadsheetAccess(accessToken);
  if (!access.ok) {
    if (access.errorCode === "TOKEN_EXPIRED") {
      return <LoginView error={access.message} />;
    }
    return (
      <NoAccessView
        session={session}
        message={access.message}
        configIssue={
          access.errorCode === "API_DISABLED" ||
          access.errorCode === "SCOPE_MISSING" ||
          access.errorCode === "NO_SHEET_ID"
        }
      />
    );
  }

  return (
    <main>
      <h1>Калькулятор доставки СДЭК</h1>
      <p className="subtitle">
        Справочник: <strong>{access.spreadsheetTitle}</strong> — доступ
        подтверждён.
      </p>
      <UserBar email={session.email} name={session.name} />
      <Calculator />
      <p className="meta-line">
        Служебные страницы:{" "}
        <Link href="/admin/google-sheets-check">диагностика доступа</Link>
        {" · "}
        <Link href="/admin/data-quality">качество данных</Link>
        {isDiagnosticsAdmin(session.email) ? (
          <>
            {" · "}
            <Link href="/admin/diagnostics">диагностика перевозчиков</Link>
          </>
        ) : null}
      </p>
    </main>
  );
}
