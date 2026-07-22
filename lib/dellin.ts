import "server-only";

import type { CarrierProbeResult } from "@/lib/carrierDiagnostics";
import type {
  DeliveryMode,
  DellinCityDto,
  DellinStreetDto,
  DellinTerminalDto,
  DellinTariffDto,
  PlaceDto,
} from "@/lib/types";

const DEFAULT_BASE_URL = "https://api.dellin.ru";
const SESSION_TTL_MS = 25 * 24 * 60 * 60 * 1000;

export function getDellinConfig():
  | { ok: true; appKey: string; pat: string; baseUrl: string }
  | { ok: false; message: string } {
  const appKey = process.env.DELLIN_APP_KEY?.trim();
  const pat = process.env.DELLIN_PAT?.trim();
  const baseUrl =
    process.env.DELLIN_API_URL?.trim().replace(/\/$/, "") || DEFAULT_BASE_URL;

  if (!appKey || !pat) {
    return {
      ok: false,
      message:
        "Интеграция Деловых Линий не настроена: задайте DELLIN_APP_KEY и DELLIN_PAT в .env.local и перезапустите сервер.",
    };
  }
  return { ok: true, appKey, pat, baseUrl };
}

interface DellinApiResponse<T> {
  metadata?: { status?: number };
  data?: T;
  errors?: { code?: string; title?: string; detail?: string; message?: string }[];
  error?: { code?: string; title?: string; detail?: string; message?: string };
}

async function postDellin<T>(
  path: string,
  body: Record<string, unknown>,
  options?: { timeoutMs?: number }
): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  const config = getDellinConfig();
  if (!config.ok) return config;

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appkey: config.appKey, ...body }),
      cache: "no-store",
      signal: AbortSignal.timeout(options?.timeoutMs ?? 10_000),
    });
  } catch {
    return {
      ok: false,
      message:
        "Не удалось соединиться с сервером Деловых Линий. Попробуйте позже.",
    };
  }

  let payload: DellinApiResponse<T>;
  try {
    payload = (await response.json()) as DellinApiResponse<T>;
  } catch {
    return {
      ok: false,
      message: `Деловые Линии вернули некорректный ответ (HTTP ${response.status}).`,
    };
  }

  const apiStatus = payload.metadata?.status;
  if (!response.ok || (apiStatus !== undefined && apiStatus >= 400)) {
    return { ok: false, message: mapDellinErrors(payload, response.status) };
  }
  if (payload.errors && payload.errors.length > 0) {
    return { ok: false, message: mapDellinErrors(payload, response.status) };
  }
  if (payload.error) {
    return { ok: false, message: mapDellinErrors(payload, response.status) };
  }
  const data =
    payload.data !== undefined ? payload.data : (payload as unknown as T);
  return { ok: true, data };
}

let sessionCache: { sessionId: string; expiresAt: number } | null = null;

async function getDellinSession(timeoutMs?: number): Promise<
  { ok: true; sessionId: string } | { ok: false; message: string }
> {
  if (sessionCache && sessionCache.expiresAt > Date.now() + 60_000) {
    return { ok: true, sessionId: sessionCache.sessionId };
  }

  const config = getDellinConfig();
  if (!config.ok) return config;

  const result = await postDellin<{
    sessionID?: string;
    sessionId?: string;
    session?: string;
  }>("/v4/auth/login.json", { pat: config.pat }, { timeoutMs });
  if (!result.ok) return result;

  const sessionId =
    result.data.sessionID ?? result.data.sessionId ?? result.data.session;
  if (!sessionId) {
    return {
      ok: false,
      message: "Деловые Линии не вернули sessionID авторизации.",
    };
  }

  sessionCache = {
    sessionId,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  return { ok: true, sessionId };
}

function isSessionError(message: string): boolean {
  return /session|сесси|авториз|unauthorized|401/i.test(message);
}

/**
 * Запрос к методу, требующему sessionID. Если Деловые Линии инвалидировали
 * сессию раньше нашего TTL, кэш сбрасывается и запрос повторяется один раз
 * с новой сессией.
 */
async function postDellinWithSession<T>(
  path: string,
  body: Record<string, unknown>,
  options?: { timeoutMs?: number }
): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  const deadline = options?.timeoutMs ? Date.now() + options.timeoutMs : null;
  const remainingTimeout = () =>
    deadline ? Math.max(1, deadline - Date.now()) : undefined;

  const session = await getDellinSession(remainingTimeout());
  if (!session.ok) return session;

  let result = await postDellin<T>(
    path,
    {
      ...body,
      sessionID: session.sessionId,
    },
    {
      timeoutMs: remainingTimeout(),
    }
  );
  if (!result.ok && isSessionError(result.message)) {
    sessionCache = null;
    const fresh = await getDellinSession(remainingTimeout());
    if (!fresh.ok) return fresh;
    result = await postDellin<T>(
      path,
      {
        ...body,
        sessionID: fresh.sessionId,
      },
      {
        timeoutMs: remainingTimeout(),
      }
    );
  }
  return result;
}

export async function checkDellinHealth(
  timeoutMs = 5_000
): Promise<CarrierProbeResult> {
  const config = getDellinConfig();
  if (!config.ok) {
    return { ok: false, stage: "config", message: config.message };
  }

  const [session, cities] = await Promise.all([
    getDellinSession(timeoutMs),
    postDellin<{ cities?: { cityID?: number }[] }>(
      "/v2/public/kladr.json",
      { q: "Москва", limit: 1 },
      { timeoutMs }
    ),
  ]);
  if (!session.ok) {
    return { ok: false, stage: "auth", message: session.message };
  }
  if (!cities.ok) {
    return { ok: false, stage: "directory", message: cities.message };
  }
  const cityAvailable = cities.data.cities?.some(
    (city) => typeof city.cityID === "number" && city.cityID > 0
  );
  return cityAvailable
    ? { ok: true }
    : {
        ok: false,
        stage: "response",
        message: "Деловые Линии не вернули город в справочнике.",
      };
}

export async function suggestDellinCities(
  query: string
): Promise<{ ok: true; cities: DellinCityDto[] } | { ok: false; message: string }> {
  const q = query.trim();
  if (q.length < 2) return { ok: true, cities: [] };

  const result = await postDellin<{
    cities?: {
      code?: string;
      aString?: string;
      searchString?: string;
      region_name?: string;
      cityID?: number;
      isTerminal?: number;
    }[];
  }>("/v2/public/kladr.json", { q, limit: 8 });
  if (!result.ok) return result;

  return {
    ok: true,
    cities: (result.data.cities ?? [])
      .filter((city) => city.code && typeof city.cityID === "number")
      .map((city) => ({
        code: city.code!,
        cityId: city.cityID!,
        name: city.aString ?? city.searchString ?? city.code!,
        regionName: city.region_name ?? "",
        isTerminal: city.isTerminal === 1,
      })),
  };
}

export async function suggestDellinStreets(params: {
  cityId: number;
  query: string;
}): Promise<
  { ok: true; streets: DellinStreetDto[] } | { ok: false; message: string }
> {
  const q = params.query.trim();
  if (!Number.isFinite(params.cityId) || params.cityId <= 0 || q.length < 2) {
    return { ok: true, streets: [] };
  }

  const result = await postDellinWithSession<{
    streets?: {
      code?: string;
      cityID?: number;
      searchString?: string;
      aString?: string;
    }[];
  }>("/v1/public/kladr_street.json", {
    cityID: params.cityId,
    street: q,
    limit: 10,
  });
  if (!result.ok) return result;

  return {
    ok: true,
    streets: (result.data.streets ?? [])
      .filter((street) => street.code)
      .map((street) => ({
        code: street.code!,
        cityId: street.cityID ?? params.cityId,
        name: street.searchString ?? street.aString ?? street.code!,
        fullName: street.aString ?? street.searchString ?? street.code!,
      })),
  };
}

const DELIVERY_TYPE_LABELS: Record<string, string> = {
  auto: "Автоперевозка",
  express: "Экспресс-перевозка",
  small: "Малогабаритный груз",
  avia: "Авиаперевозка",
  letter: "Документы",
};

function deliverySide(params: {
  variant: "terminal" | "address";
  cityCode: string;
  cityName: string;
  address: string;
  streetCode?: string;
  house?: string;
  flat?: string;
  terminalId?: number;
}) {
  const {
    variant,
    cityCode,
    cityName,
    address,
    streetCode,
    house,
    flat,
    terminalId,
  } = params;
  if (variant === "terminal") {
    return terminalId ? { variant, terminalID: String(terminalId) } : { variant, city: cityCode };
  }
  if (streetCode) {
    return {
      variant,
      address: {
        street: streetCode,
        ...(house ? { house } : {}),
        ...(flat ? { flat } : {}),
      },
    };
  }
  return {
    variant,
    address: {
      search: [cityName, address].filter(Boolean).join(", ").slice(0, 1024),
    },
  };
}

interface DellinCargo {
  quantity: number;
  length: number;
  width: number;
  height: number;
  weight: number;
  totalWeight: number;
  totalVolume: number;
}

function placesToCargo(places: PlaceDto[]): DellinCargo {
  const quantity = places.reduce((sum, place) => sum + place.count, 0);
  const totalWeight = places.reduce(
    (sum, place) => sum + place.weightKg * place.count,
    0
  );
  const totalVolume = places.reduce(
    (sum, place) => sum + place.volumeM3 * place.count,
    0
  );
  // Габариты самого большого (по объёму) реального места — а не максимум
  // по каждой оси независимо: «виртуальное» место из чужих сторон завышает
  // надбавки за габарит.
  const largest = places.reduce((best, place) =>
    place.lengthCm * place.widthCm * place.heightCm >
    best.lengthCm * best.widthCm * best.heightCm
      ? place
      : best
  );
  const maxWeightKg = Math.max(...places.map((place) => place.weightKg));

  return {
    quantity,
    length: roundMeters(largest.lengthCm),
    width: roundMeters(largest.widthCm),
    height: roundMeters(largest.heightCm),
    weight: Math.round(maxWeightKg * 1000) / 1000,
    totalWeight: Math.round(totalWeight * 1000) / 1000,
    totalVolume: Math.max(0.001, Math.round(totalVolume * 1_000_000) / 1_000_000),
  };
}

function roundMeters(cm: number): number {
  return Math.max(0.001, Math.round((cm / 100) * 1000) / 1000);
}

export async function listDellinTerminals(params: {
  cityCode: string;
  direction: "derival" | "arrival";
  places: PlaceDto[];
}): Promise<
  | { ok: true; terminals: DellinTerminalDto[] }
  | { ok: false; message: string }
> {
  if (params.places.length === 0) {
    return { ok: false, message: "Нет упаковочных мест для подбора терминала." };
  }

  const cargo = placesToCargo(params.places);

  const result = await postDellinWithSession<{
    terminals?: {
      id?: number | string;
      default?: boolean;
      name?: string;
      address?: string;
    }[];
  }>("/v1/public/request_terminals.json", {
    code: params.cityCode,
    direction: params.direction,
    maxCargoDimensions: {
      length: cargo.length,
      width: cargo.width,
      height: cargo.height,
      weight: cargo.weight,
      maxVolume: cargo.totalVolume,
      totalVolume: cargo.totalVolume,
      totalWeight: cargo.totalWeight,
    },
  });
  if (!result.ok) return result;

  const terminals = (result.data.terminals ?? [])
    .map((terminal) => {
      const id = Number(terminal.id);
      if (!Number.isFinite(id) || id <= 0) return null;
      return {
        id,
        name: terminal.name ?? "Терминал Деловых Линий",
        address: terminal.address ?? "",
        isDefault: terminal.default === true,
      };
    })
    .filter((terminal): terminal is DellinTerminalDto => terminal !== null)
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name, "ru"));

  if (terminals.length === 0) {
    return {
      ok: false,
      message:
        "Деловые Линии не вернули подходящий терминал для выбранного города.",
    };
  }

  return { ok: true, terminals };
}

async function resolveTerminal(params: {
  cityCode: string;
  direction: "derival" | "arrival";
  places: PlaceDto[];
  selectedTerminalId?: number;
}): Promise<
  | { ok: true; terminal: DellinTerminalDto | undefined }
  | { ok: false; message: string }
> {
  const result = await listDellinTerminals({
    cityCode: params.cityCode,
    direction: params.direction,
    places: params.places,
  });
  if (!result.ok) return result;

  const terminal =
    params.selectedTerminalId !== undefined
      ? result.terminals.find((item) => item.id === params.selectedTerminalId)
      : result.terminals.find((item) => item.isDefault) ?? result.terminals[0];
  if (!terminal) {
    return {
      ok: false,
      message:
        "Выбранный терминал Деловых Линий недоступен для этих мест. Выберите другой терминал.",
    };
  }

  return {
    ok: true,
    terminal,
  };
}

export async function calcDellinTariffs(params: {
  fromCityCode: string;
  toCityCode: string;
  fromCityName: string;
  toCityName: string;
  mode: DeliveryMode;
  places: PlaceDto[];
  fromAddress?: string;
  toAddress?: string;
  fromStreetCode?: string;
  fromHouse?: string;
  fromFlat?: string;
  toStreetCode?: string;
  toHouse?: string;
  toFlat?: string;
  fromTerminalId?: number;
  toTerminalId?: number;
}): Promise<
  | {
      ok: true;
      tariffs: DellinTariffDto[];
      terminals: { derival?: DellinTerminalDto; arrival?: DellinTerminalDto };
      warnings: string[];
    }
  | { ok: false; message: string }
> {
  if (params.places.length === 0) {
    return { ok: false, message: "Нет упаковочных мест для расчета." };
  }

  const derivalVariant = params.mode.startsWith("door")
    ? "address"
    : "terminal";
  const arrivalVariant = params.mode.endsWith("door") ? "address" : "terminal";

  const [derivalTerminal, arrivalTerminal] = await Promise.all([
    derivalVariant === "terminal"
      ? resolveTerminal({
          cityCode: params.fromCityCode,
          direction: "derival",
          places: params.places,
          selectedTerminalId: params.fromTerminalId,
        })
      : Promise.resolve<{ ok: true; terminal: undefined }>({
          ok: true,
          terminal: undefined,
        }),
    arrivalVariant === "terminal"
      ? resolveTerminal({
          cityCode: params.toCityCode,
          direction: "arrival",
          places: params.places,
          selectedTerminalId: params.toTerminalId,
        })
      : Promise.resolve<{ ok: true; terminal: undefined }>({
          ok: true,
          terminal: undefined,
        }),
  ]);

  if (!derivalTerminal.ok) return derivalTerminal;
  if (!arrivalTerminal.ok) return arrivalTerminal;
  const cargo = placesToCargo(params.places);

  const result = await postDellinWithSession<{
    price?: number;
    priceMinimal?: string;
    deliveryTerm?: number;
    availableDeliveryTypes?: Record<string, number | null>;
    information?: string[];
    derival?: { price?: number };
    intercity?: { price?: number };
    arrival?: { price?: number };
    insuranceComponents?: {
      cargoInsurance?: number;
      termInsurance?: number;
    };
    orderDates?: DellinOrderDates;
  }>("/v2/calculator.json", {
    delivery: {
      deliveryType: { type: "auto" },
      derival: deliverySide({
        variant: derivalVariant,
        cityCode: params.fromCityCode,
        cityName: params.fromCityName,
        address: params.fromAddress ?? "",
        streetCode: params.fromStreetCode,
        house: params.fromHouse,
        flat: params.fromFlat,
        terminalId: derivalTerminal.terminal?.id,
      }),
      arrival: deliverySide({
        variant: arrivalVariant,
        cityCode: params.toCityCode,
        cityName: params.toCityName,
        address: params.toAddress ?? "",
        streetCode: params.toStreetCode,
        house: params.toHouse,
        flat: params.toFlat,
        terminalId: arrivalTerminal.terminal?.id,
      }),
    },
    // Примечание: cargo.insurance.statedValue калькулятор ДЛ игнорирует
    // (проверено эмпирически) — страхование груза и срока он считает сам
    // и включает в price; мы показываем его в расшифровке.
    cargo,
  });
  if (!result.ok) {
    return result;
  }

  const period = deliveryPeriod(result.data);

  // availableDeliveryTypes — это стоимость ТОЛЬКО межтерминальной перевозки
  // по каждому виду (совпадает с intercity.price для выбранного вида).
  // Полная цена = межтерминальная + забор от адреса + доставка до адреса +
  // допуслуги (страхование, информирование), которые лежат в data.price.
  const fullPrice =
    typeof result.data.price === "number" ? result.data.price : null;
  const intercityPrice =
    typeof result.data.intercity?.price === "number"
      ? result.data.intercity.price
      : null;
  const derivalPrice = result.data.derival?.price ?? 0;
  const arrivalPrice = result.data.arrival?.price ?? 0;
  // Страхование/информирование и прочие сервисы, добавленные ДЛ в итог
  const extrasPrice =
    fullPrice !== null && intercityPrice !== null
      ? Math.max(
          0,
          Math.round((fullPrice - intercityPrice - derivalPrice - arrivalPrice) * 100) / 100
        )
      : 0;

  const totalFor = (typeIntercity: number): number => {
    // Замещаем межтерминальную часть в полной цене на цену нужного вида
    if (fullPrice !== null && intercityPrice !== null) {
      return Math.round((fullPrice - intercityPrice + typeIntercity) * 100) / 100;
    }
    return Math.round((typeIntercity + derivalPrice + arrivalPrice) * 100) / 100;
  };

  const cargoInsurance = result.data.insuranceComponents?.cargoInsurance ?? 0;
  const termInsurance = result.data.insuranceComponents?.termInsurance ?? 0;
  const servicesPrice = Math.max(
    0,
    Math.round((extrasPrice - cargoInsurance - termInsurance) * 100) / 100
  );

  const breakdown = (typeIntercity: number): string | undefined => {
    const parts = [`перевозка ${typeIntercity} ₽`];
    if (derivalPrice > 0) parts.push(`забор от адреса ${derivalPrice} ₽`);
    if (arrivalPrice > 0) parts.push(`доставка до адреса ${arrivalPrice} ₽`);
    if (cargoInsurance > 0) parts.push(`страхование груза ${cargoInsurance} ₽`);
    if (termInsurance > 0) parts.push(`страхование срока ${termInsurance} ₽`);
    if (servicesPrice > 0) parts.push(`сервисы ${servicesPrice} ₽`);
    return parts.length > 1 ? parts.join(" + ") : undefined;
  };

  const byType = result.data.availableDeliveryTypes ?? {};
  const tariffs = Object.entries(byType)
    .filter(([, price]) => typeof price === "number" && price > 0)
    .map<DellinTariffDto>(([type, price]) => ({
      type,
      name: DELIVERY_TYPE_LABELS[type] ?? type,
      deliverySum: totalFor(price as number),
      periodMin: period.min,
      periodMax: period.max,
      description: breakdown(price as number),
    }))
    .sort((a, b) => a.deliverySum - b.deliverySum);

  if (tariffs.length === 0 && fullPrice !== null) {
    tariffs.push({
      type: "auto",
      name: DELIVERY_TYPE_LABELS.auto,
      deliverySum: fullPrice,
      periodMin: period.min,
      periodMax: period.max,
      description: "Расчет Деловых Линий",
    });
  }

  if (tariffs.length === 0) {
    return {
      ok: false,
      message:
        "Деловые Линии не смогли рассчитать стоимость по этому направлению.",
    };
  }

  return {
    ok: true,
    tariffs,
    terminals: {
      derival: derivalTerminal.terminal,
      arrival: arrivalTerminal.terminal,
    },
    warnings: result.data.information ?? [],
  };
}

interface DellinOrderDates {
  /** Выдача получателю с терминала (терминальная доставка) */
  giveoutFromOspReceiver?: string | null;
  giveoutFromOspReceiverMax?: string | null;
  /** Доставка до адреса (встречается в части ответов) */
  derrivalToAddress?: string | null;
  derivalToAddressMax?: string | null;
  /** Отвоз с терминала получателя на адрес (адресная доставка) */
  derivalFromOspReceiver?: string | null;
  /** Прибытие на терминал получателя */
  arrivalToOspReceiver?: string | null;
}

/** Календарных дней от сегодня до даты (не меньше 0) */
function daysFromToday(date: Date): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  return Math.max(
    0,
    Math.round((target.getTime() - today.getTime()) / (24 * 60 * 60 * 1000))
  );
}

/**
 * Срок доставки: приоритет — deliveryTerm из ответа; иначе считаем от
 * СЕГОДНЯ до даты выдачи получателю (или доставки до адреса), а не
 * ширину окна выдачи.
 */
function deliveryPeriod(data: {
  deliveryTerm?: number;
  orderDates?: DellinOrderDates;
}): { min: number; max: number } {
  if (typeof data.deliveryTerm === "number" && data.deliveryTerm > 0) {
    return { min: data.deliveryTerm, max: data.deliveryTerm };
  }

  const minDate = firstDate([
    data.orderDates?.giveoutFromOspReceiver,
    data.orderDates?.derrivalToAddress,
    data.orderDates?.derivalFromOspReceiver,
    data.orderDates?.arrivalToOspReceiver,
  ]);
  if (!minDate) return { min: 0, max: 0 };

  const maxDate = firstDate([
    data.orderDates?.giveoutFromOspReceiverMax,
    data.orderDates?.derivalToAddressMax,
  ]);

  const min = daysFromToday(minDate);
  const max = Math.max(min, maxDate ? daysFromToday(maxDate) : min);
  return { min, max };
}

function firstDate(values: (string | null | undefined)[]): Date | null {
  for (const value of values) {
    if (!value) continue;
    const date = new Date(value.replace(" ", "T"));
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

function mapDellinErrors(
  payload: DellinApiResponse<unknown>,
  httpStatus: number
): string {
  const errors = [
    ...(payload.errors ?? []),
    ...(payload.error ? [payload.error] : []),
  ];
  if (errors.length === 0) {
    return `Сервер Деловых Линий вернул ошибку (HTTP ${httpStatus}).`;
  }
  return errors
    .map((error) => error.detail ?? error.message ?? error.title ?? error.code)
    .filter((text): text is string => Boolean(text))
    .join(" ");
}
