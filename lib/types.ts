/**
 * Общие типы API калькулятора.
 * Файл импортируется и сервером, и клиентом — никаких секретов и server-only.
 */

export interface ProductSuggestion {
  article: string;
  name: string;
  /** Заполнены ли ДШВ и вес одной единицы */
  unitDataComplete: boolean;
  /** Размеры доступных групповых упаковок, шт */
  ruleQtys: number[];
}

export interface PositionInput {
  article: string;
  qty: number;
}

/** Одинаковые упаковочные места, сгруппированные по типу */
export interface PlaceDto {
  article: string;
  /** Например: «Упаковка 6 шт» или «Поштучно (1 шт)» */
  label: string;
  unitsPerPlace: number;
  /** Сколько таких мест */
  count: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  weightKg: number;
  /** Объём одного места, м³ */
  volumeM3: number;
}

export interface ItemPackingDto {
  article: string;
  name: string;
  requestedQty: number;
  warnings: string[];
  errors: string[];
}

export interface PackingDto {
  items: ItemPackingDto[];
  places: PlaceDto[];
  totalPlaces: number;
  totalWeightKg: number;
  totalVolumeM3: number;
  warnings: string[];
  errors: string[];
  /** Можно ли отправлять такой набор мест в СДЭК */
  canShip: boolean;
}

export interface CityDto {
  code: number;
  name: string;
}

export type DeliveryMode =
  | "warehouse-warehouse"
  | "warehouse-door"
  | "door-warehouse"
  | "door-door";

export const DELIVERY_MODE_LABELS: Record<DeliveryMode, string> = {
  "warehouse-warehouse": "Склад — склад",
  "warehouse-door": "Склад — дверь",
  "door-warehouse": "Дверь — склад",
  "door-door": "Дверь — дверь",
};

export interface TariffDto {
  code: number;
  name: string;
  description?: string;
  deliveryMode: number;
  deliverySum: number;
  periodMin: number;
  periodMax: number;
}

export interface QuoteRequest {
  items: PositionInput[];
  fromCode: number;
  toCode: number;
  mode: DeliveryMode;
  /** Улица и дом — для сторон с доставкой «дверь» (на стоимость влияет редко) */
  fromAddress?: string;
  toAddress?: string;
  /** Конкретные ПВЗ — для сторон «склад» (для проверки лимитов) */
  fromPvzCode?: string;
  toPvzCode?: string;
  /** Ручные места (без номенклатуры) — сервер валидирует значения */
  manualPlaces?: ManualPlaceInput[];
}

// ---------- ПВЗ и их ограничения ----------

export interface PvzDims {
  a: number;
  b: number;
  c: number;
}

export interface PvzDto {
  code: string;
  name: string;
  address: string;
  weightMinKg: number | null;
  weightMaxKg: number | null;
  /** Габаритные лимиты (обычно у постаматов; у ПВЗ чаще пусто = нет лимита) */
  dims: PvzDims[];
}

/** ПВЗ в результатах поиска по улице; distanceM задан, когда пункт подобран по близости */
export interface PvzSearchItem extends PvzDto {
  distanceM?: number;
}

/** Ручное упаковочное место (без привязки к номенклатуре) */
export interface ManualPlaceInput {
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  weightKg: number;
  /** Сколько одинаковых мест */
  count: number;
}

export interface PlaceLimitInput {
  weightKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  label?: string;
}

/**
 * Проверка упаковочных мест против лимитов конкретного ПВЗ.
 * Возвращает описание первой найденной проблемы или null, если всё проходит.
 * Чистая функция — используется и на сервере, и на клиенте для мгновенной
 * подсказки (решающая проверка всё равно выполняется на сервере).
 */
export function pvzFitProblem(
  pvz: PvzDto,
  places: PlaceLimitInput[]
): string | null {
  for (const place of places) {
    const label = place.label ? `«${place.label}» ` : "";
    if (pvz.weightMaxKg !== null && place.weightKg > pvz.weightMaxKg) {
      return `место ${label}весом ${place.weightKg} кг превышает лимит ПВЗ (${pvz.weightMaxKg} кг)`;
    }
    if (pvz.weightMinKg !== null && place.weightKg < pvz.weightMinKg) {
      return `место ${label}весом ${place.weightKg} кг меньше минимального веса ПВЗ (${pvz.weightMinKg} кг)`;
    }
    if (pvz.dims.length > 0) {
      const p = [place.lengthCm, place.widthCm, place.heightCm].sort(
        (x, y) => y - x
      );
      const fits = pvz.dims.some((d) => {
        const s = [d.a, d.b, d.c].sort((x, y) => y - x);
        return p[0] <= s[0] && p[1] <= s[1] && p[2] <= s[2];
      });
      if (!fits) {
        return `место ${label}${place.lengthCm}×${place.widthCm}×${place.heightCm} см не проходит по габаритам ПВЗ`;
      }
    }
  }
  return null;
}

export interface QuoteResponse {
  ok: boolean;
  /** Общая ошибка (нет тарифов, СДЭК недоступен и т.п.) */
  message?: string;
  packing?: PackingDto;
  tariffs?: TariffDto[];
  warnings?: string[];
}

export interface ApiError {
  ok: false;
  message: string;
}
