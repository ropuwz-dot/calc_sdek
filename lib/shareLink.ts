import type {
  CityDto,
  DeliveryMode,
  DellinCityDto,
  DellinStreetDto,
  DellinTerminalDto,
  ManualPlaceInput,
  PositionInput,
  PvzDto,
} from "@/lib/types";

export interface ShareLinkPayload {
  v: 1;
  tab: "cdek" | "dellin";
  cdek: {
    cities: {
      from: CityDto | null;
      to: CityDto | null;
    };
    mode: DeliveryMode;
    address: {
      fromStreet: string;
      fromHouse: string;
      fromFlat: string;
      toStreet: string;
      toHouse: string;
      toFlat: string;
    };
    pvz: {
      from: PvzDto | null;
      to: PvzDto | null;
    };
  };
  dellin: {
    cities: {
      from: DellinCityDto | null;
      to: DellinCityDto | null;
    };
    street: {
      from: DellinStreetDto | null;
      to: DellinStreetDto | null;
    };
    terminal: {
      from: DellinTerminalDto | null;
      to: DellinTerminalDto | null;
    };
    house: {
      from: string;
      to: string;
    };
    flat: {
      from: string;
      to: string;
    };
    mode: DeliveryMode;
  };
  positions: PositionInput[];
  manualPlaces: ManualPlaceInput[];
  clientPays: boolean;
}

const MAX_PAYLOAD_LENGTH = 6000;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
};

const base64ToBytes = (base64: string) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const encodeBase64Url = (value: string) =>
  bytesToBase64(textEncoder.encode(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");

const decodeBase64Url = (value: string) => {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "="
  );
  return textDecoder.decode(base64ToBytes(padded));
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isDeliveryMode = (value: unknown): value is DeliveryMode =>
  value === "warehouse-warehouse" ||
  value === "warehouse-door" ||
  value === "door-warehouse" ||
  value === "door-door";

const isCity = (value: unknown): value is CityDto =>
  isObject(value) &&
  Number.isInteger(value.code) &&
  typeof value.name === "string" &&
  value.name.trim() !== "";

const isDellinCity = (value: unknown): value is DellinCityDto =>
  isObject(value) &&
  typeof value.code === "string" &&
  Number.isInteger(value.cityId) &&
  typeof value.name === "string" &&
  typeof value.regionName === "string" &&
  typeof value.isTerminal === "boolean";

const isPvz = (value: unknown): value is PvzDto =>
  isObject(value) &&
  typeof value.code === "string" &&
  typeof value.name === "string" &&
  typeof value.address === "string" &&
  (value.weightMinKg === null || typeof value.weightMinKg === "number") &&
  (value.weightMaxKg === null || typeof value.weightMaxKg === "number") &&
  Array.isArray(value.dims);

const isDellinStreet = (value: unknown): value is DellinStreetDto =>
  isObject(value) &&
  typeof value.code === "string" &&
  Number.isInteger(value.cityId) &&
  typeof value.name === "string" &&
  typeof value.fullName === "string";

const isDellinTerminal = (value: unknown): value is DellinTerminalDto =>
  isObject(value) &&
  Number.isInteger(value.id) &&
  typeof value.name === "string" &&
  typeof value.address === "string" &&
  typeof value.isDefault === "boolean";

const isPosition = (value: unknown): value is PositionInput =>
  isObject(value) &&
  typeof value.article === "string" &&
  value.article.trim() !== "" &&
  typeof value.qty === "number" &&
  Number.isInteger(value.qty) &&
  value.qty > 0 &&
  value.qty <= 1000;

const isManualPlace = (value: unknown): value is ManualPlaceInput =>
  isObject(value) &&
  typeof value.lengthCm === "number" &&
  typeof value.widthCm === "number" &&
  typeof value.heightCm === "number" &&
  typeof value.weightKg === "number" &&
  typeof value.count === "number" &&
  value.lengthCm > 0 &&
  value.widthCm > 0 &&
  value.heightCm > 0 &&
  value.weightKg > 0 &&
  Number.isInteger(value.count) &&
  value.count > 0 &&
  value.count <= 1000;

const stringValue = (value: unknown) => (typeof value === "string" ? value : "");

const nullable = <T>(
  value: unknown,
  guard: (candidate: unknown) => candidate is T
): T | null => (value === null || value === undefined ? null : guard(value) ? value : null);

export const encodeSharePayload = (payload: ShareLinkPayload) =>
  encodeBase64Url(JSON.stringify(payload));

export const decodeSharePayload = (
  encoded: string | null
): ShareLinkPayload | null => {
  if (!encoded || encoded.length > MAX_PAYLOAD_LENGTH) return null;
  try {
    const parsed = JSON.parse(decodeBase64Url(encoded)) as unknown;
    if (!isObject(parsed) || parsed.v !== 1) return null;

    const cdek = isObject(parsed.cdek) ? parsed.cdek : {};
    const cdekCities = isObject(cdek.cities) ? cdek.cities : {};
    const cdekAddress = isObject(cdek.address) ? cdek.address : {};
    const cdekPvz = isObject(cdek.pvz) ? cdek.pvz : {};

    const dellin = isObject(parsed.dellin) ? parsed.dellin : {};
    const dellinCities = isObject(dellin.cities) ? dellin.cities : {};
    const dellinStreet = isObject(dellin.street) ? dellin.street : {};
    const dellinTerminal = isObject(dellin.terminal) ? dellin.terminal : {};
    const dellinHouse = isObject(dellin.house) ? dellin.house : {};
    const dellinFlat = isObject(dellin.flat) ? dellin.flat : {};

    const cdekMode = isDeliveryMode(cdek.mode)
      ? cdek.mode
      : "warehouse-warehouse";
    const dellinMode = isDeliveryMode(dellin.mode)
      ? dellin.mode
      : "warehouse-warehouse";
    const positions = Array.isArray(parsed.positions)
      ? parsed.positions.filter(isPosition).slice(0, 100)
      : [];
    const manualPlaces = Array.isArray(parsed.manualPlaces)
      ? parsed.manualPlaces.filter(isManualPlace).slice(0, 100)
      : [];

    return {
      v: 1,
      tab: parsed.tab === "dellin" ? "dellin" : "cdek",
      cdek: {
        cities: {
          from: nullable(cdekCities.from, isCity),
          to: nullable(cdekCities.to, isCity),
        },
        mode: cdekMode,
        address: {
          fromStreet: stringValue(cdekAddress.fromStreet),
          fromHouse: stringValue(cdekAddress.fromHouse),
          fromFlat: stringValue(cdekAddress.fromFlat),
          toStreet: stringValue(cdekAddress.toStreet),
          toHouse: stringValue(cdekAddress.toHouse),
          toFlat: stringValue(cdekAddress.toFlat),
        },
        pvz: {
          from: nullable(cdekPvz.from, isPvz),
          to: nullable(cdekPvz.to, isPvz),
        },
      },
      dellin: {
        cities: {
          from: nullable(dellinCities.from, isDellinCity),
          to: nullable(dellinCities.to, isDellinCity),
        },
        street: {
          from: nullable(dellinStreet.from, isDellinStreet),
          to: nullable(dellinStreet.to, isDellinStreet),
        },
        terminal: {
          from: nullable(dellinTerminal.from, isDellinTerminal),
          to: nullable(dellinTerminal.to, isDellinTerminal),
        },
        house: {
          from: stringValue(dellinHouse.from),
          to: stringValue(dellinHouse.to),
        },
        flat: {
          from: stringValue(dellinFlat.from),
          to: stringValue(dellinFlat.to),
        },
        mode: dellinMode,
      },
      positions,
      manualPlaces,
      clientPays: parsed.clientPays === true,
    };
  } catch {
    return null;
  }
};
