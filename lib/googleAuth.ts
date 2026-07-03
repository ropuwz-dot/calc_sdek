import "server-only";

import { google } from "googleapis";
import type { SessionData } from "@/lib/session";

/**
 * Google OAuth для входа пользователей.
 *
 * Приложение работает от имени конкретного пользователя: его access token
 * используется для чтения Google Таблицы, а право пользоваться калькулятором
 * определяется тем, есть ли у его Google-аккаунта доступ к таблице.
 *
 * GOOGLE_CLIENT_SECRET используется только здесь, на сервере.
 */

/**
 * Минимально необходимые права:
 *  - openid/email/profile — кто вошёл;
 *  - spreadsheets.readonly — чтение таблиц через Sheets API.
 * Права на весь Google Drive не запрашиваются.
 */
export const OAUTH_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
];

export interface AuthEnvConfig {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
}

export function getAuthConfig():
  | { ok: true; config: AuthEnvConfig }
  | { ok: false; missing: string[] } {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const baseUrl =
    process.env.NEXTAUTH_URL?.trim().replace(/\/$/, "") ||
    "http://localhost:3000";

  const missing: string[] = [];
  if (!clientId) missing.push("GOOGLE_CLIENT_ID");
  if (!clientSecret) missing.push("GOOGLE_CLIENT_SECRET");
  if (!process.env.NEXTAUTH_SECRET?.trim()) missing.push("NEXTAUTH_SECRET");

  if (missing.length > 0 || !clientId || !clientSecret) {
    return { ok: false, missing };
  }
  return { ok: true, config: { clientId, clientSecret, baseUrl } };
}

export function redirectUri(config: AuthEnvConfig): string {
  return `${config.baseUrl}/api/auth/callback`;
}

function createOAuthClient(config: AuthEnvConfig) {
  return new google.auth.OAuth2(
    config.clientId,
    config.clientSecret,
    redirectUri(config)
  );
}

/** URL страницы согласия Google, на которую отправляем пользователя */
export function buildAuthUrl(config: AuthEnvConfig, state: string): string {
  const client = createOAuthClient(config);
  return client.generateAuthUrl({
    access_type: "offline", // нужен refresh token, чтобы не входить каждый час
    prompt: "consent", // гарантирует выдачу refresh token при каждом входе
    scope: OAUTH_SCOPES,
    state,
  });
}

export interface ExchangeResult {
  session: SessionData;
}

/** Обмен authorization code на токены + проверка id_token */
export async function exchangeCodeForSession(
  config: AuthEnvConfig,
  code: string
): Promise<ExchangeResult> {
  const client = createOAuthClient(config);
  const { tokens } = await client.getToken(code);

  if (!tokens.access_token || !tokens.id_token) {
    throw new Error("Google не вернул access_token/id_token.");
  }

  // Google показывает «чувствительные» разрешения отдельными галочками,
  // снятыми по умолчанию. Если галочку про таблицы не отметили — говорим
  // об этом сразу, а не загадочной ошибкой после входа.
  const grantedScopes = (tokens.scope ?? "").split(/\s+/);
  if (
    !grantedScopes.includes("https://www.googleapis.com/auth/spreadsheets.readonly")
  ) {
    throw new Error(
      "вы не отметили галочку «Просмотр таблиц Google» на экране входа. Войдите ещё раз и поставьте эту галочку — без неё приложение не может прочитать таблицу."
    );
  }

  // Криптографическая проверка id_token (подпись, audience, срок действия)
  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: config.clientId,
  });
  const payload = ticket.getPayload();
  if (!payload?.email) {
    throw new Error("В id_token нет email пользователя.");
  }

  return {
    session: {
      email: payload.email,
      name: payload.name ?? undefined,
      picture: payload.picture ?? undefined,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? undefined,
      accessTokenExpires: tokens.expiry_date ?? Date.now() + 55 * 60 * 1000,
    },
  };
}

/**
 * Возвращает действующий access token для сессии.
 *
 * Если токен истёк и есть refresh token — получает новый у Google.
 * Новый токен не записывается обратно в cookie (Server Components не могут
 * менять cookie), поэтому после истечения часа обновление выполняется на
 * каждый запрос — для внутреннего приложения это приемлемая цена.
 *
 * Возвращает null, если токен продлить нечем — пользователю нужно войти заново.
 */
export async function getValidAccessToken(
  session: SessionData
): Promise<string | null> {
  const notExpiredYet =
    session.accessTokenExpires > Date.now() + 60 * 1000; // запас 60 секунд
  if (notExpiredYet) {
    return session.accessToken;
  }

  if (!session.refreshToken) {
    return null;
  }

  const configResult = getAuthConfig();
  if (!configResult.ok) return null;

  try {
    const client = createOAuthClient(configResult.config);
    client.setCredentials({ refresh_token: session.refreshToken });
    const { token } = await client.getAccessToken();
    return token ?? null;
  } catch {
    // refresh token отозван или недействителен — нужен повторный вход
    return null;
  }
}
