import {
  decodeSharePayload,
  encodeSharePayload,
  type ShareLinkPayload,
} from "@/lib/shareLink";
import type { DeliveryMode } from "@/lib/types";

export type CalculationCarrier = "cdek" | "dellin";

export interface CalculationHistoryEntry {
  id: string;
  createdAt: number;
  carrier: CalculationCarrier;
  from: string;
  to: string;
  mode: DeliveryMode;
  totalPlaces: number;
  totalWeightKg: number;
  totalVolumeM3: number;
  tariffName: string;
  totalPrice: number;
  periodMin: number;
  periodMax: number;
  payload: ShareLinkPayload;
}

export type CalculationHistoryDraft = Omit<
  CalculationHistoryEntry,
  "id" | "createdAt"
>;

const STORAGE_KEY = "cdekcalc.calculation-history.v1";
const MAX_ENTRIES = 20;

const canUseStorage = () => {
  try {
    if (typeof window === "undefined") return false;
    const testKey = `${STORAGE_KEY}.test`;
    window.localStorage.setItem(testKey, "1");
    window.localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finiteNumber = (value: unknown, min = 0): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min;

const isDeliveryMode = (value: unknown): value is DeliveryMode =>
  value === "warehouse-warehouse" ||
  value === "warehouse-door" ||
  value === "door-warehouse" ||
  value === "door-door";

function parsePayload(value: unknown): ShareLinkPayload | null {
  if (!isObject(value)) return null;
  try {
    return decodeSharePayload(
      encodeSharePayload(value as unknown as ShareLinkPayload)
    );
  } catch {
    return null;
  }
}

function parseEntry(value: unknown): CalculationHistoryEntry | null {
  if (!isObject(value)) return null;
  const payload = parsePayload(value.payload);
  if (
    typeof value.id !== "string" ||
    value.id === "" ||
    !finiteNumber(value.createdAt, 1) ||
    (value.carrier !== "cdek" && value.carrier !== "dellin") ||
    typeof value.from !== "string" ||
    value.from.trim() === "" ||
    typeof value.to !== "string" ||
    value.to.trim() === "" ||
    !isDeliveryMode(value.mode) ||
    !finiteNumber(value.totalPlaces) ||
    !finiteNumber(value.totalWeightKg) ||
    !finiteNumber(value.totalVolumeM3) ||
    typeof value.tariffName !== "string" ||
    value.tariffName.trim() === "" ||
    !finiteNumber(value.totalPrice) ||
    !finiteNumber(value.periodMin) ||
    !finiteNumber(value.periodMax) ||
    !payload
  ) {
    return null;
  }

  return {
    id: value.id,
    createdAt: value.createdAt,
    carrier: value.carrier,
    from: value.from.slice(0, 250),
    to: value.to.slice(0, 250),
    mode: value.mode,
    totalPlaces: value.totalPlaces,
    totalWeightKg: value.totalWeightKg,
    totalVolumeM3: value.totalVolumeM3,
    tariffName: value.tariffName.slice(0, 250),
    totalPrice: value.totalPrice,
    periodMin: value.periodMin,
    periodMax: value.periodMax,
    payload,
  };
}

export const loadCalculationHistory = (): CalculationHistoryEntry[] => {
  if (!canUseStorage()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed
      .map(parseEntry)
      .filter((entry): entry is CalculationHistoryEntry => entry !== null)
      .filter((entry) => {
        if (seen.has(entry.id)) return false;
        seen.add(entry.id);
        return true;
      })
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
};

export const saveCalculationHistory = (entries: CalculationHistoryEntry[]) => {
  if (!canUseStorage()) return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        [...entries]
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, MAX_ENTRIES)
      )
    );
  } catch {
    // Storage can become unavailable after the initial probe.
  }
};

export const addCalculationHistoryEntry = (
  entries: CalculationHistoryEntry[],
  draft: CalculationHistoryDraft
): CalculationHistoryEntry[] => {
  const createdAt = Date.now();
  const randomId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return [
    { ...draft, id: `${createdAt}-${randomId}`, createdAt },
    ...entries,
  ].slice(0, MAX_ENTRIES);
};

export const removeCalculationHistoryEntry = (
  entries: CalculationHistoryEntry[],
  id: string
) => entries.filter((entry) => entry.id !== id);

export const clearCalculationHistory = () => {
  if (!canUseStorage()) return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing else to do when storage is unavailable.
  }
};
