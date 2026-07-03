import "server-only";

import { createHash } from "node:crypto";
import { readSession, type SessionData } from "@/lib/session";
import { getValidAccessToken } from "@/lib/googleAuth";
import { checkSpreadsheetAccess } from "@/lib/googleSheets";

/**
 * Гвард API-роутов калькулятора. Перед любой операцией проверяет:
 *  1. пользователь авторизован;
 *  2. его Google-токен действителен (при необходимости продлевает);
 *  3. у его аккаунта есть доступ к таблице (metadata читается его токеном).
 */
export type ApiUser =
  | { ok: true; session: SessionData; accessToken: string }
  | { ok: false; status: number; message: string };

/**
 * Кэш результата проверки доступа, чтобы автокомплит (запрос на каждое
 * нажатие клавиши) не бил в Google Sheets API. Ключ — хэш access token
 * (сырые токены в кэше не храним). Отзыв доступа применится с задержкой
 * не более TTL.
 */
type AccessVerdict =
  | { ok: true }
  | { ok: false; status: number; message: string };
const accessCache = new Map<string, { verdict: AccessVerdict; at: number }>();
const ACCESS_CACHE_TTL_MS = 60 * 1000;
const ACCESS_CACHE_MAX = 500;

function rememberAccess(key: string, verdict: AccessVerdict) {
  if (accessCache.size >= ACCESS_CACHE_MAX) {
    const oldest = accessCache.keys().next().value;
    if (oldest !== undefined) accessCache.delete(oldest);
  }
  accessCache.set(key, { verdict, at: Date.now() });
}

export async function requireSheetsUser(): Promise<ApiUser> {
  const session = await readSession();
  if (!session) {
    return { ok: false, status: 401, message: "Войдите через Google-аккаунт." };
  }

  const accessToken = await getValidAccessToken(session);
  if (!accessToken) {
    return {
      ok: false,
      status: 401,
      message: "Сессия Google истекла. Выйдите и войдите заново.",
    };
  }

  const cacheKey = createHash("sha256").update(accessToken).digest("hex");
  const cached = accessCache.get(cacheKey);
  if (cached && Date.now() - cached.at < ACCESS_CACHE_TTL_MS) {
    return cached.verdict.ok
      ? { ok: true, session, accessToken }
      : cached.verdict;
  }

  const access = await checkSpreadsheetAccess(accessToken);
  if (!access.ok) {
    const forbidden =
      access.errorCode === "NO_ACCESS" || access.errorCode === "NOT_FOUND";
    const verdict: AccessVerdict = {
      ok: false,
      status: forbidden ? 403 : access.errorCode === "TOKEN_EXPIRED" ? 401 : 500,
      message: access.message,
    };
    rememberAccess(cacheKey, verdict);
    return verdict;
  }

  rememberAccess(cacheKey, { ok: true });
  return { ok: true, session, accessToken };
}
