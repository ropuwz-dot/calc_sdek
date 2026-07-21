import "server-only";

import {
  readAllSheets,
  type SheetsAccessError,
} from "@/lib/googleSheets";

/**
 * Парсер справочника из Google Таблицы.
 *
 * Структура таблицы не меняется приложением — парсер адаптируется к ней:
 *  - ходит по всем листам и ищет блоки по строкам-шапкам;
 *  - блок с колонками «Артикул + ДШВ/вес» без количества — основной справочник;
 *  - блок с колонкой «Количество в упаковке» — правила групповой упаковки;
 *  - блоки с «Место / Откуда / Куда / Тариф / Стоимость / ИТОГО» — расчётные,
 *    источником данных не считаются и пропускаются;
 *  - на одном листе может быть несколько блоков подряд.
 *
 * Все проблемы данных не роняют парсер, а копятся в отчёте качества.
 */

// ---------- Типы ----------

export interface CatalogProduct {
  article: string;
  name: string;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  weightKg: number | null;
  sheet: string;
  rowNumber: number;
  /** Артикул найден только в блоке групповой упаковки (в основном справочнике его нет) */
  fromPackingOnly?: boolean;
}

export interface PackingRule {
  article: string;
  name: string;
  qty: number;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  weightKg: number | null;
  sheet: string;
  rowNumber: number;
}

/** Одно фиксированное место в составе одной единицы составного артикула. */
export interface CompositePlaceRule {
  article: string;
  placeNumber: number;
  componentArticle: string;
  count: number;
  sheet: string;
  rowNumber: number;
}

export interface CatalogIssue {
  sheet: string;
  rowNumber: number;
  message: string;
}

export interface CatalogStats {
  productCount: number;
  productsComplete: number;
  productsWithoutWeight: number;
  productsWithoutDims: number;
  ruleCount: number;
  articlesWithRules: number;
  /** Артикулы, которые есть только в упаковке (без строки в основном справочнике) */
  packingOnlyArticles: number;
  compositeArticleCount: number;
  compositePlaceCount: number;
  catalogBlocks: number;
  packingBlocks: number;
  skippedCalcBlocks: number;
}

export interface Catalog {
  spreadsheetTitle: string;
  /** Товары по нормализованному артикулу */
  products: Record<string, CatalogProduct>;
  /** Правила групповой упаковки по нормализованному артикулу */
  rules: Record<string, PackingRule[]>;
  /** Фиксированные места составных артикулов по артикулу комплекта */
  composites: Record<string, CompositePlaceRule[]>;
  duplicateArticles: string[];
  issues: CatalogIssue[];
  suspicious: CatalogIssue[];
  stats: CatalogStats;
  loadedAt: number;
}

export type CatalogResult = { ok: true; catalog: Catalog } | SheetsAccessError;

// ---------- Утилиты ----------

export function normalizeArticle(raw: string): string {
  return raw.trim().toUpperCase();
}

function cellText(cell: string | number | boolean | undefined): string {
  if (cell === undefined || cell === null) return "";
  return String(cell).trim();
}

function cellNumber(cell: string | number | boolean | undefined): number | null {
  if (typeof cell === "number") {
    return Number.isFinite(cell) ? cell : null;
  }
  const text = cellText(cell);
  if (text === "") return null;
  const cleaned = text.replace(/\s/g, "").replace(",", ".").replace(/[^\d.\-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** нижний регистр, ё→е, вся пунктуация → пробелы */
function normHeader(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9³]+/g, " ")
    .trim();
}

// ---------- Распознавание шапок ----------

type ColumnKey = "article" | "name" | "qty" | "length" | "width" | "height" | "weight";

interface ColumnInfo {
  key: ColumnKey;
  index: number;
  /** множитель перевода в см для габаритов (м → 100) */
  toCm?: number;
}

const CALC_MARKERS = ["место", "откуда", "куда", "тариф", "стоимость", "итого"];

function dimUnitToCm(header: string): number {
  const tokens = header.split(" ");
  if (tokens.includes("мм")) return 0.1;
  if (tokens.includes("см")) return 1;
  if (tokens.includes("м")) return 100;
  return 1; // по умолчанию считаем сантиметры
}

function classifyHeaderCell(header: string): ColumnInfo["key"] | null {
  if (header.includes("артикул")) return "article";
  if (header.includes("наименование") || header.includes("название")) return "name";
  if (header.includes("количество") || header.includes("кол во")) return "qty";
  if (header.startsWith("длина")) return "length";
  if (header.startsWith("ширина")) return "width";
  if (header.startsWith("высота")) return "height";
  if (
    header.startsWith("вес") &&
    !header.includes("м³") &&
    !header.includes("м3") &&
    !header.includes("куб")
  ) {
    // «Вес брутто, кг» / «Вес, кг»; «Вес нетто, м³» отсекли выше
    return "weight";
  }
  return null;
}

interface HeaderAnalysis {
  kind: "catalog" | "packing" | "calc" | null;
  columns: ColumnInfo[];
}

function analyzeHeaderRow(row: (string | number | boolean)[]): HeaderAnalysis {
  const headers = row.map((cell) => normHeader(cellText(cell)));

  const calcHits = CALC_MARKERS.filter((marker) =>
    headers.some((h) => h === marker || h.startsWith(marker + " "))
  ).length;

  const columns: ColumnInfo[] = [];
  const seenKeys = new Set<ColumnKey>();
  headers.forEach((header, index) => {
    if (header === "") return;
    const key = classifyHeaderCell(header);
    if (!key || seenKeys.has(key)) {
      // «вес брутто» приоритетнее прочих «вес …» — заменяем, если встретился
      if (key === "weight" && header.includes("брутто")) {
        const i = columns.findIndex((c) => c.key === "weight");
        if (i >= 0) columns[i] = { key, index };
      }
      return;
    }
    seenKeys.add(key);
    const info: ColumnInfo = { key, index };
    if (key === "length" || key === "width" || key === "height") {
      info.toCm = dimUnitToCm(header);
    }
    columns.push(info);
  });

  const hasArticle = seenKeys.has("article");
  const dataCols = columns.filter((c) => c.key !== "article" && c.key !== "name");

  // Расчётный блок: несколько маркеров и это не товарная шапка
  if (calcHits >= 2 && !hasArticle) {
    return { kind: "calc", columns: [] };
  }

  if (hasArticle && dataCols.length >= 2) {
    return {
      kind: seenKeys.has("qty") ? "packing" : "catalog",
      columns,
    };
  }

  return { kind: null, columns: [] };
}

interface CompositeHeader {
  articleIndex: number;
  placeNumberIndex: number;
  componentArticleIndex: number;
  countIndex: number;
}

function analyzeCompositeHeaderRow(
  row: (string | number | boolean)[]
): CompositeHeader | null {
  const headers = row.map((cell) => normHeader(cellText(cell)));
  const articleIndex = headers.findIndex((header) =>
    header.includes("артикул комплекта")
  );
  const placeNumberIndex = headers.findIndex(
    (header) =>
      header === "место" ||
      header === "места" ||
      header.includes("номер места")
  );
  const componentArticleIndex = headers.findIndex(
    (header) =>
      header.includes("артикул места") || header.includes("артикул компонента")
  );
  const countIndex = headers.findIndex((header) =>
    header.includes("количество мест")
  );

  if (
    articleIndex < 0 ||
    placeNumberIndex < 0 ||
    componentArticleIndex < 0 ||
    countIndex < 0
  ) {
    return null;
  }
  return { articleIndex, placeNumberIndex, componentArticleIndex, countIndex };
}

// ---------- Парсинг ----------

const SUSPICIOUS_DIM_CM = 500;
const SUSPICIOUS_WEIGHT_KG = 2000;
const SUSPICIOUS_QTY = 10000;

export function parseCatalog(
  spreadsheetTitle: string,
  sheets: { title: string; rows: (string | number | boolean)[][] }[]
): Catalog {
  const products: Record<string, CatalogProduct> = {};
  const rules: Record<string, PackingRule[]> = {};
  const composites: Record<string, CompositePlaceRule[]> = {};
  const issues: CatalogIssue[] = [];
  const suspicious: CatalogIssue[] = [];
  const duplicateArticles = new Set<string>();
  let catalogBlocks = 0;
  let packingBlocks = 0;
  let skippedCalcBlocks = 0;

  for (const sheet of sheets) {
    let block: HeaderAnalysis = { kind: null, columns: [] };
    let compositeHeader: CompositeHeader | null = null;

    for (let r = 0; r < sheet.rows.length; r++) {
      const row = sheet.rows[r] ?? [];
      const rowNumber = r + 1;

      const isEmpty = row.every((cell) => cellText(cell) === "");
      if (isEmpty) continue;

      // Не шапка ли это нового блока?
      const detectedCompositeHeader = analyzeCompositeHeaderRow(row);
      if (detectedCompositeHeader) {
        compositeHeader = detectedCompositeHeader;
        block = { kind: null, columns: [] };
        continue;
      }

      const header = analyzeHeaderRow(row);
      if (header.kind !== null) {
        compositeHeader = null;
        block = header;
        if (header.kind === "catalog") catalogBlocks++;
        else if (header.kind === "packing") packingBlocks++;
        else skippedCalcBlocks++;
        continue;
      }

      if (compositeHeader) {
        const article = normalizeArticle(
          cellText(row[compositeHeader.articleIndex])
        );
        const componentArticle = normalizeArticle(
          cellText(row[compositeHeader.componentArticleIndex])
        );
        if (article === "" && componentArticle === "") continue;

        const placeNumber = cellNumber(row[compositeHeader.placeNumberIndex]);
        const count = cellNumber(row[compositeHeader.countIndex]);
        if (
          article === "" ||
          componentArticle === "" ||
          placeNumber === null ||
          !Number.isInteger(placeNumber) ||
          placeNumber <= 0 ||
          count === null ||
          !Number.isInteger(count) ||
          count <= 0
        ) {
          issues.push({
            sheet: sheet.title,
            rowNumber,
            message:
              "Некорректная строка составного артикула: заполните артикул комплекта, номер места, артикул места и положительное целое количество мест.",
          });
          continue;
        }

        if (count > SUSPICIOUS_QTY) {
          suspicious.push({
            sheet: sheet.title,
            rowNumber,
            message: `${article}: подозрительное количество мест в комплекте = ${count}.`,
          });
        }

        const list = (composites[article] ??= []);
        if (list.some((item) => item.placeNumber === placeNumber)) {
          issues.push({
            sheet: sheet.title,
            rowNumber,
            message: `${article}: повторный номер места ${placeNumber} — использована первая строка.`,
          });
          continue;
        }
        list.push({
          article,
          placeNumber,
          componentArticle,
          count,
          sheet: sheet.title,
          rowNumber,
        });
        continue;
      }

      if (block.kind === null || block.kind === "calc") continue;

      const col = (key: ColumnKey) =>
        block.columns.find((c) => c.key === key);

      const articleRaw = cellText(row[col("article")!.index]);
      if (articleRaw === "" || normHeader(articleRaw) === "итого") continue;
      const article = normalizeArticle(articleRaw);

      const name = (() => {
        const c = col("name");
        return c ? cellText(row[c.index]) : "";
      })();

      const dim = (key: "length" | "width" | "height"): number | null => {
        const c = col(key);
        if (!c) return null;
        const value = cellNumber(row[c.index]);
        if (value === null) return null;
        return value * (c.toCm ?? 1);
      };

      const weight = (() => {
        const c = col("weight");
        return c ? cellNumber(row[c.index]) : null;
      })();

      const lengthCm = dim("length");
      const widthCm = dim("width");
      const heightCm = dim("height");

      const checkSuspicious = (label: string, value: number | null, limit: number) => {
        if (value === null) return;
        if (value <= 0 || value > limit) {
          suspicious.push({
            sheet: sheet.title,
            rowNumber,
            message: `${article}: подозрительное значение «${label}» = ${value}.`,
          });
        }
      };
      checkSuspicious("длина, см", lengthCm, SUSPICIOUS_DIM_CM);
      checkSuspicious("ширина, см", widthCm, SUSPICIOUS_DIM_CM);
      checkSuspicious("высота, см", heightCm, SUSPICIOUS_DIM_CM);
      checkSuspicious("вес, кг", weight, SUSPICIOUS_WEIGHT_KG);

      // Товарная строка: добавляем товар или дополняем недостающие данные,
      // если артикул уже встречался в другом блоке (конфликты фиксируем).
      const addProduct = () => {
        const existing = products[article];
        if (!existing) {
          products[article] = {
            article,
            name,
            lengthCm,
            widthCm,
            heightCm,
            weightKg: weight,
            sheet: sheet.title,
            rowNumber,
          };
          return;
        }
        let conflict = false;
        const merge = (
          field: "lengthCm" | "widthCm" | "heightCm" | "weightKg",
          incoming: number | null
        ) => {
          if (incoming === null) return;
          const current = existing[field];
          if (current === null) {
            existing[field] = incoming;
          } else if (Math.abs(current - incoming) > 0.001) {
            conflict = true;
          }
        };
        merge("lengthCm", lengthCm);
        merge("widthCm", widthCm);
        merge("heightCm", heightCm);
        merge("weightKg", weight);
        if (existing.name === "" && name !== "") existing.name = name;
        if (conflict) {
          duplicateArticles.add(article);
          issues.push({
            sheet: sheet.title,
            rowNumber,
            message: `${article}: данные строки расходятся с ранее прочитанными (лист «${existing.sheet}», строка ${existing.rowNumber}) — использованы первые значения.`,
          });
        }
      };

      if (block.kind === "catalog") {
        addProduct();
      } else {
        const qtyCol = col("qty")!;
        const qtyRaw = row[qtyCol.index];
        // Пустое количество в блоке с колонкой количества — это товарная
        // строка (моно-справочник), а не сломанное правило упаковки.
        if (cellText(qtyRaw) === "") {
          addProduct();
          continue;
        }
        const qty = cellNumber(qtyRaw);
        if (qty === null || qty <= 0 || !Number.isInteger(qty)) {
          issues.push({
            sheet: sheet.title,
            rowNumber,
            message: `${article}: некорректное количество в упаковке (${cellText(qtyRaw)}) — правило пропущено.`,
          });
          continue;
        }
        if (qty > SUSPICIOUS_QTY) {
          suspicious.push({
            sheet: sheet.title,
            rowNumber,
            message: `${article}: подозрительное количество в упаковке = ${qty}.`,
          });
        }
        const list = (rules[article] ??= []);
        if (list.some((existing) => existing.qty === qty)) {
          issues.push({
            sheet: sheet.title,
            rowNumber,
            message: `${article}: повторное правило упаковки на ${qty} шт — использовано первое.`,
          });
          continue;
        }
        list.push({
          article,
          name,
          qty,
          lengthCm,
          widthCm,
          heightCm,
          weightKg: weight,
          sheet: sheet.title,
          rowNumber,
        });
      }
    }
  }

  // Артикулы, встречающиеся только в блоках групповой упаковки, тоже товары:
  // их можно считать по правилам, но поштучный fallback для них недоступен.
  for (const [article, list] of Object.entries(rules)) {
    if (!products[article]) {
      const first = list[0];
      products[article] = {
        article,
        name: first.name,
        lengthCm: null,
        widthCm: null,
        heightCm: null,
        weightKg: null,
        sheet: first.sheet,
        rowNumber: first.rowNumber,
        fromPackingOnly: true,
      };
    }
  }

  for (const [article, places] of Object.entries(composites)) {
    places.sort((a, b) => a.placeNumber - b.placeNumber);
    const first = places[0];
    if (!products[article]) {
      issues.push({
        sheet: first.sheet,
        rowNumber: first.rowNumber,
        message: `${article}: составной артикул не найден в основном справочнике.`,
      });
    }
    for (const place of places) {
      if (!products[place.componentArticle]) {
        issues.push({
          sheet: place.sheet,
          rowNumber: place.rowNumber,
          message: `${place.componentArticle}: артикул места для комплекта ${article} не найден в справочнике.`,
        });
      } else if ((composites[place.componentArticle] ?? []).length > 0) {
        issues.push({
          sheet: place.sheet,
          rowNumber: place.rowNumber,
          message: `${article}: вложенный состав через ${place.componentArticle} не поддерживается; укажите физический артикул места.`,
        });
      }
    }
  }

  const productList = Object.values(products);
  const mainList = productList.filter((p) => !p.fromPackingOnly);
  const hasDims = (p: CatalogProduct) =>
    p.lengthCm !== null &&
    p.widthCm !== null &&
    p.heightCm !== null &&
    p.lengthCm > 0 &&
    p.widthCm > 0 &&
    p.heightCm > 0;
  const hasWeight = (p: CatalogProduct) =>
    p.weightKg !== null && p.weightKg > 0;
  const compositeComponents = (article: string) =>
    (composites[article] ?? [])
      .map((place) => products[place.componentArticle])
      .filter((product): product is CatalogProduct => Boolean(product))
      .filter((product) => (composites[product.article] ?? []).length === 0);
  const hasCompositeDims = (article: string) => {
    const places = composites[article] ?? [];
    const components = compositeComponents(article);
    return places.length > 0 && components.length === places.length && components.every(hasDims);
  };
  const hasCompositeWeight = (article: string) => {
    const places = composites[article] ?? [];
    const components = compositeComponents(article);
    return places.length > 0 && components.length === places.length && components.every(hasWeight);
  };
  const hasComposite = (article: string) =>
    (composites[article] ?? []).length > 0;
  const effectiveHasDims = (p: CatalogProduct) =>
    hasComposite(p.article) ? hasCompositeDims(p.article) : hasDims(p);
  const effectiveHasWeight = (p: CatalogProduct) =>
    hasComposite(p.article) ? hasCompositeWeight(p.article) : hasWeight(p);
  const isComplete = (p: CatalogProduct) =>
    effectiveHasDims(p) && effectiveHasWeight(p);

  const stats: CatalogStats = {
    productCount: mainList.length,
    productsComplete: mainList.filter(isComplete).length,
    productsWithoutWeight: mainList.filter((p) => !effectiveHasWeight(p)).length,
    productsWithoutDims: mainList.filter((p) => !effectiveHasDims(p)).length,
    ruleCount: Object.values(rules).reduce((sum, list) => sum + list.length, 0),
    articlesWithRules: Object.keys(rules).length,
    packingOnlyArticles: productList.length - mainList.length,
    compositeArticleCount: Object.keys(composites).length,
    compositePlaceCount: Object.values(composites).reduce(
      (sum, list) =>
        sum + list.reduce((listSum, place) => listSum + place.count, 0),
      0
    ),
    catalogBlocks,
    packingBlocks,
    skippedCalcBlocks,
  };

  return {
    spreadsheetTitle,
    products,
    rules,
    composites,
    duplicateArticles: [...duplicateArticles],
    issues,
    suspicious,
    stats,
    loadedAt: Date.now(),
  };
}

// ---------- Загрузка с кэшем ----------

/**
 * Небольшой кэш, чтобы автокомплит не читал таблицу на каждую букву.
 * Данные общие для всех пользователей (таблица одна), но кэш доступен
 * только после проверки доступа конкретного пользователя (см. apiAuth).
 * Для расчёта доставки используйте { fresh: true } — прочитает заново.
 */
let cache: Catalog | null = null;
const CACHE_TTL_MS = 60 * 1000;

export async function loadCatalog(
  accessToken: string,
  options: { fresh?: boolean } = {}
): Promise<CatalogResult> {
  if (
    !options.fresh &&
    cache &&
    Date.now() - cache.loadedAt < CACHE_TTL_MS
  ) {
    return { ok: true, catalog: cache };
  }

  const data = await readAllSheets(accessToken);
  if (!data.ok) return data;

  const catalog = parseCatalog(
    data.spreadsheetTitle,
    data.sheets.map((s) => ({ title: s.title, rows: s.rows }))
  );
  cache = catalog;
  return { ok: true, catalog };
}

// ---------- Поиск ----------

export function searchProducts(
  catalog: Catalog,
  query: string,
  limit = 10
): CatalogProduct[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const all = Object.values(catalog.products);

  const starts = all.filter((p) => p.article.toLowerCase().startsWith(q));
  const contains = all.filter(
    (p) =>
      !p.article.toLowerCase().startsWith(q) &&
      (p.article.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
  );
  return [...starts, ...contains].slice(0, limit);
}
