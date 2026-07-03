import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { buildAuthUrl, getAuthConfig } from "@/lib/googleAuth";

/**
 * Начало входа: генерируем anti-CSRF state, кладём его в короткоживущую
 * httpOnly-cookie и отправляем пользователя на страницу согласия Google.
 */
export async function GET(request: Request) {
  const configResult = getAuthConfig();
  if (!configResult.ok) {
    const base = new URL(request.url).origin;
    return NextResponse.redirect(
      `${base}/?error=${encodeURIComponent(
        `Не настроены переменные окружения: ${configResult.missing.join(", ")}`
      )}`
    );
  }

  const state = randomUUID();
  const response = NextResponse.redirect(
    buildAuthUrl(configResult.config, state)
  );
  response.cookies.set("oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 10 * 60, // 10 минут на прохождение согласия
  });
  return response;
}
