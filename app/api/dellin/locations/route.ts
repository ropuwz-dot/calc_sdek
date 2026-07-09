import { NextRequest, NextResponse } from "next/server";
import { requireSheetsUser } from "@/lib/apiAuth";
import { suggestDellinCities } from "@/lib/dellin";

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

  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) {
    return NextResponse.json({ ok: true, cities: [] });
  }

  const result = await suggestDellinCities(q);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, message: result.message },
      { status: 502 }
    );
  }
  return NextResponse.json({ ok: true, cities: result.cities });
}
