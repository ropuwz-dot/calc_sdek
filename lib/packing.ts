import "server-only";

import type {
  Catalog,
  CatalogProduct,
  PackingRule,
} from "@/lib/catalog";
import { normalizeArticle } from "@/lib/catalog";
import type {
  ItemPackingDto,
  PackingDto,
  PlaceDto,
  PositionInput,
} from "@/lib/types";

/**
 * Модуль расчёта упаковочных мест.
 *
 * Алгоритм по позиции:
 *  1. Точное правило на всё количество — одно место по нему.
 *  2. Иначе жадная раскладка правилами от большей упаковки к меньшей.
 *  3. Остаток закрывается поштучно по данным справочника (с предупреждением).
 *  4. Если поштучных данных нет — ошибка «нет правила упаковки для остатка».
 *  5. Места с нулевым/пустым весом или габаритом не допускаются.
 */

interface PlaceSpec {
  unitsPerPlace: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  weightKg: number;
  label: string;
}

function ruleComplete(rule: PackingRule): boolean {
  return (
    rule.lengthCm !== null &&
    rule.widthCm !== null &&
    rule.heightCm !== null &&
    rule.weightKg !== null &&
    rule.lengthCm > 0 &&
    rule.widthCm > 0 &&
    rule.heightCm > 0 &&
    rule.weightKg > 0
  );
}

function unitSpec(product: CatalogProduct): PlaceSpec | null {
  if (
    product.lengthCm === null ||
    product.widthCm === null ||
    product.heightCm === null ||
    product.weightKg === null ||
    product.lengthCm <= 0 ||
    product.widthCm <= 0 ||
    product.heightCm <= 0 ||
    product.weightKg <= 0
  ) {
    return null;
  }
  return {
    unitsPerPlace: 1,
    lengthCm: product.lengthCm,
    widthCm: product.widthCm,
    heightCm: product.heightCm,
    weightKg: product.weightKg,
    label: "Поштучно (1 шт)",
  };
}

function ruleSpec(rule: PackingRule): PlaceSpec {
  return {
    unitsPerPlace: rule.qty,
    lengthCm: rule.lengthCm!,
    widthCm: rule.widthCm!,
    heightCm: rule.heightCm!,
    weightKg: rule.weightKg!,
    label: `Упаковка ${rule.qty} шт`,
  };
}

function unitDataErrors(product: CatalogProduct): string[] {
  const errors: string[] = [];
  const noDims =
    product.lengthCm === null ||
    product.widthCm === null ||
    product.heightCm === null ||
    product.lengthCm <= 0 ||
    product.widthCm <= 0 ||
    product.heightCm <= 0;
  const noWeight = product.weightKg === null || product.weightKg <= 0;
  if (noDims) {
    errors.push(`По артикулу ${product.article} не указаны габариты.`);
  }
  if (noWeight) {
    errors.push(`По артикулу ${product.article} не указан вес.`);
  }
  return errors;
}

function toPlace(article: string, spec: PlaceSpec, count: number): PlaceDto {
  return {
    article,
    label: spec.label,
    unitsPerPlace: spec.unitsPerPlace,
    count,
    lengthCm: spec.lengthCm,
    widthCm: spec.widthCm,
    heightCm: spec.heightCm,
    weightKg: spec.weightKg,
    volumeM3: (spec.lengthCm * spec.widthCm * spec.heightCm) / 1_000_000,
  };
}

/** Максимальная высота «стопки» при поштучной укладке, см */
const MAX_STACK_CM = 150;

/**
 * Поштучная укладка: единицы складываются в одно место стопкой вдоль
 * наименьшего габарита (вес и объём суммируются). Если стопка превышает
 * MAX_STACK_CM — количество делится на несколько примерно равных мест.
 */
function stackUnits(article: string, unit: PlaceSpec, qty: number): PlaceDto[] {
  if (qty <= 0) return [];

  const dims = [unit.lengthCm, unit.widthCm, unit.heightCm];
  const minIndex = dims.indexOf(Math.min(...dims));
  const minDim = dims[minIndex];

  const maxPerStack = Math.max(1, Math.floor(MAX_STACK_CM / minDim));
  const stacks = Math.ceil(qty / maxPerStack);

  // Раскладываем поровну: 20 шт при максимуме 7 → стопки 7, 7, 6
  const baseSize = Math.floor(qty / stacks);
  const withExtra = qty % stacks; // столько стопок получают +1 единицу

  const places: PlaceDto[] = [];
  const addStack = (unitsInStack: number, count: number) => {
    if (count <= 0 || unitsInStack <= 0) return;
    const stackedDims = [...dims];
    stackedDims[minIndex] = Math.round(minDim * unitsInStack * 100) / 100;
    places.push({
      article,
      label:
        unitsInStack === 1
          ? "Поштучно (1 шт)"
          : `Поштучно, стопка ${unitsInStack} шт`,
      unitsPerPlace: unitsInStack,
      count,
      lengthCm: stackedDims[0],
      widthCm: stackedDims[1],
      heightCm: stackedDims[2],
      weightKg: Math.round(unit.weightKg * unitsInStack * 1000) / 1000,
      volumeM3:
        (stackedDims[0] * stackedDims[1] * stackedDims[2]) / 1_000_000,
    });
  };
  addStack(baseSize + 1, withExtra);
  addStack(baseSize, stacks - withExtra);
  return places;
}

interface ItemResult {
  item: ItemPackingDto;
  places: PlaceDto[];
}

function packItem(item: PositionInput, catalog: Catalog): ItemResult {
  const article = normalizeArticle(item.article);
  const warnings: string[] = [];
  const errors: string[] = [];
  const places: PlaceDto[] = [];

  const fail = (name: string): ItemResult => ({
    item: { article, name, requestedQty: item.qty, warnings, errors },
    places: [],
  });

  const product = catalog.products[article];
  if (!product) {
    errors.push(`Артикул ${article} не найден в справочнике.`);
    return fail("");
  }

  if (!Number.isInteger(item.qty) || item.qty <= 0) {
    errors.push(`Некорректное количество для ${article}: ${item.qty}.`);
    return fail(product.name);
  }

  const allRules = catalog.rules[article] ?? [];
  const usableRules = allRules
    .filter(ruleComplete)
    .sort((a, b) => b.qty - a.qty);
  for (const rule of allRules) {
    if (!ruleComplete(rule)) {
      warnings.push(
        `По артикулу ${article} правило упаковки на ${rule.qty} шт заполнено не полностью (лист «${rule.sheet}», строка ${rule.rowNumber}) — пропущено.`
      );
    }
  }

  const unit = unitSpec(product);
  let remaining = item.qty;

  // 1. Точное правило на всё количество
  const exact = usableRules.find((rule) => rule.qty === remaining);
  if (exact) {
    places.push(toPlace(article, ruleSpec(exact), 1));
    remaining = 0;
  } else {
    // 2. Жадно от большей упаковки к меньшей
    for (const rule of usableRules) {
      if (remaining <= 0) break;
      const count = Math.floor(remaining / rule.qty);
      if (count > 0) {
        places.push(toPlace(article, ruleSpec(rule), count));
        remaining -= count * rule.qty;
      }
    }

    // 3. Остаток — поштучно, стопкой в одно место (или несколько, если высоко)
    if (remaining > 0) {
      if (unit) {
        places.push(...stackUnits(article, unit, remaining));
        if (usableRules.length > 0) {
          warnings.push(
            `По артикулу ${article} нет правила упаковки для остатка ${remaining} шт — остаток рассчитан поштучно по данным справочника.`
          );
        } else {
          warnings.push(
            `По артикулу ${article} нет групповой упаковки, расчёт выполнен поштучно.`
          );
        }
        remaining = 0;
      } else if (usableRules.length > 0) {
        errors.push(
          `По артикулу ${article} нет правила упаковки для остатка ${remaining} шт.`
        );
        errors.push(...unitDataErrors(product));
      } else {
        // Нет ни правил, ни полных поштучных данных
        const dataErrors = unitDataErrors(product);
        if (dataErrors.length > 0) {
          errors.push(...dataErrors);
          errors.push(
            `Расчёт доставки по артикулу ${article} невозможен.`
          );
        } else {
          errors.push(
            `По артикулу ${article} нет ни правил упаковки, ни данных для поштучного расчёта.`
          );
        }
      }
    }
  }

  return {
    item: { article, name: product.name, requestedQty: item.qty, warnings, errors },
    places: errors.length > 0 ? [] : places,
  };
}

/** Схлопывает одинаковые места (один артикул, один типоразмер) */
function mergePlaces(places: PlaceDto[]): PlaceDto[] {
  const merged: PlaceDto[] = [];
  for (const place of places) {
    const same = merged.find(
      (p) =>
        p.article === place.article &&
        p.unitsPerPlace === place.unitsPerPlace &&
        p.lengthCm === place.lengthCm &&
        p.widthCm === place.widthCm &&
        p.heightCm === place.heightCm &&
        p.weightKg === place.weightKg
    );
    if (same) same.count += place.count;
    else merged.push({ ...place });
  }
  return merged;
}

export function packItems(
  items: PositionInput[],
  catalog: Catalog
): PackingDto {
  const results = items.map((item) => packItem(item, catalog));

  const places = mergePlaces(results.flatMap((r) => r.places));
  const errors = results.flatMap((r) => r.item.errors);
  const warnings = results.flatMap((r) => r.item.warnings);

  const totalPlaces = places.reduce((sum, p) => sum + p.count, 0);
  const totalWeightKg = places.reduce((sum, p) => sum + p.weightKg * p.count, 0);
  const totalVolumeM3 = places.reduce((sum, p) => sum + p.volumeM3 * p.count, 0);

  return {
    items: results.map((r) => r.item),
    places,
    totalPlaces,
    totalWeightKg: Math.round(totalWeightKg * 1000) / 1000,
    totalVolumeM3: Math.round(totalVolumeM3 * 1_000_000) / 1_000_000,
    warnings,
    errors,
    canShip: errors.length === 0 && totalPlaces > 0 && items.length > 0,
  };
}

/** Места в формате СДЭК: вес в граммах, габариты в целых сантиметрах */
export function placesToCdekPackages(places: PlaceDto[]) {
  const packages: {
    weight: number;
    length: number;
    width: number;
    height: number;
  }[] = [];
  for (const place of places) {
    for (let i = 0; i < place.count; i++) {
      packages.push({
        weight: Math.max(1, Math.round(place.weightKg * 1000)),
        length: Math.max(1, Math.ceil(place.lengthCm)),
        width: Math.max(1, Math.ceil(place.widthCm)),
        height: Math.max(1, Math.ceil(place.heightCm)),
      });
    }
  }
  return packages;
}
