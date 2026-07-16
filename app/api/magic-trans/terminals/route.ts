import { NextRequest, NextResponse } from "next/server";
import { requireSheetsUser } from "@/lib/apiAuth";
import { terminalsForMagicTransCity } from "@/lib/magicTrans";

export async function GET(request: NextRequest) {
  try {
    const user = await requireSheetsUser();
    if (!user.ok) {
      return NextResponse.json({ ok: false, message: user.message }, { status: user.status });
    }

    const cityId = request.nextUrl.searchParams.get("cityId")?.trim() ?? "";
    if (!cityId) {
      return NextResponse.json(
        { ok: false, message: "Не указан город для подбора терминалов Magic Trans." },
        { status: 400 }
      );
    }

    const result = await terminalsForMagicTransCity(cityId);
    if (!result.ok) {
      return NextResponse.json({ ok: false, message: result.message }, { status: 502 });
    }
    return NextResponse.json({ ok: true, terminals: result.terminals });
  } catch {
    return NextResponse.json(
      { ok: false, message: "Внутренняя ошибка при обращении к Magic Trans." },
      { status: 500 }
    );
  }
}
