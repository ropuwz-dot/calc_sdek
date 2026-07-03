import { NextRequest, NextResponse } from "next/server";
import { requireSheetsUser } from "@/lib/apiAuth";
import { loadCatalog } from "@/lib/catalog";
import { packItems } from "@/lib/packing";
import type { PositionInput } from "@/lib/types";

/**
 * Расчёт упаковочных мест для набора позиций (без обращения к СДЭК).
 * Данные о габаритах и весе с frontend не принимаются — только артикул
 * и количество; всё остальное сервер берёт из таблицы.
 */
export async function POST(request: NextRequest) {
  const user = await requireSheetsUser();
  if (!user.ok) {
    return NextResponse.json(
      { ok: false, message: user.message },
      { status: user.status }
    );
  }

  let items: PositionInput[];
  try {
    const body = (await request.json()) as { items?: PositionInput[] };
    items = (body.items ?? []).map((item) => ({
      article: String(item.article ?? ""),
      qty: Number(item.qty),
    }));
  } catch {
    return NextResponse.json(
      { ok: false, message: "Некорректный запрос." },
      { status: 400 }
    );
  }

  if (items.length === 0) {
    return NextResponse.json(
      { ok: false, message: "Добавьте хотя бы одну позицию." },
      { status: 400 }
    );
  }
  if (items.length > 100) {
    return NextResponse.json(
      { ok: false, message: "Слишком много позиций (максимум 100)." },
      { status: 400 }
    );
  }

  const result = await loadCatalog(user.accessToken);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, message: result.message },
      { status: 502 }
    );
  }

  return NextResponse.json({
    ok: true,
    packing: packItems(items, result.catalog),
  });
}
