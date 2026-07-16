import type {
  DeliveryMode,
  MagicTransCityDto,
  PlaceDto,
} from "@/lib/types";

export type MagicTransCalculatorPayload = {
  from: {
    city: string;
    terminal: string;
    address: string;
    lat: string;
    lon: string;
    pickupDate?: string;
  };
  to: {
    city: string;
    terminal: string;
    address: string;
    lat: string;
    lon: string;
  };
  options: {
    fromTerminal: boolean;
    toTerminal: boolean;
    toSupermarket: boolean;
    sensitiveCargo: boolean;
    additionalPackage: boolean;
  };
  cargo: {
    quantity: number;
    weight: number;
    volume: number;
    length: number;
    width: number;
    height: number;
    price: number;
  };
};

const round = (value: number, digits = 6) => {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
};

const exactNameScore = (name: string, query: string) => {
  const normalizedName = name.trim().toLocaleLowerCase("ru-RU");
  if (normalizedName === query) return 0;
  if (normalizedName.startsWith(`${query},`) || normalizedName.startsWith(`${query} `)) return 1;
  if (normalizedName.startsWith(query)) return 2;
  return 3;
};

export function filterMagicTransCities(
  cities: MagicTransCityDto[],
  query: string
): MagicTransCityDto[] {
  const normalized = query.trim().toLocaleLowerCase("ru-RU");
  if (normalized.length < 2) return [];
  return cities
    .filter((city) =>
      `${city.name} ${city.region}`.toLocaleLowerCase("ru-RU").includes(normalized)
    )
    .sort(
      (left, right) =>
        exactNameScore(left.name, normalized) - exactNameScore(right.name, normalized) ||
        left.name.localeCompare(right.name, "ru")
    )
    .slice(0, 12);
}

export function parseMagicTransPublicAddressCosts(payload: unknown): {
  base: number;
  pickup: number;
  delivery: number;
} {
  const record =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  const result = record?.result;
  const resultRecord =
    typeof result === "object" && result !== null && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : null;
  const addressCost = resultRecord?.addressCost;
  const addressCostRecord =
    typeof addressCost === "object" && addressCost !== null && !Array.isArray(addressCost)
      ? (addressCost as Record<string, unknown>)
      : null;

  const parseCost = (value: unknown) => {
    let normalized = value;
    if (typeof value === "string") {
      const compact = value.replace(/\s/g, "");
      if (/^[+-]?\d{1,3}(,\d{3})+$/.test(compact)) {
        normalized = compact.replace(/,/g, "");
      } else if (compact.includes(",") && compact.includes(".")) {
        normalized =
          compact.lastIndexOf(",") > compact.lastIndexOf(".")
            ? compact.replace(/\./g, "").replace(",", ".")
            : compact.replace(/,/g, "");
      } else {
        normalized = compact.replace(",", ".");
      }
    }
    const parsed = typeof normalized === "number" ? normalized : Number(normalized);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  };
  const getTotal = (side: "from" | "to") => {
    const entry = addressCostRecord?.[side];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return 0;
    return parseCost((entry as Record<string, unknown>).total);
  };

  return {
    base: parseCost(resultRecord?.terminal),
    pickup: getTotal("from"),
    delivery: getTotal("to"),
  };
}

export function calculateMagicTransInsurance(declaredValue: number): number {
  const value = Number.isFinite(declaredValue) && declaredValue > 0 ? declaredValue : 0;
  return Math.max(40, Math.round(value * 0.002 * 100) / 100);
}

export function buildMagicTransCalculatorPayload(params: {
  from: { cityId: string; terminalId?: string; address: string };
  to: { cityId: string; terminalId?: string; address: string };
  mode: DeliveryMode;
  places: PlaceDto[];
  pickupDate: string;
}): MagicTransCalculatorPayload {
  if (params.places.length === 0) {
    throw new Error("Нет упаковочных мест для расчета.");
  }
  const fromTerminal = params.mode.startsWith("warehouse");
  const toTerminal = params.mode.endsWith("warehouse");
  const largest = params.places.reduce((current, place) =>
    place.volumeM3 > current.volumeM3 ? place : current
  );
  const quantity = params.places.reduce((total, place) => total + place.count, 0);
  const weight = params.places.reduce(
    (total, place) => total + place.weightKg * place.count,
    0
  );
  const volume = params.places.reduce(
    (total, place) => total + place.volumeM3 * place.count,
    0
  );

  return {
    from: {
      city: params.from.cityId,
      terminal: params.from.terminalId ?? "",
      address: fromTerminal ? "" : params.from.address,
      lat: "",
      lon: "",
      pickupDate: params.pickupDate,
    },
    to: {
      city: params.to.cityId,
      terminal: params.to.terminalId ?? "",
      address: toTerminal ? "" : params.to.address,
      lat: "",
      lon: "",
    },
    options: {
      fromTerminal,
      toTerminal,
      toSupermarket: false,
      sensitiveCargo: false,
      additionalPackage: false,
    },
    cargo: {
      quantity,
      weight: round(weight, 3),
      volume: Math.max(0.001, round(volume)),
      length: round(largest.lengthCm / 100, 3),
      width: round(largest.widthCm / 100, 3),
      height: round(largest.heightCm / 100, 3),
      price: 0,
    },
  };
}
