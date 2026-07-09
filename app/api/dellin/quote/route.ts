import { NextRequest, NextResponse } from "next/server";
import { requireSheetsUser } from "@/lib/apiAuth";
import { loadCatalog } from "@/lib/catalog";
import { calcDellinTariffs } from "@/lib/dellin";
import { parseManualPlaces } from "@/lib/manualPlaces";
import { packItems } from "@/lib/packing";
import type {
  DeliveryMode,
  DellinQuoteRequest,
  DellinQuoteResponse,
  PackingDto,
  PositionInput,
} from "@/lib/types";

const VALID_MODES: DeliveryMode[] = [
  "warehouse-warehouse",
  "warehouse-door",
  "door-warehouse",
  "door-door",
];

export async function POST(request: NextRequest) {
  const user = await requireSheetsUser();
  if (!user.ok) {
    return NextResponse.json(
      { ok: false, message: user.message },
      { status: user.status }
    );
  }

  let body: DellinQuoteRequest;
  try {
    body = (await request.json()) as DellinQuoteRequest;
  } catch {
    return NextResponse.json(
      { ok: false, message: "Некорректный запрос." },
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

  const mode = body.mode;
  const fromCityCode = String(body.fromCityCode ?? "").trim();
  const toCityCode = String(body.toCityCode ?? "").trim();
  const fromCityName = String(body.fromCityName ?? "").trim().slice(0, 200);
  const toCityName = String(body.toCityName ?? "").trim().slice(0, 200);
  const fromAddress = String(body.fromAddress ?? "").trim().slice(0, 200);
  const toAddress = String(body.toAddress ?? "").trim().slice(0, 200);
  const fromStreetCode = String(body.fromStreetCode ?? "").trim().slice(0, 40);
  const fromHouse = String(body.fromHouse ?? "").trim().slice(0, 7);
  const fromFlat = String(body.fromFlat ?? "").trim().slice(0, 20);
  const toStreetCode = String(body.toStreetCode ?? "").trim().slice(0, 40);
  const toHouse = String(body.toHouse ?? "").trim().slice(0, 7);
  const toFlat = String(body.toFlat ?? "").trim().slice(0, 20);
  const fromTerminalId = Number(body.fromTerminalId);
  const toTerminalId = Number(body.toTerminalId);

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
  if (!fromCityCode) {
    return NextResponse.json(
      { ok: false, message: "Укажите город отправления для Деловых Линий." },
      { status: 400 }
    );
  }
  if (!toCityCode) {
    return NextResponse.json(
      { ok: false, message: "Укажите город назначения для Деловых Линий." },
      { status: 400 }
    );
  }
  if (!VALID_MODES.includes(mode)) {
    return NextResponse.json(
      { ok: false, message: "Укажите режим доставки." },
      { status: 400 }
    );
  }
  if (mode.startsWith("door") && (!fromStreetCode || !fromHouse)) {
    return NextResponse.json(
      { ok: false, message: "Выберите улицу и укажите дом забора для Деловых Линий." },
      { status: 400 }
    );
  }
  if (mode.endsWith("door") && (!toStreetCode || !toHouse)) {
    return NextResponse.json(
      { ok: false, message: "Выберите улицу и укажите дом доставки для Деловых Линий." },
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
    const catalogResult = await loadCatalog(user.accessToken, { fresh: true });
    if (!catalogResult.ok) {
      return NextResponse.json(
        { ok: false, message: catalogResult.message },
        { status: 502 }
      );
    }
    packing = packItems(items, catalogResult.catalog);
    if (!packing.canShip) {
      const response: DellinQuoteResponse = {
        ok: false,
        message:
          "Расчет доставки невозможен: не по всем позициям есть корректные упаковочные данные.",
        packing,
      };
      return NextResponse.json(response, { status: 422 });
    }
  }

  const allPlaces = [...packing.places, ...manualPlaces];
  const result = await calcDellinTariffs({
    fromCityCode,
    toCityCode,
    fromCityName,
    toCityName,
    mode,
    fromAddress: fromAddress || undefined,
    toAddress: toAddress || undefined,
    fromStreetCode: fromStreetCode || undefined,
    fromHouse: fromHouse || undefined,
    fromFlat: fromFlat || undefined,
    toStreetCode: toStreetCode || undefined,
    toHouse: toHouse || undefined,
    toFlat: toFlat || undefined,
    fromTerminalId:
      mode.startsWith("warehouse") &&
      Number.isFinite(fromTerminalId) &&
      fromTerminalId > 0
        ? fromTerminalId
        : undefined,
    toTerminalId:
      mode.endsWith("warehouse") &&
      Number.isFinite(toTerminalId) &&
      toTerminalId > 0
        ? toTerminalId
        : undefined,
    places: allPlaces,
  });

  if (!result.ok) {
    const response: DellinQuoteResponse = {
      ok: false,
      message: result.message,
      packing,
    };
    return NextResponse.json(response, { status: 502 });
  }

  const response: DellinQuoteResponse = {
    ok: true,
    packing,
    tariffs: result.tariffs,
    terminals: result.terminals,
    warnings: [...packing.warnings, ...result.warnings],
  };
  return NextResponse.json(response);
}
