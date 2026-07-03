import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";

/** Выход: удаляем сессионную cookie и возвращаем на главную. */
export async function POST(request: NextRequest) {
  const response = NextResponse.redirect(`${request.nextUrl.origin}/`, 303);
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
