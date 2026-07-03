import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForSession, getAuthConfig } from "@/lib/googleAuth";
import { SESSION_COOKIE, sealSession, sessionCookieOptions } from "@/lib/session";

/**
 * Возврат с Google: проверяем state, меняем code на токены,
 * создаём зашифрованную сессионную cookie и уводим пользователя на главную.
 */
export async function GET(request: NextRequest) {
  const config = getAuthConfig();
  const url = request.nextUrl;
  const base = url.origin;

  const fail = (message: string) =>
    NextResponse.redirect(`${base}/?error=${encodeURIComponent(message)}`);

  if (!config.ok) {
    return fail(
      `Не настроены переменные окружения: ${config.missing.join(", ")}`
    );
  }

  // Пользователь отказался выдавать доступ
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    return fail(
      oauthError === "access_denied"
        ? "Вход отменён: вы не выдали приложению запрошенные разрешения."
        : `Google вернул ошибку: ${oauthError}`
    );
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = request.cookies.get("oauth_state")?.value;

  if (!code) {
    return fail("Google не вернул код авторизации.");
  }
  // Сравнение через timingSafeEqual — устойчиво к timing-атакам
  const stateValid =
    Boolean(state && expectedState) &&
    state!.length === expectedState!.length &&
    timingSafeEqual(Buffer.from(state!), Buffer.from(expectedState!));
  if (!stateValid) {
    return fail(
      "Проверка безопасности не пройдена (state не совпадает). Попробуйте войти ещё раз."
    );
  }

  try {
    const { session } = await exchangeCodeForSession(config.config, code);
    const response = NextResponse.redirect(`${base}/`);
    response.cookies.set(
      SESSION_COOKIE,
      await sealSession(session),
      sessionCookieOptions()
    );
    response.cookies.delete("oauth_state");
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`Не удалось завершить вход: ${message}`);
  }
}
