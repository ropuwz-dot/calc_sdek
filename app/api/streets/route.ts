import { NextRequest, NextResponse } from "next/server";
import { requireSheetsUser } from "@/lib/apiAuth";
import { suggestStreets } from "@/lib/dadata";

/** Подсказки улиц (DaData) для адресов «дверь» у СДЭК. */
export async function GET(request: NextRequest) {
  const user = await requireSheetsUser();
  if (!user.ok) {
    return NextResponse.json(
      { ok: false, message: user.message },
      { status: user.status }
    );
  }

  const city = request.nextUrl.searchParams.get("city")?.trim() ?? "";
  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (city === "" || q.length < 2) {
    return NextResponse.json({ ok: true, streets: [] });
  }

  const result = await suggestStreets(city, q);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, message: result.message },
      { status: 502 }
    );
  }
  return NextResponse.json({ ok: true, streets: result.streets });
}
