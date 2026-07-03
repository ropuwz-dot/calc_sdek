import "server-only";

import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { EncryptJWT, jwtDecrypt } from "jose";

/**
 * Сессия пользователя.
 *
 * Хранится в httpOnly-cookie в виде зашифрованного JWE (A256GCM, ключ
 * выводится из NEXTAUTH_SECRET). Внутри — профиль пользователя и его
 * Google OAuth-токены. Браузерный JavaScript не может ни прочитать cookie
 * (httpOnly), ни расшифровать её содержимое (ключ есть только на сервере),
 * поэтому access/refresh token никогда не попадают на frontend.
 */

export const SESSION_COOKIE = "cdek_calc_session";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 дней

export interface SessionData {
  email: string;
  name?: string;
  picture?: string;
  /** Google OAuth access token (живёт ~1 час) */
  accessToken: string;
  /** Refresh token — для продления access token без повторного входа */
  refreshToken?: string;
  /** Момент истечения access token, unix ms */
  accessTokenExpires: number;
}

function getSessionKey(): Uint8Array {
  const secret = process.env.NEXTAUTH_SECRET?.trim();
  if (!secret) {
    throw new Error(
      "NEXTAUTH_SECRET не задан. Добавьте его в .env.local (любая длинная случайная строка)."
    );
  }
  // A256GCM требует ключ ровно 32 байта — выводим его из секрета через SHA-256
  return new Uint8Array(createHash("sha256").update(secret).digest());
}

export async function sealSession(data: SessionData): Promise<string> {
  return new EncryptJWT({ ...data })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .encrypt(getSessionKey());
}

export async function unsealSession(
  token: string
): Promise<SessionData | null> {
  try {
    const { payload } = await jwtDecrypt(token, getSessionKey());
    if (typeof payload.email !== "string" || typeof payload.accessToken !== "string") {
      return null;
    }
    return {
      email: payload.email,
      name: typeof payload.name === "string" ? payload.name : undefined,
      picture: typeof payload.picture === "string" ? payload.picture : undefined,
      accessToken: payload.accessToken,
      refreshToken:
        typeof payload.refreshToken === "string" ? payload.refreshToken : undefined,
      accessTokenExpires:
        typeof payload.accessTokenExpires === "number"
          ? payload.accessTokenExpires
          : 0,
    };
  } catch {
    // Повреждённая, чужая или истёкшая cookie — считаем, что сессии нет
    return null;
  }
}

/** Прочитать сессию текущего запроса (для Server Components и route handlers) */
export async function readSession(): Promise<SessionData | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  return unsealSession(raw);
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}
