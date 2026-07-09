import { NextRequest, NextResponse } from "next/server";
import { requireSheetsUser } from "@/lib/apiAuth";
import { loadCatalog } from "@/lib/catalog";
import { parseManualPlaces } from "@/lib/manualPlaces";
import { packItems, placesToCdekPackages } from "@/lib/packing";
import { calcTariffs, checkPvzLimits, checkSpecificPvz } from "@/lib/cdek";
import type {
  DeliveryMode,
  PackingDto,
  QuoteRequest,
  QuoteResponse,
} from "@/lib/types";

const VALID_MODES: DeliveryMode[] = [
  "warehouse-warehouse",
  "warehouse-door",
  "door-warehouse",
  "door-door",
];

/**
 * Полный расчёт доставки СДЭК.
 *
 * Никаким данным о весе и габаритах с frontend не доверяем: сервер заново
 * читает актуальную таблицу от имени текущего пользователя, заново считает
 * упаковочные места, валидирует их и только после этого вызывает СДЭК.
 */
export async function POST(request: NextRequest) {
  // 1–2. Авторизация и доступ к таблице
  const user = await requireSheetsUser();
  if (!user.ok) {
    return NextResponse.json(
      { ok: false, message: user.message },
      { status: user.status }
    );
  }

  let body: QuoteRequest;
  try {
    body = (await request.json()) as QuoteRequest;
  } catch {
    return NextResponse.json(
      { ok: false, message: "Некорректный запрос." },
      { status: 400 }
    );
  }

  const items = (body.items ?? []).map((item) => ({
    article: String(item.article ?? ""),
    qty: Number(item.qty),
  }));
  if (items.length > 100) {
    return NextResponse.json(
      { ok: false, message: "Слишком много позиций (максимум 100)." },
      { status: 400 }
    );
  }
  const fromCode = Number(body.fromCode);
  const toCode = Number(body.toCode);
  const mode = body.mode;
  const fromAddress = String(body.fromAddress ?? "").trim().slice(0, 200);
  const toAddress = String(body.toAddress ?? "").trim().slice(0, 200);
  const fromPvzCode = String(body.fromPvzCode ?? "").trim().slice(0, 40);
  const toPvzCode = String(body.toPvzCode ?? "").trim().slice(0, 40);

  // Ручные места: значения приходят от пользователя, но сервер их валидирует
  const manualPlacesResult = parseManualPlaces(body.manualPlaces);
  if (!manualPlacesResult.ok) {
    return NextResponse.json(
      { ok: false, message: manualPlacesResult.message },
      { status: 400 }
    );
  }
  const manualPlaces = manualPlacesResult.places;

  // 6. Данные отправления/получения заполнены
  if (items.length === 0 && manualPlaces.length === 0) {
    return NextResponse.json(
      { ok: false, message: "Добавьте позицию или ручное место." },
      { status: 400 }
    );
  }
  if (!Number.isFinite(fromCode) || fromCode <= 0) {
    return NextResponse.json(
      { ok: false, message: "Укажите город отправления." },
      { status: 400 }
    );
  }
  if (!Number.isFinite(toCode) || toCode <= 0) {
    return NextResponse.json(
      { ok: false, message: "Укажите город назначения." },
      { status: 400 }
    );
  }
  if (!VALID_MODES.includes(mode)) {
    return NextResponse.json(
      { ok: false, message: "Укажите режим доставки." },
      { status: 400 }
    );
  }

  // 3–5. Свежие данные из таблицы (без кэша), пересчёт и валидация мест.
  // Ручные места в ответе не участвуют в packing (клиент показывает их сам),
  // но входят в отправку СДЭК и проверки лимитов.
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
      const response: QuoteResponse = {
        ok: false,
        message:
          "Расчёт доставки невозможен: не по всем позициям есть корректные упаковочные данные.",
        packing,
      };
      return NextResponse.json(response, { status: 422 });
    }
  }

  const allPlaces = [...packing.places, ...manualPlaces];
  const totalPlaces = allPlaces.reduce((sum, p) => sum + p.count, 0);
  const totalWeightKg = allPlaces.reduce((s, p) => s + p.weightKg * p.count, 0);

  // Вызов СДЭК + проверка ограничений ПВЗ (вес/габариты) для сторон «склад»
  const [cdek, fromPvzWarning, toPvzWarning] = await Promise.all([
    calcTariffs({
      fromCode,
      toCode,
      mode,
      packages: placesToCdekPackages(allPlaces),
      fromAddress: fromAddress || undefined,
      toAddress: toAddress || undefined,
    }),
    mode.startsWith("warehouse")
      ? fromPvzCode
        ? checkSpecificPvz(fromCode, "from", fromPvzCode, allPlaces)
        : checkPvzLimits(fromCode, "from", allPlaces)
      : Promise.resolve(null),
    mode.endsWith("warehouse")
      ? toPvzCode
        ? checkSpecificPvz(toCode, "to", toPvzCode, allPlaces)
        : checkPvzLimits(toCode, "to", allPlaces)
      : Promise.resolve(null),
  ]);
  const pvzWarnings = [fromPvzWarning, toPvzWarning].filter(
    (w): w is string => w !== null
  );

  // Лимиты ПВЗ в API СДЭК заданы на одно место; общий объём отправки пункты
  // не декларируют — для крупных партий предупреждаем отдельно.
  if (
    mode.includes("warehouse") &&
    (totalPlaces > 10 || totalWeightKg > 300)
  ) {
    pvzWarnings.push(
      `Крупная отправка (${totalPlaces} мест, ${Math.round(totalWeightKg * 10) / 10} кг): не каждый ПВЗ примет такой объём целиком — уточните возможность приёма в СДЭК или рассмотрите доставку до двери.`
    );
  }

  if (!cdek.ok) {
    const response: QuoteResponse = { ok: false, message: cdek.message, packing };
    return NextResponse.json(response, { status: 502 });
  }

  const response: QuoteResponse = {
    ok: true,
    packing,
    tariffs: cdek.tariffs,
    warnings: [
      ...packing.warnings,
      ...pvzWarnings,
      ...(cdek.note ? [cdek.note] : []),
    ],
  };
  return NextResponse.json(response);
}
