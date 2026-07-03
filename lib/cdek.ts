import "server-only";

import type {
  CityDto,
  DeliveryMode,
  PlaceLimitInput,
  PvzDto,
  PvzSearchItem,
  TariffDto,
} from "@/lib/types";
import { pvzFitProblem } from "@/lib/types";

/**
 * Интеграция с API СДЭК v2.
 *
 * Вызывается только с сервера, использует credentials приложения
 * (CDEK_CLIENT_ID / CDEK_CLIENT_SECRET) и не зависит от Google-аккаунта
 * пользователя. Секреты и токены не логируются.
 */

const DEFAULT_BASE_URL = "https://api.cdek.ru/v2";

export function getCdekConfig():
  | { ok: true; clientId: string; clientSecret: string; baseUrl: string }
  | { ok: false; message: string } {
  const clientId = process.env.CDEK_CLIENT_ID?.trim();
  const clientSecret = process.env.CDEK_CLIENT_SECRET?.trim();
  const baseUrl =
    process.env.CDEK_API_URL?.trim().replace(/\/$/, "") || DEFAULT_BASE_URL;
  if (!clientId || !clientSecret) {
    return {
      ok: false,
      message:
        "Интеграция СДЭК не настроена: задайте CDEK_CLIENT_ID и CDEK_CLIENT_SECRET в .env.local и перезапустите сервер.",
    };
  }
  return { ok: true, clientId, clientSecret, baseUrl };
}

// ---------- OAuth token с кэшем ----------

let tokenCache: { token: string; expiresAt: number } | null = null;

async function getCdekToken(): Promise<
  { ok: true; token: string; baseUrl: string } | { ok: false; message: string }
> {
  const config = getCdekConfig();
  if (!config.ok) return config;

  if (tokenCache && tokenCache.expiresAt > Date.now() + 30_000) {
    return { ok: true, token: tokenCache.token, baseUrl: config.baseUrl };
  }

  let response: Response;
  try {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: config.clientSecret,
    });
    response = await fetch(`${config.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      cache: "no-store",
    });
  } catch {
    return {
      ok: false,
      message: "Не удалось соединиться с сервером СДЭК. Попробуйте позже.",
    };
  }

  if (!response.ok) {
    // Тело ответа намеренно не включаем в сообщение и не логируем
    return {
      ok: false,
      message:
        response.status === 400 || response.status === 401
          ? "СДЭК не принял учётные данные приложения. Проверьте CDEK_CLIENT_ID и CDEK_CLIENT_SECRET."
          : `Сервер СДЭК недоступен (HTTP ${response.status}). Попробуйте позже.`,
    };
  }

  const data = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) {
    return { ok: false, message: "СДЭК не вернул токен авторизации." };
  }

  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  return { ok: true, token: data.access_token, baseUrl: config.baseUrl };
}

// ---------- Подсказки городов ----------

export async function suggestCities(
  query: string
): Promise<{ ok: true; cities: CityDto[] } | { ok: false; message: string }> {
  const auth = await getCdekToken();
  if (!auth.ok) return auth;

  const headers = { Authorization: `Bearer ${auth.token}` };

  try {
    // Основной эндпоинт подсказок
    const suggestUrl = `${auth.baseUrl}/location/suggest/cities?name=${encodeURIComponent(query)}`;
    let response = await fetch(suggestUrl, { headers, cache: "no-store" });

    if (response.ok) {
      const data = (await response.json()) as {
        code?: number;
        full_name?: string;
      }[];
      if (Array.isArray(data)) {
        return {
          ok: true,
          cities: data
            .filter((c) => typeof c.code === "number")
            .slice(0, 8)
            .map((c) => ({ code: c.code!, name: c.full_name ?? String(c.code) })),
        };
      }
    }

    // Запасной вариант: точный поиск по названию города
    const citiesUrl = `${auth.baseUrl}/location/cities?city=${encodeURIComponent(query)}&size=8`;
    response = await fetch(citiesUrl, { headers, cache: "no-store" });
    if (!response.ok) {
      return {
        ok: false,
        message: `СДЭК не смог найти города (HTTP ${response.status}).`,
      };
    }
    const data = (await response.json()) as {
      code?: number;
      city?: string;
      region?: string;
    }[];
    return {
      ok: true,
      cities: (Array.isArray(data) ? data : [])
        .filter((c) => typeof c.code === "number")
        .map((c) => ({
          code: c.code!,
          name: [c.city, c.region].filter(Boolean).join(", "),
        })),
    };
  } catch {
    return {
      ok: false,
      message: "Не удалось получить список городов от СДЭК.",
    };
  }
}

// ---------- Расчёт тарифов ----------

/** Соответствие режимов доставки кодам delivery_mode СДЭК */
const MODE_TO_DELIVERY_MODES: Record<DeliveryMode, number[]> = {
  "door-door": [1],
  "door-warehouse": [2],
  "warehouse-door": [3],
  "warehouse-warehouse": [4],
};

export interface CdekPackage {
  weight: number; // граммы
  length: number; // см
  width: number; // см
  height: number; // см
}

export async function calcTariffs(params: {
  fromCode: number;
  toCode: number;
  mode: DeliveryMode;
  packages: CdekPackage[];
  fromAddress?: string;
  toAddress?: string;
}): Promise<
  | { ok: true; tariffs: TariffDto[]; note?: string }
  | { ok: false; message: string }
> {
  const auth = await getCdekToken();
  if (!auth.ok) return auth;

  let response: Response;
  try {
    response = await fetch(`${auth.baseUrl}/calculator/tarifflist`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: 1, // интернет-магазин
        currency: 1, // RUB
        lang: "rus",
        from_location: {
          code: params.fromCode,
          ...(params.fromAddress ? { address: params.fromAddress } : {}),
        },
        to_location: {
          code: params.toCode,
          ...(params.toAddress ? { address: params.toAddress } : {}),
        },
        packages: params.packages,
      }),
      cache: "no-store",
    });
  } catch {
    return {
      ok: false,
      message: "Не удалось соединиться с сервером СДЭК. Попробуйте позже.",
    };
  }

  interface RawTariff {
    tariff_code?: number;
    tariff_name?: string;
    tariff_description?: string;
    delivery_mode?: number | string;
    delivery_sum?: number;
    period_min?: number;
    period_max?: number;
  }
  interface RawResponse {
    tariff_codes?: RawTariff[];
    errors?: { code?: string; message?: string }[];
  }

  let data: RawResponse;
  try {
    data = (await response.json()) as RawResponse;
  } catch {
    return {
      ok: false,
      message: `СДЭК вернул некорректный ответ (HTTP ${response.status}).`,
    };
  }

  if (data.errors && data.errors.length > 0) {
    return { ok: false, message: mapCdekErrors(data.errors) };
  }
  if (!response.ok) {
    return {
      ok: false,
      message: `СДЭК не смог рассчитать доставку (HTTP ${response.status}).`,
    };
  }

  const all = (data.tariff_codes ?? [])
    .filter((t) => typeof t.tariff_code === "number")
    .map<TariffDto>((t) => ({
      code: t.tariff_code!,
      name: t.tariff_name ?? `Тариф ${t.tariff_code}`,
      description: t.tariff_description,
      deliveryMode: Number(t.delivery_mode ?? 0),
      deliverySum: t.delivery_sum ?? 0,
      periodMin: t.period_min ?? 0,
      periodMax: t.period_max ?? 0,
    }));

  if (all.length === 0) {
    return {
      ok: false,
      message: "СДЭК не смог рассчитать доставку по этому направлению.",
    };
  }

  const allowed = MODE_TO_DELIVERY_MODES[params.mode];
  const filtered = all
    .filter((t) => allowed.includes(t.deliveryMode))
    .sort((a, b) => a.deliverySum - b.deliverySum);

  if (filtered.length === 0) {
    return {
      ok: true,
      tariffs: [],
      note:
        "Для выбранного режима доставки СДЭК не вернул тарифов. Попробуйте другой режим — по этому направлению есть варианты в других режимах.",
    };
  }

  return { ok: true, tariffs: filtered };
}

// ---------- ПВЗ: справочник и ограничения ----------

interface PvzPoint extends PvzDto {
  isHandout: boolean;
  isReception: boolean;
  lat: number | null;
  lon: number | null;
}

const dpCache = new Map<number, { points: PvzPoint[]; at: number }>();
const DP_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // списки ПВЗ меняются редко
const DP_CACHE_MAX = 100; // городов в кэше

function rememberDp(cityCode: number, points: PvzPoint[]) {
  if (dpCache.size >= DP_CACHE_MAX) {
    const oldest = dpCache.keys().next().value;
    if (oldest !== undefined) dpCache.delete(oldest);
  }
  dpCache.set(cityCode, { points, at: Date.now() });
}

async function getPvzPoints(cityCode: number): Promise<PvzPoint[] | null> {
  const cached = dpCache.get(cityCode);
  if (cached && Date.now() - cached.at < DP_CACHE_TTL_MS) {
    return cached.points;
  }

  const auth = await getCdekToken();
  if (!auth.ok) return null;

  try {
    const response = await fetch(
      `${auth.baseUrl}/deliverypoints?city_code=${cityCode}&type=PVZ`,
      { headers: { Authorization: `Bearer ${auth.token}` }, cache: "no-store" }
    );
    if (!response.ok) return null;
    const data = (await response.json()) as {
      code?: string;
      name?: string;
      location?: {
        address?: string;
        address_full?: string;
        latitude?: number;
        longitude?: number;
      };
      weight_min?: number;
      weight_max?: number;
      dimensions?: { width?: number; height?: number; depth?: number }[];
      is_handout?: boolean;
      is_reception?: boolean;
    }[];
    if (!Array.isArray(data)) return null;

    const points: PvzPoint[] = data
      .filter((p) => typeof p.code === "string" && p.code !== "")
      .map((p) => ({
        code: p.code!,
        name: p.name ?? p.code!,
        address: p.location?.address ?? p.location?.address_full ?? "",
        weightMinKg:
          typeof p.weight_min === "number" && p.weight_min > 0
            ? p.weight_min
            : null,
        weightMaxKg:
          typeof p.weight_max === "number" && p.weight_max > 0
            ? p.weight_max
            : null,
        dims: (p.dimensions ?? [])
          .filter(
            (d) => (d.width ?? 0) > 0 && (d.height ?? 0) > 0 && (d.depth ?? 0) > 0
          )
          .map((d) => ({ a: d.width!, b: d.height!, c: d.depth! })),
        isHandout: p.is_handout !== false,
        isReception: p.is_reception !== false,
        lat:
          typeof p.location?.latitude === "number" ? p.location.latitude : null,
        lon:
          typeof p.location?.longitude === "number"
            ? p.location.longitude
            : null,
      }));
    rememberDp(cityCode, points);
    return points;
  } catch {
    return null;
  }
}

function sidePoints(points: PvzPoint[], side: "from" | "to"): PvzPoint[] {
  return points.filter((p) => (side === "to" ? p.isHandout : p.isReception));
}

/** Поиск ПВЗ города по началу/части адреса, названия или кода */
export async function searchPvz(
  cityCode: number,
  side: "from" | "to",
  query: string
): Promise<{ ok: true; points: PvzDto[] } | { ok: false; message: string }> {
  const points = await getPvzPoints(cityCode);
  if (!points) {
    return { ok: false, message: "Не удалось получить список ПВЗ от СДЭК." };
  }
  const relevant = sidePoints(points, side);
  const q = query.trim().toLowerCase();
  const filtered =
    q === ""
      ? relevant
      : relevant.filter(
          (p) =>
            p.address.toLowerCase().includes(q) ||
            p.name.toLowerCase().includes(q) ||
            p.code.toLowerCase().includes(q)
        );
  return {
    ok: true,
    points: filtered.slice(0, 10).map((p) => ({
      code: p.code,
      name: p.name,
      address: p.address,
      weightMinKg: p.weightMinKg,
      weightMaxKg: p.weightMaxKg,
      dims: p.dims,
    })),
  };
}

// ---------- Геокодирование улицы (для подбора ближайших ПВЗ) ----------

const geoCache = new Map<string, { lat: number; lon: number } | null>();
const GEO_CACHE_MAX = 500; // защита от неограниченного роста в долгоживущем процессе

function rememberGeo(query: string, value: { lat: number; lon: number } | null) {
  if (geoCache.size >= GEO_CACHE_MAX) {
    const oldest = geoCache.keys().next().value;
    if (oldest !== undefined) geoCache.delete(oldest);
  }
  geoCache.set(query, value);
}

/** Координаты адреса через OpenStreetMap Nominatim (без ключей, для внутреннего инструмента) */
async function geocode(
  query: string
): Promise<{ lat: number; lon: number } | null> {
  const cached = geoCache.get(query);
  if (cached !== undefined) return cached;

  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=ru&countrycodes=ru&q=${encodeURIComponent(query)}`,
      {
        headers: { "User-Agent": "cdek-dsv-calculator/1.0 (internal tool)" },
        cache: "no-store",
      }
    );
    if (!response.ok) {
      rememberGeo(query, null);
      return null;
    }
    const data = (await response.json()) as { lat?: string; lon?: string }[];
    const first = Array.isArray(data) ? data[0] : undefined;
    const result =
      first?.lat && first?.lon
        ? { lat: Number.parseFloat(first.lat), lon: Number.parseFloat(first.lon) }
        : null;
    rememberGeo(query, result);
    return result;
  } catch {
    geoCache.set(query, null);
    return null;
  }
}

function haversineM(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number
): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) *
      Math.cos((bLat * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

/** Ближайшие к точке ПВЗ города, отсортированные по расстоянию */
async function nearestPvz(
  cityCode: number,
  side: "from" | "to",
  geo: { lat: number; lon: number },
  limit = 8
): Promise<{ pvz: PvzDto; distanceM: number }[] | null> {
  const points = await getPvzPoints(cityCode);
  if (!points) return null;
  return sidePoints(points, side)
    .filter((p) => p.lat !== null && p.lon !== null)
    .map((p) => ({
      pvz: {
        code: p.code,
        name: p.name,
        address: p.address,
        weightMinKg: p.weightMinKg,
        weightMaxKg: p.weightMaxKg,
        dims: p.dims,
      },
      distanceM: haversineM(geo.lat, geo.lon, p.lat!, p.lon!),
    }))
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, limit);
}

/**
 * Поиск ПВЗ по улице/адресу внутри выбранного города:
 *  1) ПВЗ, в адресе которых встречается запрос (прямое совпадение);
 *  2) если таких нет — адрес геокодируется, и возвращаются ближайшие
 *     ПВЗ с расстоянием (как на сайте СДЭК);
 *  3) пустой запрос — первые пункты города.
 */
export async function searchPvzSmart(
  cityCode: number,
  cityName: string,
  side: "from" | "to",
  query: string
): Promise<
  { ok: true; points: PvzSearchItem[] } | { ok: false; message: string }
> {
  const direct = await searchPvz(cityCode, side, query);
  if (!direct.ok) return direct;
  if (direct.points.length > 0 || query.trim() === "") {
    return direct;
  }

  const cityShort = cityName.split(",")[0].trim();
  const geo = await geocode(`${query.trim()}, ${cityShort}, Россия`);
  if (geo) {
    const nearest = await nearestPvz(cityCode, side, geo);
    if (nearest && nearest.length > 0) {
      return {
        ok: true,
        points: nearest.map(({ pvz, distanceM }) => ({ ...pvz, distanceM })),
      };
    }
  }

  return { ok: true, points: [] };
}

/**
 * Проверка мест против лимитов конкретного ПВЗ (выбранного менеджером).
 * Возвращает текст предупреждения или null.
 */
export async function checkSpecificPvz(
  cityCode: number,
  side: "from" | "to",
  pvzCode: string,
  places: PlaceLimitInput[]
): Promise<string | null> {
  if (places.length === 0) return null;
  const points = await getPvzPoints(cityCode);
  if (!points) return null;
  const point = points.find((p) => p.code === pvzCode);
  if (!point) return null;

  const problem = pvzFitProblem(point, places);
  if (!problem) return null;

  const action = side === "to" ? "доставить груз в" : "отправить груз из";
  return `Невозможно ${action} ПВЗ ${point.name} (${point.address}): ${problem}. Выберите другой ПВЗ или режим «до двери».`;
}

/**
 * Общая проверка мест против ограничений всех ПВЗ города
 * (когда конкретный ПВЗ не выбран). Возвращает предупреждение или null.
 */
export async function checkPvzLimits(
  cityCode: number,
  side: "from" | "to",
  places: PlaceLimitInput[]
): Promise<string | null> {
  if (places.length === 0) return null;
  const points = await getPvzPoints(cityCode);
  if (!points || points.length === 0) return null;

  const relevant = sidePoints(points, side);
  if (relevant.length === 0) return null;

  const fitCount = relevant.filter((p) => pvzFitProblem(p, places) === null)
    .length;
  if (fitCount === relevant.length) return null;

  const heaviest = Math.max(...places.map((p) => p.weightKg));
  const sideText = side === "to" ? "городе назначения" : "городе отправления";

  if (fitCount === 0) {
    return (
      `Ни один из ${relevant.length} ПВЗ в ${sideText} не примет такие места ` +
      `(самое тяжёлое — ${heaviest} кг): у пунктов есть ограничения по весу и габаритам. ` +
      `Выберите режим доставки «до двери» или уменьшите места.`
    );
  }

  return (
    `Ограничения ПВЗ: только ${fitCount} из ${relevant.length} пунктов в ${sideText} ` +
    `примут такие места (самое тяжёлое — ${heaviest} кг). ` +
    `Выберите конкретный ПВЗ в поле адреса — приложение проверит его лимиты.`
  );
}

function mapCdekErrors(
  errors: { code?: string; message?: string }[]
): string {
  const texts = errors.map((e) => {
    const code = e.code ?? "";
    if (/weight|oversize|size|dimension/i.test(code)) {
      return "СДЭК отклонил груз из-за некорректных габаритов или веса.";
    }
    if (/location|city|not_found/i.test(code)) {
      return "СДЭК не распознал город отправления или назначения.";
    }
    return e.message
      ? `СДЭК: ${e.message}`
      : "СДЭК не смог рассчитать доставку по этому направлению.";
  });
  return [...new Set(texts)].join(" ");
}
