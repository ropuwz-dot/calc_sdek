import "server-only";

import type { ManualPlaceInput, PlaceDto } from "@/lib/types";

/**
 * Валидация ручных мест из тела запроса (общая для роутов СДЭК и ДЛ).
 * Значения приходят от пользователя, но сервер проверяет их сам.
 */
export function parseManualPlaces(
  manualRaw: unknown
): { ok: true; places: PlaceDto[] } | { ok: false; message: string } {
  const list = Array.isArray(manualRaw)
    ? (manualRaw as Partial<ManualPlaceInput>[])
    : [];
  if (list.length > 100) {
    return { ok: false, message: "Слишком много ручных мест." };
  }

  const places: PlaceDto[] = [];
  for (const raw of list) {
    const lengthCm = Number(raw?.lengthCm);
    const widthCm = Number(raw?.widthCm);
    const heightCm = Number(raw?.heightCm);
    const weightKg = Number(raw?.weightKg);
    const count = Number(raw?.count);
    const dimsOk = [lengthCm, widthCm, heightCm].every(
      (value) => Number.isFinite(value) && value > 0 && value <= 1000
    );
    const weightOk =
      Number.isFinite(weightKg) && weightKg > 0 && weightKg <= 10000;
    const countOk = Number.isInteger(count) && count >= 1 && count <= 1000;
    if (!dimsOk || !weightOk || !countOk) {
      return {
        ok: false,
        message:
          "Некорректное ручное место: габариты (до 1000 см), вес (до 10 000 кг) и количество мест должны быть положительными числами.",
      };
    }
    places.push({
      article: "—",
      label: "Ручное место",
      unitsPerPlace: 1,
      count,
      lengthCm,
      widthCm,
      heightCm,
      weightKg,
      volumeM3: (lengthCm * widthCm * heightCm) / 1_000_000,
    });
  }
  return { ok: true, places };
}
