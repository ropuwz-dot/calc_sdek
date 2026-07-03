import { NextRequest, NextResponse } from "next/server";
import { requireSheetsUser } from "@/lib/apiAuth";
import { searchPvzSmart } from "@/lib/cdek";

/**
 * Поиск ПВЗ СДЭК по городу и улице/адресу.
 * Если на улице нет ПВЗ — адрес геокодируется и возвращаются ближайшие
 * пункты с расстоянием.
 */
export async function GET(request: NextRequest) {
  const user = await requireSheetsUser();
  if (!user.ok) {
    return NextResponse.json(
      { ok: false, message: user.message },
      { status: user.status }
    );
  }

  const cityCode = Number(request.nextUrl.searchParams.get("city"));
  const cityName = request.nextUrl.searchParams.get("cityName") ?? "";
  const sideParam = request.nextUrl.searchParams.get("side");
  const side = sideParam === "from" ? "from" : "to";
  const q = request.nextUrl.searchParams.get("q") ?? "";

  if (!Number.isFinite(cityCode) || cityCode <= 0) {
    return NextResponse.json(
      { ok: false, message: "Не указан город." },
      { status: 400 }
    );
  }

  const result = await searchPvzSmart(cityCode, cityName, side, q);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, message: result.message },
      { status: 502 }
    );
  }
  return NextResponse.json({ ok: true, points: result.points });
}
