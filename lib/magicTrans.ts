import "server-only";

import type {
  DeliveryMode,
  MagicTransCityDto,
  MagicTransTariffDto,
  MagicTransTerminalDto,
  PlaceDto,
} from "@/lib/types";
import {
  buildMagicTransCalculatorPayload,
  filterMagicTransCities,
} from "./magicTransPayload";

export {
  buildMagicTransCalculatorPayload,
  filterMagicTransCities,
} from "./magicTransPayload";
export type { MagicTransCalculatorPayload } from "./magicTransPayload";

const DEFAULT_SECURITY_API_URL =
  "https://api.magic-trans.ru/prc/hs/SecurityAPI";
const DEFAULT_ECOMM_API_URL =
  "https://api.magic-trans.ru/prc/hs/EcommAPI/v1";
const CACHE_TTL_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;

type MagicTransConfig = {
  refreshToken: string;
  securityApiUrl: string;
  ecommApiUrl: string;
};

type MagicTransApiError = { message?: string; status?: number; name?: string };
type AccessResponse = { accessToken?: string; dateEnd?: string };
type TerritoryResponse = {
  id?: string;
  name?: string;
  region?: string;
};
type TerminalResponse = {
  id?: string;
  name?: string;
  address?: string;
  territoryId?: string;
  territory?: string;
};
type CalculatorResponse = {
  plannedDelivery?: {
    cost?: number;
    days?: number;
    deliveryDate?: string;
  };
};

let accessCache: { token: string; expiresAt: number } | null = null;
let territoryCache: { value: MagicTransCityDto[]; expiresAt: number } | null = null;
let terminalCache: { value: MagicTransTerminalDto[]; expiresAt: number } | null = null;

export function getMagicTransConfig():
  | { ok: true; config: MagicTransConfig }
  | { ok: false; message: string } {
  const refreshToken = process.env.MAGIC_TRANS_REFRESH_TOKEN?.trim();
  if (!refreshToken) {
    return {
      ok: false,
      message:
        "Интеграция Magic Trans не настроена: задайте MAGIC_TRANS_REFRESH_TOKEN в .env.local и перезапустите сервер.",
    };
  }

  return {
    ok: true,
    config: {
      refreshToken,
      securityApiUrl:
        process.env.MAGIC_TRANS_SECURITY_API_URL?.trim().replace(/\/$/, "") ||
        DEFAULT_SECURITY_API_URL,
      ecommApiUrl:
        process.env.MAGIC_TRANS_ECOMM_API_URL?.trim().replace(/\/$/, "") ||
        DEFAULT_ECOMM_API_URL,
    },
  };
}

function apiErrorMessage(payload: unknown, status: number): string {
  if (isObject(payload)) {
    const error = payload as MagicTransApiError;
    if (typeof error.message === "string" && error.message.trim()) {
      return error.message;
    }
  }
  if (status === 401) return "Magic Trans отклонили токен авторизации.";
  return `Magic Trans вернули ошибку (HTTP ${status}).`;
}

async function fetchJson<T>(params: {
  url: string;
  token: string;
  method?: "GET" | "POST";
  body?: unknown;
}): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  let response: Response;
  try {
    response = await fetch(params.url, {
      method: params.method ?? "GET",
      headers: {
        Token: params.token,
        ...(params.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(params.body === undefined ? {} : { body: JSON.stringify(params.body) }),
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return {
      ok: false,
      message: "Не удалось соединиться с сервером Magic Trans. Попробуйте позже.",
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      message: `Magic Trans вернули некорректный ответ (HTTP ${response.status}).`,
    };
  }

  if (!response.ok) return { ok: false, message: apiErrorMessage(payload, response.status) };
  return { ok: true, data: payload as T };
}

async function getAccessToken(): Promise<
  { ok: true; token: string } | { ok: false; message: string }
> {
  if (accessCache && accessCache.expiresAt > Date.now() + 60_000) {
    return { ok: true, token: accessCache.token };
  }

  const configured = getMagicTransConfig();
  if (!configured.ok) return configured;
  const result = await fetchJson<AccessResponse>({
    url: `${configured.config.securityApiUrl}/access`,
    token: configured.config.refreshToken,
  });
  if (!result.ok) return result;
  if (!result.data.accessToken) {
    return { ok: false, message: "Magic Trans не вернули access-token." };
  }

  const dateEnd = result.data.dateEnd ? Date.parse(result.data.dateEnd) : NaN;
  accessCache = {
    token: result.data.accessToken,
    expiresAt: Number.isFinite(dateEnd) ? dateEnd : Date.now() + 20 * 60 * 1000,
  };
  return { ok: true, token: accessCache.token };
}

async function requestEcomm<T>(params: {
  path: string;
  method?: "GET" | "POST";
  body?: unknown;
}): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  const configured = getMagicTransConfig();
  if (!configured.ok) return configured;
  const access = await getAccessToken();
  if (!access.ok) return access;

  let result = await fetchJson<T>({
    url: `${configured.config.ecommApiUrl}${params.path}`,
    token: access.token,
    method: params.method,
    body: params.body,
  });
  if (!result.ok && /токен|401|credentials/i.test(result.message)) {
    accessCache = null;
    const refreshed = await getAccessToken();
    if (!refreshed.ok) return refreshed;
    result = await fetchJson<T>({
      url: `${configured.config.ecommApiUrl}${params.path}`,
      token: refreshed.token,
      method: params.method,
      body: params.body,
    });
  }
  return result;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function listMagicTransCities(): Promise<
  { ok: true; cities: MagicTransCityDto[] } | { ok: false; message: string }
> {
  if (territoryCache && territoryCache.expiresAt > Date.now()) {
    return { ok: true, cities: territoryCache.value };
  }

  const result = await requestEcomm<TerritoryResponse[]>({ path: "/territory" });
  if (!result.ok) return result;
  const cities = result.data
    .filter((item) => typeof item.id === "string" && typeof item.name === "string")
    .map((item) => ({
      id: item.id!,
      name: item.name!,
      region: item.region ?? "",
    }));
  territoryCache = { value: cities, expiresAt: Date.now() + CACHE_TTL_MS };
  return { ok: true, cities };
}

export async function suggestMagicTransCities(query: string): Promise<
  { ok: true; cities: MagicTransCityDto[] } | { ok: false; message: string }
> {
  const cities = await listMagicTransCities();
  if (!cities.ok) return cities;
  return { ok: true, cities: filterMagicTransCities(cities.cities, query) };
}

async function listMagicTransTerminals(): Promise<
  | { ok: true; terminals: MagicTransTerminalDto[] }
  | { ok: false; message: string }
> {
  if (terminalCache && terminalCache.expiresAt > Date.now()) {
    return { ok: true, terminals: terminalCache.value };
  }

  const result = await requestEcomm<TerminalResponse[]>({ path: "/terminal" });
  if (!result.ok) return result;
  const terminals = result.data
    .filter(
      (item) =>
        typeof item.id === "string" &&
        typeof item.name === "string" &&
        typeof item.territoryId === "string"
    )
    .map((item) => ({
      id: item.id!,
      name: item.name!,
      address: item.address ?? "",
      territoryId: item.territoryId!,
      territory: item.territory ?? "",
    }));
  terminalCache = { value: terminals, expiresAt: Date.now() + CACHE_TTL_MS };
  return { ok: true, terminals };
}

export async function terminalsForMagicTransCity(cityId: string): Promise<
  { ok: true; terminals: MagicTransTerminalDto[] } | { ok: false; message: string }
> {
  const terminals = await listMagicTransTerminals();
  if (!terminals.ok) return terminals;
  return {
    ok: true,
    terminals: terminals.terminals
      .filter((terminal) => terminal.territoryId === cityId)
      .sort((left, right) => left.name.localeCompare(right.name, "ru")),
  };
}

export async function calculateMagicTransDelivery(params: {
  fromCityId: string;
  toCityId: string;
  fromTerminalId?: string;
  toTerminalId?: string;
  fromAddress?: string;
  toAddress?: string;
  mode: DeliveryMode;
  places: PlaceDto[];
}): Promise<{ ok: true; tariff: MagicTransTariffDto } | { ok: false; message: string }> {
  const payload = buildMagicTransCalculatorPayload({
    from: {
      cityId: params.fromCityId,
      terminalId: params.fromTerminalId,
      address: params.fromAddress ?? "",
    },
    to: {
      cityId: params.toCityId,
      terminalId: params.toTerminalId,
      address: params.toAddress ?? "",
    },
    mode: params.mode,
    places: params.places,
    pickupDate: new Date().toISOString().slice(0, 10),
  });

  const result = await requestEcomm<CalculatorResponse>({
    path: "/calculator",
    method: "POST",
    body: payload,
  });
  if (!result.ok) return result;
  const delivery = result.data.plannedDelivery;
  if (
    !delivery ||
    typeof delivery.cost !== "number" ||
    typeof delivery.days !== "number"
  ) {
    return {
      ok: false,
      message: "Magic Trans не вернули стоимость и срок доставки.",
    };
  }

  return {
    ok: true,
    tariff: {
      name: "Magic Trans",
      deliverySum: delivery.cost,
      periodMin: Math.max(0, delivery.days),
      periodMax: Math.max(0, delivery.days),
      deliveryDate: delivery.deliveryDate ?? null,
    },
  };
}

export async function checkMagicTransHealth(): Promise<
  { ok: true } | { ok: false }
> {
  const access = await getAccessToken();
  if (!access.ok) return { ok: false };
  const result = await requestEcomm<TerritoryResponse[]>({ path: "/territory" });
  return result.ok ? { ok: true } : { ok: false };
}
