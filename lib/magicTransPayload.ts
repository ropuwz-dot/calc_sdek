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
      terminal: fromTerminal ? params.from.terminalId ?? "" : "",
      address: fromTerminal ? "" : params.from.address,
      lat: "",
      lon: "",
      pickupDate: params.pickupDate,
    },
    to: {
      city: params.to.cityId,
      terminal: toTerminal ? params.to.terminalId ?? "" : "",
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
