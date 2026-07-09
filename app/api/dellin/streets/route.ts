import { NextRequest, NextResponse } from "next/server";
import { requireSheetsUser } from "@/lib/apiAuth";
import { suggestDellinStreets } from "@/lib/dellin";

export async function GET(request: NextRequest) {
  try {
    return await handle(request);
  } catch {
    return NextResponse.json(
      { ok: false, message: "Внутренняя ошибка при обращении к Деловым Линиям." },
      { status: 500 }
    );
  }
}

async function handle(request: NextRequest) {
  const user = await requireSheetsUser();
  if (!user.ok) {
    return NextResponse.json(
      { ok: false, message: user.message },
      { status: user.status }
    );
  }

  const cityId = Number(request.nextUrl.searchParams.get("cityId"));
  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (!Number.isFinite(cityId) || cityId <= 0) {
    return NextResponse.json(
      { ok: false, message: "Не указан город для подбора улицы." },
      { status: 400 }
    );
  }
  if (q.length < 2) {
    return NextResponse.json({ ok: true, streets: [] });
  }

  const result = await suggestDellinStreets({ cityId, query: q });
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, message: result.message },
      { status: 502 }
    );
  }
  return NextResponse.json({ ok: true, streets: result.streets });
}
