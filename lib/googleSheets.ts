import "server-only";

import { google, sheets_v4 } from "googleapis";

/**
 * Серверный модуль работы с Google Sheets.
 *
 * Все функции работают в контексте текущего пользователя: принимают его
 * OAuth access token и читают таблицу с его правами. Service account не
 * используется — доступом управляет владелец таблицы через обычную кнопку
 * «Поделиться».
 *
 * Ошибка доступа от Sheets API означает, что пользователь не имеет права
 * пользоваться калькулятором.
 */

const SAMPLE_ROW_COUNT = 20; // сколько первых строк каждого листа читаем для диагностики

// ---------- Конфигурация ----------

export function getSheetId():
  | { ok: true; sheetId: string }
  | { ok: false; missing: string[] } {
  const sheetId = process.env.GOOGLE_SHEET_ID?.trim();
  if (!sheetId) return { ok: false, missing: ["GOOGLE_SHEET_ID"] };
  return { ok: true, sheetId };
}

// ---------- Клиент ----------

/** Sheets-клиент с правами конкретного пользователя */
function createSheetsClient(accessToken: string): sheets_v4.Sheets {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.sheets({ version: "v4", auth });
}

/** Имя листа в A1-нотации: одиночные кавычки внутри имени удваиваются */
function quoteSheetTitle(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

// ---------- Типы результатов ----------

export interface SheetDiagnostics {
  /** Название листа как в таблице */
  title: string;
  /** Размер листа по данным Google (строк × колонок) */
  rowCount: number;
  columnCount: number;
  /** Первые строки листа (обрезаны до SAMPLE_ROW_COUNT) */
  sampleRows: string[][];
  /** Номер строки (1-based), которая распознана как шапка, или null */
  headerRowNumber: number | null;
  /** Найденные шапки колонок */
  headers: string[];
  /** Предупреждения по содержимому листа */
  warnings: string[];
}

export type SheetsAccessErrorCode =
  | "NO_SHEET_ID" // не задан GOOGLE_SHEET_ID
  | "NO_ACCESS" // у аккаунта пользователя нет доступа к таблице
  | "NOT_FOUND" // таблица не найдена (или скрыта из-за отсутствия доступа)
  | "TOKEN_EXPIRED" // access token недействителен — нужен повторный вход
  | "API_DISABLED" // в проекте Google Cloud не включён Google Sheets API
  | "SCOPE_MISSING" // пользователь не выдал приложению право чтения таблиц
  | "UNKNOWN";

export interface SheetsAccessError {
  ok: false;
  errorCode: SheetsAccessErrorCode;
  /** Понятное человеку описание проблемы и что делать */
  message: string;
  /** Техническая деталь исходной ошибки (для отладки) */
  details?: string;
}

export type AccessCheckResult =
  | { ok: true; spreadsheetTitle: string }
  | SheetsAccessError;

// ---------- Обработка ошибок API ----------

interface GoogleApiErrorLike {
  code?: number | string;
  message?: string;
  response?: { status?: number };
}

const NO_ACCESS_MESSAGE =
  "У вашего Google-аккаунта нет доступа к таблице. Попросите владельца таблицы открыть вам доступ: кнопка «Поделиться» в Google Таблице → добавить ваш email (достаточно роли «Читатель»). После этого обновите страницу.";

function mapApiError(error: unknown, sheetId: string): SheetsAccessError {
  const err = (error ?? {}) as GoogleApiErrorLike;
  const status = typeof err.code === "number" ? err.code : err.response?.status;
  const rawMessage = err.message ?? String(error);

  if (status === 401) {
    return {
      ok: false,
      errorCode: "TOKEN_EXPIRED",
      message: "Сессия Google истекла. Выйдите и войдите заново.",
      details: rawMessage,
    };
  }

  if (
    status === 403 &&
    /has not been used|is disabled|SERVICE_DISABLED/i.test(rawMessage)
  ) {
    return {
      ok: false,
      errorCode: "API_DISABLED",
      message:
        "В проекте Google Cloud, где создан OAuth-клиент, не включён Google Sheets API. Откройте console.cloud.google.com → APIs & Services → Library → «Google Sheets API» → Enable, подождите пару минут и обновите страницу.",
      details: rawMessage,
    };
  }

  if (
    status === 403 &&
    /insufficient.*scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(rawMessage)
  ) {
    return {
      ok: false,
      errorCode: "SCOPE_MISSING",
      message:
        "Приложению не выдано право на чтение Google Таблиц. Выйдите, войдите заново и на экране Google отметьте галочку разрешения на просмотр таблиц.",
      details: rawMessage,
    };
  }

  if (status === 403) {
    return {
      ok: false,
      errorCode: "NO_ACCESS",
      message: NO_ACCESS_MESSAGE,
      details: rawMessage,
    };
  }

  if (status === 404) {
    // Google может отвечать 404 и при отсутствии доступа, чтобы не раскрывать
    // существование документа, поэтому инструкция та же, что и для 403.
    return {
      ok: false,
      errorCode: "NOT_FOUND",
      message:
        `Таблица с ID «${sheetId}» не найдена или недоступна. ` +
        `Проверьте GOOGLE_SHEET_ID, а если ID верный — ${NO_ACCESS_MESSAGE.charAt(0).toLowerCase()}${NO_ACCESS_MESSAGE.slice(1)}`,
      details: rawMessage,
    };
  }

  return {
    ok: false,
    errorCode: "UNKNOWN",
    message: "Не удалось обратиться к Google Sheets. Подробности ниже.",
    details: rawMessage,
  };
}

// ---------- Проверка доступа ----------

/**
 * Проверяет, есть ли у пользователя доступ к таблице, попыткой прочитать
 * её метаданные (только название — минимальный запрос).
 */
export async function checkSpreadsheetAccess(
  accessToken: string
): Promise<AccessCheckResult> {
  const sheetIdResult = getSheetId();
  if (!sheetIdResult.ok) {
    return {
      ok: false,
      errorCode: "NO_SHEET_ID",
      message:
        "Не задана переменная окружения GOOGLE_SHEET_ID. Добавьте её в .env.local и перезапустите сервер.",
    };
  }

  const sheets = createSheetsClient(accessToken);
  try {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: sheetIdResult.sheetId,
      fields: "properties.title",
    });
    return {
      ok: true,
      spreadsheetTitle: meta.data.properties?.title ?? "(без названия)",
    };
  } catch (error) {
    return mapApiError(error, sheetIdResult.sheetId);
  }
}

// ---------- Полное чтение таблицы ----------

export interface SheetContent {
  title: string;
  /** Все строки листа; ячейки в исходном виде (число/строка/булево) */
  rows: (string | number | boolean)[][];
}

export type ReadAllResult =
  | { ok: true; spreadsheetTitle: string; sheets: SheetContent[] }
  | SheetsAccessError;

/**
 * Читает все листы таблицы целиком от имени пользователя.
 * UNFORMATTED_VALUE — числа приходят числами, а не строками с запятыми.
 */
export async function readAllSheets(
  accessToken: string
): Promise<ReadAllResult> {
  const sheetIdResult = getSheetId();
  if (!sheetIdResult.ok) {
    return {
      ok: false,
      errorCode: "NO_SHEET_ID",
      message:
        "Не задана переменная окружения GOOGLE_SHEET_ID. Добавьте её в .env.local и перезапустите сервер.",
    };
  }
  const { sheetId } = sheetIdResult;
  const sheets = createSheetsClient(accessToken);

  try {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: sheetId,
      fields: "properties.title,sheets(properties(title))",
    });
    const titles = (meta.data.sheets ?? [])
      .map((s) => s.properties?.title)
      .filter((t): t is string => Boolean(t));

    if (titles.length === 0) {
      return {
        ok: true,
        spreadsheetTitle: meta.data.properties?.title ?? "(без названия)",
        sheets: [],
      };
    }

    const values = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: sheetId,
      ranges: titles.map((t) => quoteSheetTitle(t)),
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const valueRanges = values.data.valueRanges ?? [];

    return {
      ok: true,
      spreadsheetTitle: meta.data.properties?.title ?? "(без названия)",
      sheets: titles.map((title, i) => ({
        title,
        rows: (valueRanges[i]?.values ?? []) as (string | number | boolean)[][],
      })),
    };
  } catch (error) {
    return mapApiError(error, sheetId);
  }
}

// ---------- Анализ содержимого листа ----------

function isRowEmpty(row: string[] | undefined): boolean {
  return !row || row.every((cell) => cell.trim() === "");
}

function looksLikeHeaderCell(cell: string): boolean {
  const value = cell.trim();
  if (value === "") return false;
  // Чисто числовое значение — это скорее данные, чем название колонки
  return !/^-?\d+([.,]\d+)?$/.test(value);
}

interface RowAnalysis {
  headerRowNumber: number | null;
  headers: string[];
  warnings: string[];
}

/**
 * Эвристический разбор первых строк листа:
 *  - шапкой считаем первую непустую строку;
 *  - предупреждаем о пустых строках между блоками данных;
 *  - предупреждаем о колонках без названия и о "числовых" шапках;
 *  - предупреждаем о повторе шапки ниже по листу (дублирующийся блок).
 */
function analyzeRows(rows: string[][]): RowAnalysis {
  const warnings: string[] = [];

  let headerIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    if (!isRowEmpty(rows[i])) {
      headerIndex = i;
      break;
    }
  }

  if (headerIndex === -1) {
    return {
      headerRowNumber: null,
      headers: [],
      warnings: ["Лист пуст или первые строки не содержат данных."],
    };
  }

  if (headerIndex > 0) {
    warnings.push(
      `Шапка найдена только на строке ${headerIndex + 1} — выше неё есть пустые строки.`
    );
  }

  const headerRow = rows[headerIndex];
  const headers = headerRow.map((cell) => cell.trim());

  // Пустые названия колонок в середине шапки
  const lastNamed = headers.reduce(
    (last, cell, idx) => (cell !== "" ? idx : last),
    -1
  );
  const unnamed: number[] = [];
  for (let i = 0; i <= lastNamed; i++) {
    if (headers[i] === "") unnamed.push(i + 1);
  }
  if (unnamed.length > 0) {
    warnings.push(
      `Нераспознанная шапка: колонки без названия (№ ${unnamed.join(", ")}).`
    );
  }

  // "Числовые" шапки — вероятно, шапки нет вовсе, а это строка данных
  const numericHeaders = headers.filter(
    (cell) => cell !== "" && !looksLikeHeaderCell(cell)
  );
  if (numericHeaders.length > 0) {
    warnings.push(
      `Нераспознанная шапка: похоже на данные, а не на названия колонок (${numericHeaders.join(", ")}). Возможно, на листе нет строки-шапки.`
    );
  }

  // Дубли названий колонок
  const seen = new Map<string, number>();
  for (const cell of headers) {
    if (cell === "") continue;
    seen.set(cell.toLowerCase(), (seen.get(cell.toLowerCase()) ?? 0) + 1);
  }
  const duplicatedNames = [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name);
  if (duplicatedNames.length > 0) {
    warnings.push(
      `Дублирующиеся названия колонок в шапке: ${duplicatedNames.join(", ")}.`
    );
  }

  // Пустые строки и повторные шапки ниже по листу
  const emptyRowNumbers: number[] = [];
  let sawDataBelow = false;
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (isRowEmpty(row)) {
      emptyRowNumbers.push(i + 1);
      continue;
    }
    sawDataBelow = true;
    const normalized = row.map((cell) => cell.trim().toLowerCase());
    const headerNormalized = headers.map((cell) => cell.toLowerCase());
    const sameAsHeader =
      headerNormalized.filter((h) => h !== "").length > 0 &&
      headerNormalized.every((h, idx) => (normalized[idx] ?? "") === h);
    if (sameAsHeader) {
      warnings.push(
        `Дублирующийся блок: шапка повторяется на строке ${i + 1}.`
      );
    }
  }

  // Пустые строки в хвосте выборки не считаем проблемой — это просто конец данных
  const meaningfulEmpty = emptyRowNumbers.filter((rowNumber) => {
    const rest = rows.slice(rowNumber); // строки после этой пустой (rowNumber = index+1)
    return rest.some((r) => !isRowEmpty(r));
  });
  if (meaningfulEmpty.length > 0) {
    warnings.push(
      `Пустые строки между данными: № ${meaningfulEmpty.join(", ")}.`
    );
  }

  if (!sawDataBelow) {
    warnings.push("После шапки в первых строках нет данных.");
  }

  return { headerRowNumber: headerIndex + 1, headers, warnings };
}

// ---------- Диагностика от имени пользователя ----------

export interface UserDiagnostics {
  sheetId: string | null;
  /** Шаг 1: чтение метаданных таблицы */
  metadata:
    | { ok: true; spreadsheetTitle: string; sheetTitles: string[] }
    | SheetsAccessError;
  /** Шаг 2: чтение первых строк каждого листа */
  rows: { ok: true; sheets: SheetDiagnostics[] } | SheetsAccessError | null;
}

/**
 * Полная диагностика доступа текущего пользователя к таблице:
 * метаданные (название, листы) + первые строки каждого листа с анализом шапок.
 */
export async function runUserDiagnostics(
  accessToken: string
): Promise<UserDiagnostics> {
  const sheetIdResult = getSheetId();
  if (!sheetIdResult.ok) {
    const error: SheetsAccessError = {
      ok: false,
      errorCode: "NO_SHEET_ID",
      message:
        "Не задана переменная окружения GOOGLE_SHEET_ID. Добавьте её в .env.local и перезапустите сервер.",
    };
    return { sheetId: null, metadata: error, rows: null };
  }
  const { sheetId } = sheetIdResult;
  const sheets = createSheetsClient(accessToken);

  // Шаг 1: метаданные
  let sheetProps: sheets_v4.Schema$SheetProperties[];
  let spreadsheetTitle: string;
  try {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: sheetId,
      fields:
        "properties.title,sheets(properties(title,gridProperties(rowCount,columnCount)))",
    });
    spreadsheetTitle = meta.data.properties?.title ?? "(без названия)";
    sheetProps = (meta.data.sheets ?? [])
      .map((s) => s.properties)
      .filter((p): p is sheets_v4.Schema$SheetProperties => Boolean(p));
  } catch (error) {
    return { sheetId, metadata: mapApiError(error, sheetId), rows: null };
  }

  const metadata = {
    ok: true as const,
    spreadsheetTitle,
    sheetTitles: sheetProps.map((p) => p.title ?? "(без названия)"),
  };

  if (sheetProps.length === 0) {
    return { sheetId, metadata, rows: { ok: true, sheets: [] } };
  }

  // Шаг 2: первые строки каждого листа одним batch-запросом
  try {
    const ranges = sheetProps.map(
      (p) => `${quoteSheetTitle(p.title ?? "")}!1:${SAMPLE_ROW_COUNT}`
    );
    const values = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: sheetId,
      ranges,
      valueRenderOption: "FORMATTED_VALUE",
    });
    const valueRanges = values.data.valueRanges ?? [];

    const sheetDiagnostics: SheetDiagnostics[] = sheetProps.map((props, i) => {
      const rawRows = (valueRanges[i]?.values ?? []) as unknown[][];
      const rows = rawRows.map((row) => row.map((cell) => String(cell ?? "")));
      const analysis = analyzeRows(rows);
      return {
        title: props.title ?? `(лист ${i + 1})`,
        rowCount: props.gridProperties?.rowCount ?? 0,
        columnCount: props.gridProperties?.columnCount ?? 0,
        sampleRows: rows,
        headerRowNumber: analysis.headerRowNumber,
        headers: analysis.headers,
        warnings: analysis.warnings,
      };
    });

    return { sheetId, metadata, rows: { ok: true, sheets: sheetDiagnostics } };
  } catch (error) {
    return { sheetId, metadata, rows: mapApiError(error, sheetId) };
  }
}
