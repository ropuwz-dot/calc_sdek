import { NextRequest, NextResponse } from "next/server";
import { requireSheetsUser } from "@/lib/apiAuth";
import { loadCatalog } from "@/lib/catalog";
import { calculateMagicTransDelivery } from "@/lib/magicTrans";
import { parseManualPlaces } from "@/lib/manualPlaces";
import { packItems } from "@/lib/packing";
import type {
  DeliveryMode,
  MagicTransQuoteRequest,
  MagicTransQuoteResponse,
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
  try {
    const user = await requireSheetsUser();
    if (!user.ok) {
      return NextResponse.json({ ok: false, message: user.message }, { status: user.status });
    }

    let body: MagicTransQuoteRequest;
    try {
      body = (await request.json()) as MagicTransQuoteRequest;
    } catch {
      return NextResponse.json({ ok: false, message: "Некорректный запрос." }, { status: 400 });
    }

    const mode = body.mode;
    const fromCityId = String(body.fromCityId ?? "").trim();
    const toCityId = String(body.toCityId ?? "").trim();
    const fromAddress = String(body.fromAddress ?? "").trim().slice(0, 300);
    const toAddress = String(body.toAddress ?? "").trim().slice(0, 300);
    const fromTerminalId = String(body.fromTerminalId ?? "").trim();
    const toTerminalId = String(body.toTerminalId ?? "").trim();
    const declaredValue = Number(body.declaredValue ?? 0);
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
    if (!VALID_MODES.includes(mode)) {
      return NextResponse.json({ ok: false, message: "Укажите режим доставки." }, { status: 400 });
    }
    if (!Number.isFinite(declaredValue) || declaredValue < 0 || declaredValue > 1_000_000_000) {
      return NextResponse.json(
        { ok: false, message: "Укажите корректную объявленную стоимость груза." },
        { status: 400 }
      );
    }
    if (!fromCityId || !toCityId) {
      return NextResponse.json(
        { ok: false, message: "Укажите города отправления и назначения для Magic Trans." },
        { status: 400 }
      );
    }
    if (mode.startsWith("warehouse") && !fromTerminalId) {
      return NextResponse.json(
        { ok: false, message: "Выберите терминал отправления Magic Trans." },
        { status: 400 }
      );
    }
    if (mode.endsWith("warehouse") && !toTerminalId) {
      return NextResponse.json(
        { ok: false, message: "Выберите терминал получения Magic Trans." },
        { status: 400 }
      );
    }
    if (mode.startsWith("door") && !fromAddress) {
      return NextResponse.json(
        { ok: false, message: "Укажите адрес забора для Magic Trans." },
        { status: 400 }
      );
    }
    if (mode.endsWith("door") && !toAddress) {
      return NextResponse.json(
        { ok: false, message: "Укажите адрес доставки для Magic Trans." },
        { status: 400 }
      );
    }

    const manualPlacesResult = parseManualPlaces(body.manualPlaces);
    if (!manualPlacesResult.ok) {
      return NextResponse.json({ ok: false, message: manualPlacesResult.message }, { status: 400 });
    }
    if (items.length === 0 && manualPlacesResult.places.length === 0) {
      return NextResponse.json(
        { ok: false, message: "Добавьте позицию или ручное место." },
        { status: 400 }
      );
    }

    let packing: PackingDto = {
      items: [], places: [], totalPlaces: 0, totalWeightKg: 0, totalVolumeM3: 0,
      warnings: [], errors: [], canShip: false,
    };
    if (items.length > 0) {
      const catalog = await loadCatalog(user.accessToken, { fresh: true });
      if (!catalog.ok) {
        return NextResponse.json({ ok: false, message: catalog.message }, { status: 502 });
      }
      packing = packItems(items, catalog.catalog);
      if (!packing.canShip) {
        const response: MagicTransQuoteResponse = {
          ok: false,
          message: "Расчет доставки невозможен: не по всем позициям есть корректные упаковочные данные.",
          packing,
        };
        return NextResponse.json(response, { status: 422 });
      }
    }

    const result = await calculateMagicTransDelivery({
      fromCityId,
      toCityId,
      fromTerminalId: mode.startsWith("warehouse") ? fromTerminalId : undefined,
      toTerminalId: mode.endsWith("warehouse") ? toTerminalId : undefined,
      fromAddress: mode.startsWith("door") ? fromAddress : undefined,
      toAddress: mode.endsWith("door") ? toAddress : undefined,
      declaredValue,
      mode,
      places: [...packing.places, ...manualPlacesResult.places],
    });
    if (!result.ok) {
      const response: MagicTransQuoteResponse = { ok: false, message: result.message, packing };
      return NextResponse.json(response, { status: 502 });
    }

    const response: MagicTransQuoteResponse = {
      ok: true,
      packing,
      tariffs: [result.tariff],
    };
    return NextResponse.json(response);
  } catch {
    return NextResponse.json(
      { ok: false, message: "Внутренняя ошибка при расчете Magic Trans." },
      { status: 500 }
    );
  }
}
