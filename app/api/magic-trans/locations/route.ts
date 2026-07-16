import { NextRequest, NextResponse } from "next/server";
import { requireSheetsUser } from "@/lib/apiAuth";
import { suggestMagicTransCities } from "@/lib/magicTrans";

export async function GET(request: NextRequest) {
  try {
    const user = await requireSheetsUser();
    if (!user.ok) {
      return NextResponse.json({ ok: false, message: user.message }, { status: user.status });
    }

    const query = request.nextUrl.searchParams.get("q")?.trim() ?? "";
    if (query.length < 2) return NextResponse.json({ ok: true, cities: [] });

    const result = await suggestMagicTransCities(query);
    if (!result.ok) {
      return NextResponse.json({ ok: false, message: result.message }, { status: 502 });
    }
    return NextResponse.json({ ok: true, cities: result.cities });
  } catch {
    return NextResponse.json(
      { ok: false, message: "Внутренняя ошибка при обращении к Magic Trans." },
      { status: 500 }
    );
  }
}
