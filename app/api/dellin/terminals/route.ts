import { NextRequest, NextResponse } from "next/server";
import { requireSheetsUser } from "@/lib/apiAuth";
import { loadCatalog } from "@/lib/catalog";
import { listDellinTerminals } from "@/lib/dellin";
import { parseManualPlaces } from "@/lib/manualPlaces";
import { packItems } from "@/lib/packing";
import type {
  DellinQuoteRequest,
  PackingDto,
  PositionInput,
} from "@/lib/types";

export async function POST(request: NextRequest) {
  const user = await requireSheetsUser();
  if (!user.ok) {
    return NextResponse.json(
      { ok: false, message: user.message },
      { status: user.status }
    );
  }

  let body: DellinQuoteRequest & {
    cityCode?: string;
    direction?: "derival" | "arrival";
  };
  try {
    body = (await request.json()) as DellinQuoteRequest & {
      cityCode?: string;
      direction?: "derival" | "arrival";
    };
  } catch {
    return NextResponse.json(
      { ok: false, message: "Некорректный запрос." },
      { status: 400 }
    );
  }

  const cityCode = String(body.cityCode ?? "").trim();
  const direction = body.direction;
  if (!cityCode) {
    return NextResponse.json(
      { ok: false, message: "Укажите город для подбора терминалов." },
      { status: 400 }
    );
  }
  if (direction !== "derival" && direction !== "arrival") {
    return NextResponse.json(
      { ok: false, message: "Укажите направление терминала." },
      { status: 400 }
    );
  }

  const items: PositionInput[] = (body.items ?? []).map((item) => ({
    article: String(item.article ?? ""),
    qty: Number(item.qty),
  }));
  if (items.length > 100) {
    return NextResponse.json(
      { ok: false, message: "Слишком много позиций (максимум 100)." },
      { status: 400 }
    );
  }

  const manualPlacesResult = parseManualPlaces(body.manualPlaces);
  if (!manualPlacesResult.ok) {
    return NextResponse.json(
      { ok: false, message: manualPlacesResult.message },
      { status: 400 }
    );
  }
  const manualPlaces = manualPlacesResult.places;

  if (items.length === 0 && manualPlaces.length === 0) {
    return NextResponse.json(
      { ok: false, message: "Добавьте позицию или ручное место." },
      { status: 400 }
    );
  }

  let packing: PackingDto = {
    items: [],
    places: [],
    totalPlaces: 0,
    totalWeightKg: 0,
    totalVolumeM3: 0,
    warnings: [],
    errors: [],
    canShip: false,
  };
  if (items.length > 0) {
    // Для подбора терминалов достаточно кэшированного каталога:
    // свежесть критична только в quote-роутах перед реальным расчётом.
    const catalogResult = await loadCatalog(user.accessToken);
    if (!catalogResult.ok) {
      return NextResponse.json(
        { ok: false, message: catalogResult.message },
        { status: 502 }
      );
    }
    packing = packItems(items, catalogResult.catalog);
    if (!packing.canShip) {
      return NextResponse.json(
        {
          ok: false,
          message:
            "Подбор терминалов невозможен: не по всем позициям есть корректные упаковочные данные.",
          packing,
        },
        { status: 422 }
      );
    }
  }

  const result = await listDellinTerminals({
    cityCode,
    direction,
    places: [...packing.places, ...manualPlaces],
  });
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, message: result.message, packing },
      { status: 502 }
    );
  }

  return NextResponse.json({
    ok: true,
    terminals: result.terminals,
    packing,
  });
}
