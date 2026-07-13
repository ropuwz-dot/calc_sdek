"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CityDto,
  DeliveryMode,
  DellinCityDto,
  DellinQuoteResponse,
  DellinStreetDto,
  DellinTerminalDto,
  DellinTariffDto,
  ManualPlaceInput,
  PackingDto,
  PlaceDto,
  PositionInput,
  ProductSuggestion,
  PvzDto,
  PvzSearchItem,
  QuoteResponse,
  TariffDto,
} from "@/lib/types";
import { DELIVERY_MODE_LABELS, pvzFitProblem } from "@/lib/types";
import {
  loadRecentDirections,
  recentDirectionKey,
  rememberDirection,
  saveRecentDirections,
  toggleDirectionPinned,
  type RecentDirection,
  type RecentDirectionsState,
} from "@/lib/recents";
import {
  decodeSharePayload,
  encodeSharePayload,
  type ShareLinkPayload,
} from "@/lib/shareLink";
import {
  addCalculationHistoryEntry,
  clearCalculationHistory,
  loadCalculationHistory,
  removeCalculationHistoryEntry,
  saveCalculationHistory,
  type CalculationHistoryDraft,
  type CalculationHistoryEntry,
} from "@/lib/calculationHistory";

/**
 * Клиент калькулятора. Работает только с собственным API приложения;
 * все данные о габаритах/весе сервер берёт из таблицы сам.
 */

interface Position extends PositionInput {
  name: string;
}

type ManualPlace = ManualPlaceInput & { id: number };
type DeliveryTab = "cdek" | "dellin";
type CarrierHealthStatus = "ok" | "down" | "unknown";

interface CarrierHealthItem {
  status: "ok" | "down";
  checkedAt: string;
  latencyMs: number;
}

type CarrierHealthResponse = {
  cdek: CarrierHealthItem;
  dellin: CarrierHealthItem;
};

type CarrierHealthState = Record<
  DeliveryTab,
  { status: CarrierHealthStatus; checkedAt: string | null }
>;

/** Ставка НДС, добавляется к стоимости из расчёта СДЭК */
const VAT_RATE = 0.22;
/** Наценка к «Итого», когда доставку оплачивает клиент */
const CLIENT_PAYS_MARKUP = 0.05;

const rub = (value: number) =>
  value.toLocaleString("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const shortTerminalAddress = (address: string) => {
  const normalized = address.replace(/^Россия,\s*/i, "").trim();
  const streetMatch = normalized.match(
    /((?:ул|улица|пр-кт|проспект|пр|пер|переулок|ш|шоссе|пл|площадь|наб|набережная|б-р|бульвар|проезд|тракт|дорога)\.?\s+.+)$/i
  );
  return streetMatch?.[1] ?? normalized;
};

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

/**
 * Разбор ответа API с защитой от не-JSON: если прокси (nginx) подменил
 * ответ HTML-страницей ошибки или роут упал, показываем понятное
 * сообщение вместо «JSON.parse: unexpected character».
 */
async function parseJson<T>(res: Response): Promise<T & { message?: string }> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T & { message?: string };
  } catch {
    throw new Error(
      `Сервер вернул неожиданный ответ (HTTP ${res.status}). Обычно это значит, что на сервере не заданы переменные окружения (например, ключи ДЛ/СДЭК) — проверьте .env.local и логи приложения.`
    );
  }
}

async function apiGet<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const data = await parseJson<T>(res);
  if (!res.ok) throw new Error(data.message ?? `Ошибка запроса (${res.status})`);
  return data;
}

async function apiPost<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await parseJson<T>(res);
  if (!res.ok) throw new Error(data.message ?? `Ошибка запроса (${res.status})`);
  return data;
}

function formatCheckedAt(value: string | null): string {
  if (!value) return "проверка ещё не выполнена";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "время проверки неизвестно";
  return `проверено ${date.toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function CarrierHealthBadges() {
  const [health, setHealth] = useState<CarrierHealthState>({
    cdek: { status: "unknown", checkedAt: null },
    dellin: { status: "unknown", checkedAt: null },
  });

  useEffect(() => {
    let cancelled = false;

    const load = () => {
      apiGet<CarrierHealthResponse>("/api/health/carriers")
        .then((data) => {
          if (cancelled) return;
          setHealth({
            cdek: {
              status: data.cdek.status,
              checkedAt: data.cdek.checkedAt,
            },
            dellin: {
              status: data.dellin.status,
              checkedAt: data.dellin.checkedAt,
            },
          });
        })
        .catch(() => {
          if (cancelled) return;
          setHealth({
            cdek: { status: "unknown", checkedAt: null },
            dellin: { status: "unknown", checkedAt: null },
          });
        });
    };

    load();
    const interval = window.setInterval(load, 90_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  return (
    <div className="carrier-health" aria-label="Состояние транспортных компаний">
      <CarrierHealthBadge label="СДЭК" state={health.cdek} />
      <CarrierHealthBadge label="ДЛ" state={health.dellin} />
    </div>
  );
}

function CarrierHealthBadge({
  label,
  state,
}: {
  label: string;
  state: CarrierHealthState[DeliveryTab];
}) {
  const text =
    state.status === "ok"
      ? "работает"
      : state.status === "down"
        ? "недоступна"
        : "неизвестно";

  return (
    <span
      className={`carrier-health-badge ${state.status}`}
      title={formatCheckedAt(state.checkedAt)}
    >
      <span className="carrier-health-dot" aria-hidden="true" />
      <span>{label}</span>
      <span>{text}</span>
    </span>
  );
}

// ---------- Улица с подсказками DaData (для СДЭК) ----------

function StreetField({
  label,
  cityName,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  /** Город для фильтра подсказок; null — подсказки не запрашиваются */
  cityName: string | null;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  const [options, setOptions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState(false);
  const debounced = useDebounced(value, 300);
  const activeOptions =
    !cityName || picked || debounced.trim().length < 2 ? [] : options;

  useEffect(() => {
    if (!cityName || picked || debounced.trim().length < 2) {
      return;
    }
    let cancelled = false;
    apiGet<{ streets: string[] }>(
      `/api/streets?city=${encodeURIComponent(cityName)}&q=${encodeURIComponent(debounced)}`
    )
      .then((data) => {
        if (!cancelled) {
          setOptions(data.streets);
          setOpen(data.streets.length > 0);
        }
      })
      // Подсказки — необязательное удобство: при ошибке просто без них
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [debounced, cityName, picked]);

  return (
    <div className="field grow">
      <label>{label}</label>
      <div className="suggest-wrap">
        <input
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(e) => {
            onChange(e.target.value);
            setPicked(false);
          }}
          onFocus={() => activeOptions.length > 0 && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 200)}
        />
        {open && activeOptions.length > 0 && (
          <ul className="suggest-list">
            {activeOptions.map((street) => (
              <li key={street}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(street);
                    setPicked(true);
                    setOpen(false);
                  }}
                >
                  {street}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------- Подсказка города ----------

function CityField({
  label,
  value,
  onSelect,
}: {
  label: string;
  value: CityDto | null;
  onSelect: (city: CityDto | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<CityDto[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debouncedQuery = useDebounced(query, 300);
  const activeOptions = value || debouncedQuery.trim().length < 2 ? [] : options;

  useEffect(() => {
    if (value || debouncedQuery.trim().length < 2) {
      return;
    }
    let cancelled = false;
    apiGet<{ cities: CityDto[] }>(
      `/api/locations?q=${encodeURIComponent(debouncedQuery)}`
    )
      .then((data) => {
        if (!cancelled) {
          setOptions(data.cities);
          setOpen(true);
          setError(null);
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, value]);

  return (
    <div className="field grow">
      <label>{label}</label>
      {value ? (
        <div className="selected-chip">
          <span>{value.name}</span>
          <button
            type="button"
            className="link-button"
            onClick={() => {
              onSelect(null);
              setQuery("");
            }}
          >
            изменить
          </button>
        </div>
      ) : (
        <div className="suggest-wrap">
          <input
            type="text"
            value={query}
            placeholder="Начните вводить город…"
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => activeOptions.length > 0 && setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 200)}
          />
          {open && activeOptions.length > 0 && (
            <ul className="suggest-list">
              {activeOptions.map((city) => (
                <li key={city.code}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(city);
                      setOpen(false);
                    }}
                  >
                    {city.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}

// ---------- Подсказка ПВЗ ----------

function DellinCityField({
  label,
  value,
  onSelect,
}: {
  label: string;
  value: DellinCityDto | null;
  onSelect: (city: DellinCityDto | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<DellinCityDto[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debouncedQuery = useDebounced(query, 300);
  const activeOptions = value || debouncedQuery.trim().length < 2 ? [] : options;

  useEffect(() => {
    if (value || debouncedQuery.trim().length < 2) {
      return;
    }
    let cancelled = false;
    apiGet<{ cities: DellinCityDto[] }>(
      `/api/dellin/locations?q=${encodeURIComponent(debouncedQuery)}`
    )
      .then((data) => {
        if (!cancelled) {
          setOptions(data.cities);
          setOpen(true);
          setError(null);
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, value]);

  return (
    <div className="field grow">
      <label>{label}</label>
      {value ? (
        <div className="selected-chip">
          <span>
            {value.name}
            {value.regionName ? `, ${value.regionName}` : ""}
          </span>
          <button
            type="button"
            className="link-button"
            onClick={() => {
              onSelect(null);
              setQuery("");
            }}
          >
            изменить
          </button>
        </div>
      ) : (
        <div className="suggest-wrap">
          <input
            type="text"
            value={query}
            placeholder="Начните вводить город..."
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => activeOptions.length > 0 && setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 200)}
          />
          {open && activeOptions.length > 0 && (
            <ul className="suggest-list">
              {activeOptions.map((city) => (
                <li key={`${city.code}-${city.cityId}`}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(city);
                      setOpen(false);
                    }}
                  >
                    {city.name}
                    <span className="suggest-meta">
                      {city.regionName ? ` ${city.regionName}` : ""}
                      {city.isTerminal ? " · есть терминал" : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}

function DellinStreetField({
  label,
  city,
  value,
  onSelect,
}: {
  label: string;
  city: DellinCityDto | null;
  value: DellinStreetDto | null;
  onSelect: (street: DellinStreetDto | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<DellinStreetDto[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debouncedQuery = useDebounced(query, 300);
  const activeOptions =
    !city || value || debouncedQuery.trim().length < 2 ? [] : options;

  useEffect(() => {
    if (!city || value || debouncedQuery.trim().length < 2) {
      return;
    }
    let cancelled = false;
    apiGet<{ streets: DellinStreetDto[] }>(
      `/api/dellin/streets?cityId=${city.cityId}&q=${encodeURIComponent(
        debouncedQuery
      )}`
    )
      .then((data) => {
        if (!cancelled) {
          setOptions(data.streets);
          setOpen(true);
          setError(null);
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [city, debouncedQuery, value]);

  return (
    <div className="field grow">
      <label>{label}</label>
      {value ? (
        <div className="selected-chip">
          <span>{value.fullName}</span>
          <button
            type="button"
            className="link-button"
            onClick={() => {
              onSelect(null);
              setQuery("");
            }}
          >
            изменить
          </button>
        </div>
      ) : (
        <div className="suggest-wrap">
          <input
            type="text"
            value={query}
            disabled={!city}
            placeholder={city ? "Начните вводить улицу..." : "Сначала выберите город"}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => activeOptions.length > 0 && setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 200)}
          />
          {open && activeOptions.length > 0 && (
            <ul className="suggest-list">
              {activeOptions.map((street) => (
                <li key={street.code}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(street);
                      setOpen(false);
                    }}
                  >
                    {street.fullName}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}

function DellinTerminalField({
  label,
  city,
  direction,
  value,
  onSelect,
  items,
  manualPlaces,
  enabled,
  restoredTerminalId,
}: {
  label: string;
  city: DellinCityDto | null;
  direction: "derival" | "arrival";
  value: DellinTerminalDto | null;
  onSelect: (terminal: DellinTerminalDto | null) => void;
  items: Position[];
  manualPlaces: ManualPlace[];
  enabled: boolean;
  restoredTerminalId?: number | null;
}) {
  const [terminals, setTerminals] = useState<DellinTerminalDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Дебаунс по составу мест: изменение позиций не должно дёргать
  // подбор терминалов (каталог + API ДЛ) на каждый клик.
  const placesPayload = useMemo(
    () => ({
      items: items.map(({ article, qty }) => ({ article, qty })),
      manualPlaces: manualPlaces.map(({ id, ...place }) => {
        void id;
        return place;
      }),
    }),
    [items, manualPlaces]
  );
  const placesKey = useDebounced(JSON.stringify(placesPayload), 600);
  const itemsRef = useRef(items);
  const manualRef = useRef(manualPlaces);
  const restoredTerminalIdRef = useRef(restoredTerminalId ?? null);
  const restoredCityCodeRef = useRef(
    restoredTerminalId !== null && restoredTerminalId !== undefined
      ? (city?.code ?? null)
      : null
  );

  useEffect(() => {
    itemsRef.current = items;
    manualRef.current = manualPlaces;
  }, [items, manualPlaces]);

  useEffect(() => {
    if (!city || !enabled) return;

    let cancelled = false;
    const canUseRestoredTerminal =
      restoredTerminalIdRef.current !== null &&
      restoredCityCodeRef.current === city.code;

    if (
      restoredTerminalIdRef.current !== null &&
      restoredCityCodeRef.current !== city.code
    ) {
      restoredTerminalIdRef.current = null;
      restoredCityCodeRef.current = null;
    }

    Promise.resolve()
      .then(() => {
        if (cancelled) return null;
        if (!canUseRestoredTerminal) onSelect(null);
        setTerminals([]);
        setError(null);
        setLoading(true);
        return apiPost<{ terminals: DellinTerminalDto[] }>(
          "/api/dellin/terminals",
          {
            cityCode: city.code,
            direction,
            items: itemsRef.current.map(({ article, qty }) => ({
              article,
              qty,
            })),
            manualPlaces: manualRef.current.map(({ id, ...place }) => {
              void id;
              return place;
            }),
          }
        );
      })
      .then((data) => {
        if (cancelled || !data) return;
        setTerminals(data.terminals);
        const restoredTerminal = canUseRestoredTerminal
          ? data.terminals.find(
              (terminal) => terminal.id === restoredTerminalIdRef.current
            )
          : null;
        onSelect(
          restoredTerminal ??
            data.terminals.find((terminal) => terminal.isDefault) ??
            data.terminals[0] ??
            null
        );
        if (canUseRestoredTerminal) {
          restoredTerminalIdRef.current = null;
          restoredCityCodeRef.current = null;
        }
        setError(null);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city, direction, enabled, placesKey]);

  return (
    <div className="field grow">
      <label>{label}</label>
      {!city ? (
        <p className="meta-line" style={{ margin: "8px 0 0" }}>
          Сначала выберите город.
        </p>
      ) : !enabled ? (
        <p className="meta-line" style={{ margin: "8px 0 0" }}>
          Добавьте товарные позиции или ручное место.
        </p>
      ) : loading ? (
        <p className="meta-line" style={{ margin: "8px 0 0" }}>
          Загружаем терминалы...
        </p>
      ) : terminals.length > 0 ? (
        <>
          <select
            value={value?.id ?? ""}
            onChange={(e) => {
              const id = Number(e.target.value);
              onSelect(terminals.find((terminal) => terminal.id === id) ?? null);
            }}
          >
            {terminals.map((terminal) => (
              <option key={terminal.id} value={terminal.id}>
                {terminal.name}
                {terminal.address
                  ? ` — ${shortTerminalAddress(terminal.address)}`
                  : ""}
              </option>
            ))}
          </select>
          {value && (
            <p className="terminal-address">
              {value.address || "Адрес терминала не указан в справочнике ДЛ."}
            </p>
          )}
        </>
      ) : (
        <p className="meta-line" style={{ margin: "8px 0 0" }}>
          Нет доступных терминалов.
        </p>
      )}
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}

function PvzField({
  label,
  cityCode,
  cityName,
  side,
  value,
  onSelect,
  problem,
  checked,
}: {
  label: string;
  cityCode: number;
  cityName: string;
  side: "from" | "to";
  value: PvzDto | null;
  onSelect: (pvz: PvzDto | null) => void;
  /** Результат проверки лимитов выбранного ПВЗ (null = проходит) */
  problem: string | null;
  /** Есть ли рассчитанные места для проверки */
  checked: boolean;
}) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<PvzSearchItem[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debouncedQuery = useDebounced(query, 300);

  const url = (q: string) =>
    `/api/pvz?city=${cityCode}&cityName=${encodeURIComponent(cityName)}&side=${side}&q=${encodeURIComponent(q)}`;

  const load = (q: string) => {
    apiGet<{ points: PvzSearchItem[] }>(url(q))
      .then((data) => {
        setOptions(data.points);
        setOpen(true);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  };

  useEffect(() => {
    if (value) return;
    if (debouncedQuery.trim().length < 2) return;
    let cancelled = false;
    apiGet<{ points: PvzSearchItem[] }>(url(debouncedQuery))
      .then((data) => {
        if (!cancelled) {
          setOptions(data.points);
          setOpen(true);
          setError(null);
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery, value, cityCode, side]);

  const pvzLimitText = (pvz: PvzDto) =>
    pvz.weightMaxKg !== null ? ` (до ${pvz.weightMaxKg} кг/место)` : "";

  const distanceText = (pvz: PvzSearchItem) =>
    typeof pvz.distanceM === "number"
      ? ` · ~${
          pvz.distanceM >= 1000
            ? `${(pvz.distanceM / 1000).toFixed(1)} км`
            : `${pvz.distanceM} м`
        } от адреса`
      : "";

  return (
    <div className="field grow">
      <label>{label}</label>
      {value ? (
        <>
          <div className="selected-chip">
            <span>
              <strong>{value.name}</strong> — {value.address}
              {pvzLimitText(value)}
            </span>
            <button
              type="button"
              className="link-button"
              onClick={() => {
                onSelect(null);
                setQuery("");
              }}
            >
              изменить
            </button>
          </div>
          {checked &&
            (problem ? (
              <p className="field-error">
                ⛔ Груз невозможно {side === "to" ? "доставить в" : "отправить из"}{" "}
                этот ПВЗ: {problem}.
              </p>
            ) : (
              <p className="field-ok">✓ ПВЗ принимает такие места</p>
            ))}
        </>
      ) : (
        <div className="suggest-wrap">
          <input
            type="text"
            value={query}
            placeholder="Улица или адрес — подберём ПВЗ… (необязательно)"
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => {
              if (options.length > 0) setOpen(true);
              else load(query);
            }}
            onBlur={() => setTimeout(() => setOpen(false), 200)}
          />
          {open && options.length > 0 && (
            <ul className="suggest-list">
              {options.map((pvz) => (
                <li key={pvz.code}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(pvz);
                      setOpen(false);
                    }}
                  >
                    <strong>{pvz.address}</strong>
                    <span className="suggest-meta">
                      {" "}
                      {pvz.name}
                      {pvzLimitText(pvz)}
                      {distanceText(pvz)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}

function DirectionRecents<TCity>({
  carrier,
  items,
  onApply,
  onTogglePinned,
  formatCity,
}: {
  carrier: DeliveryTab;
  items: RecentDirection<TCity>[];
  onApply: (direction: RecentDirection<TCity>) => void;
  onTogglePinned: (key: string) => void;
  formatCity: (city: TCity) => string;
}) {
  if (items.length === 0) return null;

  return (
    <div className="direction-recents">
      <span className="direction-recents-label">Недавние направления</span>
      <div className="chip-list" aria-label="Недавние направления">
        {items.map((direction) => {
          const key = recentDirectionKey(carrier, direction);
          return (
            <span key={key} className="chip direction-chip">
              <button
                type="button"
                className={`link-button direction-pin ${
                  direction.pinned ? "pinned" : ""
                }`}
                onClick={() => onTogglePinned(key)}
                title={
                  direction.pinned
                    ? "Открепить направление"
                    : "Закрепить направление"
                }
                aria-label={
                  direction.pinned
                    ? "Открепить направление"
                    : "Закрепить направление"
                }
              >
                {direction.pinned ? "★" : "☆"}
              </button>
              <button
                type="button"
                className="link-button direction-apply"
                onClick={() => onApply(direction)}
                title="Применить направление"
              >
                {formatCity(direction.from)} → {formatCity(direction.to)}
              </button>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function historyCargoLabel(entry: CalculationHistoryEntry): string {
  const articles = entry.payload.positions
    .slice(0, 3)
    .map((item) => `${item.article} × ${item.qty}`);
  if (entry.payload.positions.length > 3) {
    articles.push(`ещё ${entry.payload.positions.length - 3}`);
  }
  const manualCount = entry.payload.manualPlaces.reduce(
    (sum, place) => sum + place.count,
    0
  );
  if (manualCount > 0) articles.push(`ручных мест: ${manualCount}`);
  return articles.join(", ") || "Без товарных позиций";
}

function historyPeriodLabel(entry: CalculationHistoryEntry): string {
  if (entry.periodMin <= 0 && entry.periodMax <= 0) return "срок не указан";
  return entry.periodMin === entry.periodMax
    ? `${entry.periodMin} дн.`
    : `${entry.periodMin}–${entry.periodMax} дн.`;
}

function CalculationHistoryPanel({
  entries,
  onOpen,
  onRemove,
  onClear,
}: {
  entries: CalculationHistoryEntry[];
  onOpen: (entry: CalculationHistoryEntry) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  return (
    <div className="card calculation-history">
      <div className="history-heading">
        <h2>
          История расчётов <small>{entries.length}/20</small>
        </h2>
        {entries.length > 0 && (
          <button type="button" className="link-button" onClick={onClear}>
            Очистить историю
          </button>
        )}
      </div>
      {entries.length === 0 ? (
        <p className="meta-line">Пока нет сохранённых расчётов.</p>
      ) : (
        <div className="history-list">
          {entries.map((entry) => (
            <article className="history-row" key={entry.id}>
              <div className="history-main">
                <div className="history-primary">
                  <strong>
                    {entry.carrier === "cdek" ? "СДЭК" : "Деловые Линии"}
                  </strong>
                  <time dateTime={new Date(entry.createdAt).toISOString()}>
                    {new Date(entry.createdAt).toLocaleString("ru-RU", {
                      day: "2-digit",
                      month: "2-digit",
                      year: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </div>
                <div className="history-route">
                  {entry.from} → {entry.to}
                </div>
                <div className="history-meta">
                  {DELIVERY_MODE_LABELS[entry.mode]} · {historyCargoLabel(entry)}
                </div>
                <div className="history-meta">
                  {entry.totalPlaces} мест · {entry.totalWeightKg} кг ·{" "}
                  {entry.totalVolumeM3.toFixed(4)} м³
                </div>
              </div>
              <div className="history-result">
                <strong>{rub(entry.totalPrice)} ₽</strong>
                <span>{entry.tariffName}</span>
                <span>{historyPeriodLabel(entry)}</span>
              </div>
              <div className="history-actions">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => onOpen(entry)}
                >
                  Открыть
                </button>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => onRemove(entry.id)}
                >
                  Удалить
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Основной компонент ----------

export default function Calculator() {
  const [shareRestore] = useState(() => {
    if (typeof window === "undefined") {
      return { payload: null, invalid: false };
    }
    const url = new URL(window.location.href);
    if (!url.searchParams.has("c")) {
      return { payload: null, invalid: false };
    }
    const payload = decodeSharePayload(url.searchParams.get("c"));
    return { payload, invalid: payload === null };
  });
  const initialManualPlaces = (shareRestore.payload?.manualPlaces ?? []).map(
    (place, index) => ({
      ...place,
      id: index + 1,
    })
  );

  // Поиск товара
  const [searchQ, setSearchQ] = useState("");
  const [suggestions, setSuggestions] = useState<ProductSuggestion[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [selected, setSelected] = useState<ProductSuggestion | null>(null);
  const [qty, setQty] = useState("1");
  const [searchError, setSearchError] = useState<string | null>(null);
  const debouncedSearch = useDebounced(searchQ, 300);

  // Позиции и упаковка
  const [positions, setPositions] = useState<Position[]>([]);
  const [packing, setPacking] = useState<PackingDto | null>(null);
  const [packLoading, setPackLoading] = useState(false);
  const [packError, setPackError] = useState<string | null>(null);

  // Ручные места (без номенклатуры)
  const [manualPlaces, setManualPlaces] = useState<
    ManualPlace[]
  >(initialManualPlaces);
  const [manualForm, setManualForm] = useState({
    lengthCm: "",
    widthCm: "",
    heightCm: "",
    weightKg: "",
    count: "1",
  });
  const manualIdRef = useRef(initialManualPlaces.length);

  // Доставка
  const [fromCity, setFromCityState] = useState<CityDto | null>(
    shareRestore.payload?.cdek.cities.from ?? null
  );
  const [toCity, setToCityState] = useState<CityDto | null>(
    shareRestore.payload?.cdek.cities.to ?? null
  );
  // Адрес для сторон «дверь» у СДЭК: улица — свободный текст (у СДЭК нет
  // справочника улиц в API), дом и квартира — отдельными полями, как у ДЛ
  const [fromStreet, setFromStreet] = useState(
    shareRestore.payload?.cdek.address.fromStreet ?? ""
  );
  const [fromHouse, setFromHouse] = useState(
    shareRestore.payload?.cdek.address.fromHouse ?? ""
  );
  const [fromFlat, setFromFlat] = useState(
    shareRestore.payload?.cdek.address.fromFlat ?? ""
  );
  const [toStreet, setToStreet] = useState(
    shareRestore.payload?.cdek.address.toStreet ?? ""
  );
  const [toHouse, setToHouse] = useState(
    shareRestore.payload?.cdek.address.toHouse ?? ""
  );
  const [toFlat, setToFlat] = useState(
    shareRestore.payload?.cdek.address.toFlat ?? ""
  );

  const composeAddress = (street: string, house: string, flat: string) => {
    const base = [street.trim(), house.trim()].filter(Boolean).join(", ");
    return flat.trim() ? `${base}, кв. ${flat.trim()}` : base;
  };
  const [fromPvz, setFromPvz] = useState<PvzDto | null>(
    shareRestore.payload?.cdek.pvz.from ?? null
  );
  const [toPvz, setToPvz] = useState<PvzDto | null>(
    shareRestore.payload?.cdek.pvz.to ?? null
  );
  const [mode, setMode] = useState<DeliveryMode>(
    shareRestore.payload?.cdek.mode ?? "warehouse-warehouse"
  );
  const [clientPays, setClientPays] = useState(
    shareRestore.payload?.clientPays ?? false
  );
  const [activeDeliveryTab, setActiveDeliveryTab] =
    useState<DeliveryTab>(shareRestore.payload?.tab ?? "cdek");
  const [recentDirections, setRecentDirections] =
    useState<RecentDirectionsState>(() => loadRecentDirections());
  const [calculationHistory, setCalculationHistory] = useState<
    CalculationHistoryEntry[]
  >(() => loadCalculationHistory());
  const [copyLinkStatus, setCopyLinkStatus] = useState<string | null>(null);
  const restoreHandled = useRef(false);

  const updateRecentDirections = (next: RecentDirectionsState) => {
    setRecentDirections(next);
    saveRecentDirections(next);
  };

  const rememberCalculation = (draft: CalculationHistoryDraft) => {
    setCalculationHistory((current) => {
      const next = addCalculationHistoryEntry(current, draft);
      saveCalculationHistory(next);
      return next;
    });
  };

  const removeHistoryEntry = (id: string) => {
    setCalculationHistory((current) => {
      const next = removeCalculationHistoryEntry(current, id);
      saveCalculationHistory(next);
      return next;
    });
  };

  const clearHistory = () => {
    if (
      typeof window !== "undefined" &&
      !window.confirm("Удалить всю локальную историю расчётов?")
    ) {
      return;
    }
    clearCalculationHistory();
    setCalculationHistory([]);
  };

  // Смена города сбрасывает выбранный в нём ПВЗ и устаревший результат расчёта
  const setFromCity = (city: CityDto | null) => {
    setFromCityState(city);
    setFromPvz(null);
    setQuote(null);
    setQuoteError(null);
  };
  const setToCity = (city: CityDto | null) => {
    setToCityState(city);
    setToPvz(null);
    setQuote(null);
    setQuoteError(null);
  };
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  const [dellinFromCity, setDellinFromCity] =
    useState<DellinCityDto | null>(
      shareRestore.payload?.dellin.cities.from ?? null
    );
  const [dellinToCity, setDellinToCity] = useState<DellinCityDto | null>(
    shareRestore.payload?.dellin.cities.to ?? null
  );
  const [dellinFromStreet, setDellinFromStreet] =
    useState<DellinStreetDto | null>(
      shareRestore.payload?.dellin.street.from ?? null
    );
  const [dellinToStreet, setDellinToStreet] =
    useState<DellinStreetDto | null>(
      shareRestore.payload?.dellin.street.to ?? null
    );
  const [dellinFromTerminal, setDellinFromTerminal] =
    useState<DellinTerminalDto | null>(
      shareRestore.payload?.dellin.terminal.from ?? null
    );
  const [dellinToTerminal, setDellinToTerminal] =
    useState<DellinTerminalDto | null>(
      shareRestore.payload?.dellin.terminal.to ?? null
    );
  const [dellinFromHouse, setDellinFromHouse] = useState(
    shareRestore.payload?.dellin.house.from ?? ""
  );
  const [dellinToHouse, setDellinToHouse] = useState(
    shareRestore.payload?.dellin.house.to ?? ""
  );
  const [dellinFromFlat, setDellinFromFlat] = useState(
    shareRestore.payload?.dellin.flat.from ?? ""
  );
  const [dellinToFlat, setDellinToFlat] = useState(
    shareRestore.payload?.dellin.flat.to ?? ""
  );
  const [dellinMode, setDellinMode] =
    useState<DeliveryMode>(
      shareRestore.payload?.dellin.mode ?? "warehouse-warehouse"
    );
  const [dellinQuote, setDellinQuote] =
    useState<DellinQuoteResponse | null>(null);
  const [dellinQuoteLoading, setDellinQuoteLoading] = useState(false);
  const [dellinQuoteError, setDellinQuoteError] = useState<string | null>(null);

  // Смена города/режима ДЛ сбрасывает устаревший результат расчёта
  const selectDellinFromCity = (city: DellinCityDto | null) => {
    setDellinFromCity(city);
    setDellinFromStreet(null);
    setDellinQuote(null);
    setDellinQuoteError(null);
  };
  const selectDellinToCity = (city: DellinCityDto | null) => {
    setDellinToCity(city);
    setDellinToStreet(null);
    setDellinQuote(null);
    setDellinQuoteError(null);
  };

  const applyCdekDirection = (direction: RecentDirection<CityDto>) => {
    setFromCity(direction.from);
    setToCity(direction.to);
  };

  const applyDellinDirection = (
    direction: RecentDirection<DellinCityDto>
  ) => {
    selectDellinFromCity(direction.from);
    selectDellinToCity(direction.to);
  };

  const toggleRecentPinned = (carrier: DeliveryTab, key: string) => {
    updateRecentDirections(
      toggleDirectionPinned(recentDirections, carrier, key)
    );
  };

  const rememberCdekDirection = () => {
    if (!fromCity || !toCity) return;
    updateRecentDirections(
      rememberDirection(recentDirections, "cdek", fromCity, toCity)
    );
  };

  const rememberDellinDirection = () => {
    if (!dellinFromCity || !dellinToCity) return;
    updateRecentDirections(
      rememberDirection(
        recentDirections,
        "dellin",
        dellinFromCity,
        dellinToCity
      )
    );
  };

  const packRequestId = useRef(0);

  // Автокомплит товара
  const activeSuggestions =
    selected || debouncedSearch.trim().length < 2 ? [] : suggestions;

  useEffect(() => {
    if (selected || debouncedSearch.trim().length < 2) {
      return;
    }
    let cancelled = false;
    apiGet<{ products: ProductSuggestion[] }>(
      `/api/products/search?q=${encodeURIComponent(debouncedSearch)}`
    )
      .then((data) => {
        if (!cancelled) {
          setSuggestions(data.products);
          setSuggestOpen(true);
          setSearchError(null);
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setSearchError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedSearch, selected]);

  // Пересчёт упаковки при изменении позиций
  const recalcPacking = useCallback(async (current: Position[]) => {
    const requestId = ++packRequestId.current;
    if (current.length === 0) {
      setPacking(null);
      setPackError(null);
      return;
    }
    setPackLoading(true);
    try {
      const res = await fetch("/api/pack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: current.map(({ article, qty }) => ({ article, qty })),
        }),
      });
      const data = await parseJson<{ packing?: PackingDto }>(res);
      if (packRequestId.current !== requestId) return;
      if (!res.ok || !data.packing) {
        setPackError(data.message ?? "Не удалось рассчитать упаковку.");
        setPacking(null);
      } else {
        setPacking(data.packing);
        setPackError(null);
      }
    } catch (e) {
      if (packRequestId.current === requestId) {
        setPackError(
          e instanceof Error
            ? e.message
            : "Не удалось рассчитать упаковку. Проверьте соединение."
        );
      }
    } finally {
      if (packRequestId.current === requestId) setPackLoading(false);
    }
  }, []);

  const changePositions = (next: Position[]) => {
    setPositions(next);
    setQuote(null);
    setQuoteError(null);
    setDellinQuote(null);
    setDellinQuoteError(null);
    void recalcPacking(next);
  };

  const resolveSharedPositions = useCallback(
    async (items: PositionInput[]): Promise<Position[]> =>
      Promise.all(
        items.map(async (item) => {
          try {
            const data = await apiGet<{ products: ProductSuggestion[] }>(
              `/api/products/search?q=${encodeURIComponent(item.article)}`
            );
            const product = data.products.find(
              (candidate) => candidate.article === item.article
            );
            return {
              article: item.article,
              qty: item.qty,
              name: product?.name ?? item.article,
            };
          } catch {
            return { article: item.article, qty: item.qty, name: item.article };
          }
        })
      ),
    []
  );

  const addPosition = () => {
    if (!selected) return;
    const quantity = Number(qty);
    if (!Number.isInteger(quantity) || quantity <= 0) return;
    const existing = positions.find((p) => p.article === selected.article);
    const next = existing
      ? positions.map((p) =>
          p.article === selected.article ? { ...p, qty: p.qty + quantity } : p
        )
      : [
          ...positions,
          { article: selected.article, name: selected.name, qty: quantity },
        ];
    changePositions(next);
    setSelected(null);
    setSearchQ("");
    setQty("1");
  };

  const removePosition = (article: string) => {
    changePositions(positions.filter((p) => p.article !== article));
  };

  const updateQty = (article: string, value: string) => {
    const quantity = Number(value);
    if (!Number.isInteger(quantity) || quantity <= 0) return;
    changePositions(
      positions.map((p) => (p.article === article ? { ...p, qty: quantity } : p))
    );
  };

  // ---- Ручные места ----

  const manualFormValid =
    Number(manualForm.lengthCm) > 0 &&
    Number(manualForm.widthCm) > 0 &&
    Number(manualForm.heightCm) > 0 &&
    Number(manualForm.weightKg) > 0 &&
    Number.isInteger(Number(manualForm.count)) &&
    Number(manualForm.count) >= 1;

  const addManualPlace = () => {
    if (!manualFormValid) return;
    setManualPlaces((prev) => [
      ...prev,
      {
        id: ++manualIdRef.current,
        lengthCm: Number(manualForm.lengthCm),
        widthCm: Number(manualForm.widthCm),
        heightCm: Number(manualForm.heightCm),
        weightKg: Number(manualForm.weightKg),
        count: Number(manualForm.count),
      },
    ]);
    setManualForm({ lengthCm: "", widthCm: "", heightCm: "", weightKg: "", count: "1" });
    setQuote(null);
    setQuoteError(null);
    setDellinQuote(null);
    setDellinQuoteError(null);
  };

  const removeManualPlace = (id: number) => {
    setManualPlaces((prev) => prev.filter((m) => m.id !== id));
    setQuote(null);
    setQuoteError(null);
    setDellinQuote(null);
    setDellinQuoteError(null);
  };

  /** Ручные места в формате мест упаковки — для таблицы, итогов и проверок ПВЗ */
  const manualDtos: PlaceDto[] = manualPlaces.map((m) => ({
    article: "—",
    label: "Ручное место",
    unitsPerPlace: 1,
    count: m.count,
    lengthCm: m.lengthCm,
    widthCm: m.widthCm,
    heightCm: m.heightCm,
    weightKg: m.weightKg,
    volumeM3: (m.lengthCm * m.widthCm * m.heightCm) / 1_000_000,
  }));

  /** Все места: рассчитанные по номенклатуре + ручные */
  const allPlaces: PlaceDto[] = [...(packing?.places ?? []), ...manualDtos];
  const totalPlacesAll = allPlaces.reduce((s, p) => s + p.count, 0);
  const totalWeightAll =
    Math.round(allPlaces.reduce((s, p) => s + p.weightKg * p.count, 0) * 1000) /
    1000;
  const totalVolumeAll = allPlaces.reduce((s, p) => s + p.volumeM3 * p.count, 0);
  const catalogOk = positions.length === 0 || packing?.canShip === true;
  const canShipAll = totalPlacesAll > 0 && catalogOk;

  useEffect(() => {
    if (typeof window === "undefined") return;

    if (shareRestore.invalid) {
      const url = new URL(window.location.href);
      url.searchParams.delete("c");
      window.history.replaceState(
        null,
        "",
        `${url.pathname}${url.search}${url.hash}`
      );
      return;
    }

    if (restoreHandled.current || !shareRestore.payload) return;
    restoreHandled.current = true;

    let cancelled = false;
    resolveSharedPositions(shareRestore.payload.positions).then((restoredPositions) => {
      if (cancelled) return;
      setPositions(restoredPositions);
      setQuote(null);
      setQuoteError(null);
      setDellinQuote(null);
      setDellinQuoteError(null);
      void recalcPacking(restoredPositions);
    });

    return () => {
      cancelled = true;
    };
  }, [
    recalcPacking,
    resolveSharedPositions,
    shareRestore.invalid,
    shareRestore.payload,
  ]);

  const buildSharePayload = (): ShareLinkPayload => ({
    v: 1,
    tab: activeDeliveryTab,
    cdek: {
      cities: {
        from: fromCity,
        to: toCity,
      },
      mode,
      address: {
        fromStreet,
        fromHouse,
        fromFlat,
        toStreet,
        toHouse,
        toFlat,
      },
      pvz: {
        from: fromPvz,
        to: toPvz,
      },
    },
    dellin: {
      cities: {
        from: dellinFromCity,
        to: dellinToCity,
      },
      street: {
        from: dellinFromStreet,
        to: dellinToStreet,
      },
      terminal: {
        from: dellinFromTerminal,
        to: dellinToTerminal,
      },
      house: {
        from: dellinFromHouse,
        to: dellinToHouse,
      },
      flat: {
        from: dellinFromFlat,
        to: dellinToFlat,
      },
      mode: dellinMode,
    },
    positions: positions.map(({ article, qty }) => ({ article, qty })),
    manualPlaces: manualPlaces.map(({ id, ...place }) => {
      void id;
      return place;
    }),
    clientPays,
  });

  const openHistoryEntry = (entry: CalculationHistoryEntry) => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("c", encodeSharePayload(entry.payload));
    window.location.assign(url.toString());
  };

  const activeDirectionFilled =
    activeDeliveryTab === "cdek"
      ? fromCity !== null && toCity !== null
      : dellinFromCity !== null && dellinToCity !== null;

  const copyShareLink = async () => {
    if (!activeDirectionFilled || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("c", encodeSharePayload(buildSharePayload()));
    const link = url.toString();
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(link);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = link;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopyLinkStatus("Ссылка скопирована");
    } catch {
      setCopyLinkStatus("Не удалось скопировать ссылку");
    }
  };

  // Расчёт СДЭК
  const calcDelivery = async () => {
    if (!fromCity || !toCity || totalPlacesAll === 0) return;
    setQuoteLoading(true);
    setQuoteError(null);
    setQuote(null);
    try {
      const res = await fetch("/api/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: positions.map(({ article, qty }) => ({ article, qty })),
          manualPlaces: manualPlaces.map(({ id, ...place }) => {
            void id;
            return place;
          }),
          fromCode: fromCity.code,
          toCode: toCity.code,
          mode,
          fromAddress: mode.startsWith("door")
            ? composeAddress(fromStreet, fromHouse, fromFlat)
            : "",
          toAddress: mode.endsWith("door")
            ? composeAddress(toStreet, toHouse, toFlat)
            : "",
          fromPvzCode:
            mode.startsWith("warehouse") && fromPvz ? fromPvz.code : "",
          toPvzCode: mode.endsWith("warehouse") && toPvz ? toPvz.code : "",
        }),
      });
      const data = await parseJson<QuoteResponse>(res);
      if (data.packing && positions.length > 0) setPacking(data.packing);
      if (!res.ok || !data.ok) {
        setQuoteError(data.message ?? "СДЭК не смог рассчитать доставку.");
        if (data.tariffs) setQuote(data);
      } else {
        setQuote(data);
        rememberCdekDirection();
        const tariff = data.tariffs?.[0];
        if (tariff) {
          rememberCalculation({
            carrier: "cdek",
            from: fromCity.name,
            to: toCity.name,
            mode,
            totalPlaces: totalPlacesAll,
            totalWeightKg: totalWeightAll,
            totalVolumeM3: totalVolumeAll,
            tariffName: tariff.name,
            totalPrice:
              tariff.deliverySum *
              (1 + VAT_RATE) *
              (clientPays ? 1 + CLIENT_PAYS_MARKUP : 1),
            periodMin: tariff.periodMin,
            periodMax: tariff.periodMax,
            payload: buildSharePayload(),
          });
        }
      }
    } catch (e) {
      setQuoteError(
        e instanceof Error
          ? e.message
          : "Не удалось выполнить расчёт. Проверьте соединение."
      );
    } finally {
      setQuoteLoading(false);
    }
  };

  const calcDellinDelivery = async () => {
    if (!dellinFromCity || !dellinToCity || totalPlacesAll === 0) return;
    setDellinQuoteLoading(true);
    setDellinQuoteError(null);
    setDellinQuote(null);
    try {
      const res = await fetch("/api/dellin/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: positions.map(({ article, qty }) => ({ article, qty })),
          manualPlaces: manualPlaces.map(({ id, ...place }) => {
            void id;
            return place;
          }),
          fromCityCode: dellinFromCity.code,
          toCityCode: dellinToCity.code,
          fromCityName: [dellinFromCity.name, dellinFromCity.regionName]
            .filter(Boolean)
            .join(", "),
          toCityName: [dellinToCity.name, dellinToCity.regionName]
            .filter(Boolean)
            .join(", "),
          mode: dellinMode,
          fromStreetCode:
            dellinMode.startsWith("door") && dellinFromStreet
              ? dellinFromStreet.code
              : "",
          fromHouse: dellinMode.startsWith("door") ? dellinFromHouse : "",
          fromFlat: dellinMode.startsWith("door") ? dellinFromFlat : "",
          toStreetCode:
            dellinMode.endsWith("door") && dellinToStreet
              ? dellinToStreet.code
              : "",
          toHouse: dellinMode.endsWith("door") ? dellinToHouse : "",
          toFlat: dellinMode.endsWith("door") ? dellinToFlat : "",
          fromAddress:
            dellinMode.startsWith("door") && dellinFromStreet
              ? `${dellinFromStreet.fullName}, ${dellinFromHouse}`
              : "",
          toAddress:
            dellinMode.endsWith("door") && dellinToStreet
              ? `${dellinToStreet.fullName}, ${dellinToHouse}`
              : "",
          fromTerminalId:
            dellinMode.startsWith("warehouse") && dellinFromTerminal
              ? dellinFromTerminal.id
              : undefined,
          toTerminalId:
            dellinMode.endsWith("warehouse") && dellinToTerminal
              ? dellinToTerminal.id
              : undefined,
        }),
      });
      const data = await parseJson<DellinQuoteResponse>(res);
      if (data.packing && positions.length > 0) setPacking(data.packing);
      if (!res.ok || !data.ok) {
        setDellinQuoteError(
          data.message ??
            "Деловые Линии не смогли рассчитать доставку."
        );
        if (data.tariffs) setDellinQuote(data);
      } else {
        setDellinQuote(data);
        rememberDellinDirection();
        const tariff = data.tariffs?.[0];
        if (tariff) {
          rememberCalculation({
            carrier: "dellin",
            from: [dellinFromCity.name, dellinFromCity.regionName]
              .filter(Boolean)
              .join(", "),
            to: [dellinToCity.name, dellinToCity.regionName]
              .filter(Boolean)
              .join(", "),
            mode: dellinMode,
            totalPlaces: totalPlacesAll,
            totalWeightKg: totalWeightAll,
            totalVolumeM3: totalVolumeAll,
            tariffName: tariff.name,
            totalPrice:
              tariff.deliverySum *
              (clientPays ? 1 + CLIENT_PAYS_MARKUP : 1),
            periodMin: tariff.periodMin,
            periodMax: tariff.periodMax,
            payload: buildSharePayload(),
          });
        }
      }
    } catch (e) {
      setDellinQuoteError(
        e instanceof Error
          ? e.message
          : "Не удалось выполнить расчет Деловых Линий. Проверьте соединение."
      );
    } finally {
      setDellinQuoteLoading(false);
    }
  };

  const canCalc =
    canShipAll &&
    fromCity !== null &&
    toCity !== null &&
    !packLoading &&
    !quoteLoading;

  const canDellinCalc =
    canShipAll &&
    dellinFromCity !== null &&
    dellinToCity !== null &&
    (!dellinMode.startsWith("door") ||
      (dellinFromStreet !== null && dellinFromHouse.trim() !== "")) &&
    (!dellinMode.endsWith("door") ||
      (dellinToStreet !== null && dellinToHouse.trim() !== "")) &&
    (!dellinMode.startsWith("warehouse") || dellinFromTerminal !== null) &&
    (!dellinMode.endsWith("warehouse") || dellinToTerminal !== null) &&
    !packLoading &&
    !dellinQuoteLoading;

  const bestCdekTariff = quote?.tariffs?.[0];
  const bestDellinTariff = dellinQuote?.tariffs?.[0];

  return (
    <>
      {/* Поиск и добавление позиции */}
      <div className="card">
        <h2>Добавить товар</h2>
        <div className="add-row">
          <div className="field grow">
            <label>Артикул или наименование</label>
            {selected ? (
              <div className="selected-chip">
                <span>
                  <strong>{selected.article}</strong>
                  {selected.name ? ` — ${selected.name}` : ""}
                </span>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    setSelected(null);
                    setSearchQ("");
                  }}
                >
                  изменить
                </button>
              </div>
            ) : (
              <div className="suggest-wrap">
                <input
                  type="text"
                  value={searchQ}
                  placeholder="Например: DON. или часть названия…"
                  onChange={(e) => setSearchQ(e.target.value)}
                  onFocus={() =>
                    activeSuggestions.length > 0 && setSuggestOpen(true)
                  }
                />
                {suggestOpen && activeSuggestions.length > 0 && (
                  <ul className="suggest-list">
                    {activeSuggestions.map((p) => (
                      <li key={p.article}>
                        <button
                          type="button"
                          onClick={() => {
                            setSelected(p);
                            setSuggestOpen(false);
                          }}
                        >
                          <strong>{p.article}</strong>
                          {p.name ? ` — ${p.name}` : ""}
                          <span className="suggest-meta">
                            {p.ruleQtys.length > 0
                              ? ` упаковки: ${p.ruleQtys.join(", ")} шт`
                              : p.unitDataComplete
                                ? " только поштучно"
                                : " ⚠ нет данных"}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
          <div className="field qty-field">
            <label>Кол-во</label>
            <input
              type="number"
              min={1}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="button"
            disabled={!selected || !(Number(qty) > 0)}
            onClick={addPosition}
          >
            Добавить
          </button>
        </div>
        {searchError && <p className="field-error">{searchError}</p>}
      </div>

      {/* Позиции */}
      {positions.length > 0 && (
        <div className="card">
          <h2>Позиции</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Артикул</th>
                  <th>Наименование</th>
                  <th>Количество</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.article}>
                    <td>
                      <strong>{p.article}</strong>
                    </td>
                    <td>{p.name}</td>
                    <td>
                      <input
                        type="number"
                        min={1}
                        className="qty-input"
                        value={p.qty}
                        onChange={(e) => updateQty(p.article, e.target.value)}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => removePosition(p.article)}
                      >
                        удалить
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Ручное место */}
      <div className="card">
        <h2>Ручное место (без номенклатуры)</h2>
        <div className="add-row">
          <div className="field dim-field">
            <label>Длина, см</label>
            <input
              type="number"
              min={1}
              value={manualForm.lengthCm}
              onChange={(e) =>
                setManualForm({ ...manualForm, lengthCm: e.target.value })
              }
            />
          </div>
          <div className="field dim-field">
            <label>Ширина, см</label>
            <input
              type="number"
              min={1}
              value={manualForm.widthCm}
              onChange={(e) =>
                setManualForm({ ...manualForm, widthCm: e.target.value })
              }
            />
          </div>
          <div className="field dim-field">
            <label>Высота, см</label>
            <input
              type="number"
              min={1}
              value={manualForm.heightCm}
              onChange={(e) =>
                setManualForm({ ...manualForm, heightCm: e.target.value })
              }
            />
          </div>
          <div className="field dim-field">
            <label>Вес, кг</label>
            <input
              type="number"
              min={0.001}
              step={0.1}
              value={manualForm.weightKg}
              onChange={(e) =>
                setManualForm({ ...manualForm, weightKg: e.target.value })
              }
            />
          </div>
          <div className="field qty-field">
            <label>Мест</label>
            <input
              type="number"
              min={1}
              value={manualForm.count}
              onChange={(e) =>
                setManualForm({ ...manualForm, count: e.target.value })
              }
            />
          </div>
          <button
            type="button"
            className="button"
            disabled={!manualFormValid}
            onClick={addManualPlace}
          >
            Добавить место
          </button>
        </div>
        <p className="meta-line">
          Для грузов, которых нет в справочнике: укажите габариты, вес и число
          одинаковых мест — они попадут в расчёт вместе с местами из
          номенклатуры.
        </p>
      </div>

      {/* Упаковочные места */}
      {(positions.length > 0 || manualPlaces.length > 0) && (
        <div className="card">
          <h2>Упаковочные места {packLoading && <small>расчёт…</small>}</h2>
          {packError && <div className="error-message">{packError}</div>}
          {packing && packing.errors.length > 0 && (
            <div className="error-message">
              {packing.errors.map((e, i) => (
                <p key={i} style={{ margin: "2px 0" }}>
                  {e}
                </p>
              ))}
            </div>
          )}
          {packing && packing.warnings.length > 0 && (
            <ul className="warning-list">
              {packing.warnings.map((w, i) => (
                <li key={i}>⚠️ {w}</li>
              ))}
            </ul>
          )}
          {allPlaces.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Артикул</th>
                    <th>Тип места</th>
                    <th>Мест</th>
                    <th>ДШВ, см</th>
                    <th>Вес места, кг</th>
                    <th>Объём места, м³</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {(packing?.places ?? []).map((place, i) => (
                    <tr key={`c-${i}`}>
                      <td>{place.article}</td>
                      <td>{place.label}</td>
                      <td>{place.count}</td>
                      <td>
                        {place.lengthCm} × {place.widthCm} × {place.heightCm}
                      </td>
                      <td>{place.weightKg}</td>
                      <td>{place.volumeM3.toFixed(4)}</td>
                      <td></td>
                    </tr>
                  ))}
                  {manualPlaces.map((m) => (
                    <tr key={`m-${m.id}`}>
                      <td>—</td>
                      <td>Ручное место</td>
                      <td>{m.count}</td>
                      <td>
                        {m.lengthCm} × {m.widthCm} × {m.heightCm}
                      </td>
                      <td>{m.weightKg}</td>
                      <td>
                        {((m.lengthCm * m.widthCm * m.heightCm) / 1_000_000).toFixed(4)}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => removeManualPlace(m.id)}
                        >
                          удалить
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="totals">
            <span>
              Всего мест: <strong>{totalPlacesAll}</strong>
            </span>
            <span>
              Общий вес: <strong>{totalWeightAll} кг</strong>
            </span>
            <span>
              Общий объём: <strong>{totalVolumeAll.toFixed(4)} м³</strong>
            </span>
            <span className={`status ${canShipAll ? "ok" : "error"}`}>
              {canShipAll
                ? "Можно отправлять в СДЭК"
                : "Отправка в СДЭК невозможна"}
            </span>
          </div>
        </div>
      )}

      {/* Доставка */}
      <div className="delivery-tabs-row">
        <div
          className="delivery-tabs"
          role="tablist"
          aria-label="Транспортная компания"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeDeliveryTab === "cdek"}
            className={activeDeliveryTab === "cdek" ? "active" : ""}
            onClick={() => setActiveDeliveryTab("cdek")}
          >
            СДЭК
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeDeliveryTab === "dellin"}
            className={activeDeliveryTab === "dellin" ? "active" : ""}
            onClick={() => setActiveDeliveryTab("dellin")}
          >
            Деловые Линии
          </button>
        </div>
        <CarrierHealthBadges />
      </div>

      <CalculationHistoryPanel
        entries={calculationHistory}
        onOpen={openHistoryEntry}
        onRemove={removeHistoryEntry}
        onClear={clearHistory}
      />

      {bestCdekTariff && bestDellinTariff ? (
        <div className="card">
          <h2>Сравнение</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ТК</th>
                  <th>Лучший тариф</th>
                  <th>Стоимость, ₽</th>
                  <th>Итого к оплате, ₽</th>
                  <th>Срок, дн.</th>
                </tr>
              </thead>
              <tbody>
                {[
                  {
                    carrier: "СДЭК",
                    name: bestCdekTariff.name,
                    sum: bestCdekTariff.deliverySum,
                    includesVat: false,
                    min: bestCdekTariff.periodMin,
                    max: bestCdekTariff.periodMax,
                  },
                  {
                    carrier: "Деловые Линии",
                    name: bestDellinTariff.name,
                    sum: bestDellinTariff.deliverySum,
                    includesVat: true,
                    min: bestDellinTariff.periodMin,
                    max: bestDellinTariff.periodMax,
                  },
                ].map((item) => {
                  const sumWithVat = item.includesVat
                    ? item.sum
                    : item.sum + item.sum * VAT_RATE;
                  const total =
                    sumWithVat * (clientPays ? 1 + CLIENT_PAYS_MARKUP : 1);
                  return (
                    <tr key={item.carrier}>
                      <td>{item.carrier}</td>
                      <td>{item.name}</td>
                      <td>{rub(item.sum)}</td>
                      <td>
                        <strong>{rub(total)}</strong>
                      </td>
                      <td>
                        {item.min === item.max
                          ? item.min || "—"
                          : `${item.min}–${item.max}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="meta-line">
            Для СДЭК итог считается как стоимость + НДС {Math.round(VAT_RATE * 100)}%.
            Цена Деловых Линий уже включает НДС.
          </p>
        </div>
      ) : null}

      {activeDeliveryTab === "cdek" && (
        <>
      <div className="card">
        <h2>Доставка СДЭК</h2>
        <div className="delivery-row">
          <CityField label="Откуда (город)" value={fromCity} onSelect={setFromCity} />
          <CityField label="Куда (город)" value={toCity} onSelect={setToCity} />
          <div className="field">
            <label>Режим доставки</label>
            <select
              value={mode}
              onChange={(e) => {
                setMode(e.target.value as DeliveryMode);
                setQuote(null);
                setQuoteError(null);
              }}
            >
              {(
                Object.entries(DELIVERY_MODE_LABELS) as [DeliveryMode, string][]
              ).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Платит клиент</label>
            <label className="switch">
              <input
                type="checkbox"
                checked={clientPays}
                onChange={(e) => setClientPays(e.target.checked)}
              />
              <span className="switch-slider" />
              <span className="switch-text">{clientPays ? "Да" : "Нет"}</span>
            </label>
          </div>
        </div>
        <DirectionRecents
          carrier="cdek"
          items={recentDirections.cdek}
          onApply={applyCdekDirection}
          onTogglePinned={(key) => toggleRecentPinned("cdek", key)}
          formatCity={(city) => city.name}
        />
        <div className="delivery-row">
          {mode.startsWith("door") ? (
            <>
              <StreetField
                label="Улица забора"
                cityName={fromCity?.name ?? null}
                value={fromStreet}
                onChange={setFromStreet}
                placeholder="ул. Ленина"
              />
              <div className="field dim-field">
                <label>Дом</label>
                <input
                  type="text"
                  value={fromHouse}
                  placeholder="10"
                  onChange={(e) => setFromHouse(e.target.value)}
                />
              </div>
              <div className="field dim-field">
                <label>Квартира</label>
                <input
                  type="text"
                  value={fromFlat}
                  placeholder="12"
                  onChange={(e) => setFromFlat(e.target.value)}
                />
              </div>
            </>
          ) : fromCity ? (
            <PvzField
              label="ПВЗ отправления (улица или адрес)"
              cityCode={fromCity.code}
              cityName={fromCity.name}
              side="from"
              value={fromPvz}
              onSelect={setFromPvz}
              problem={fromPvz ? pvzFitProblem(fromPvz, allPlaces) : null}
              checked={allPlaces.length > 0}
            />
          ) : (
            <div className="field grow">
              <label>ПВЗ отправления</label>
              <p className="meta-line" style={{ margin: "8px 0 0" }}>
                Сначала выберите город отправления.
              </p>
            </div>
          )}
          {mode.endsWith("door") ? (
            <>
              <StreetField
                label="Улица доставки"
                cityName={toCity?.name ?? null}
                value={toStreet}
                onChange={setToStreet}
                placeholder="пр. Мира"
              />
              <div className="field dim-field">
                <label>Дом</label>
                <input
                  type="text"
                  value={toHouse}
                  placeholder="25"
                  onChange={(e) => setToHouse(e.target.value)}
                />
              </div>
              <div className="field dim-field">
                <label>Квартира</label>
                <input
                  type="text"
                  value={toFlat}
                  placeholder="4"
                  onChange={(e) => setToFlat(e.target.value)}
                />
              </div>
            </>
          ) : toCity ? (
            <PvzField
              label="ПВЗ получения (улица или адрес)"
              cityCode={toCity.code}
              cityName={toCity.name}
              side="to"
              value={toPvz}
              onSelect={setToPvz}
              problem={toPvz ? pvzFitProblem(toPvz, allPlaces) : null}
              checked={allPlaces.length > 0}
            />
          ) : (
            <div className="field grow">
              <label>ПВЗ получения</label>
              <p className="meta-line" style={{ margin: "8px 0 0" }}>
                Сначала выберите город назначения.
              </p>
            </div>
          )}
        </div>
        <p className="meta-line" style={{ marginTop: 0 }}>
          Стоимость СДЭК считается по городам (тарифным зонам) — выбор
          конкретного ПВЗ на цену не влияет, но позволяет проверить его
          ограничения по весу и габаритам.
        </p>
        <div className="add-row">
          <button
            type="button"
            className="button"
            disabled={!canCalc}
            onClick={calcDelivery}
          >
            {quoteLoading ? "Расчёт…" : "Рассчитать доставку СДЭК"}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={!activeDirectionFilled}
            onClick={copyShareLink}
          >
            Скопировать ссылку
          </button>
        </div>
        {copyLinkStatus && activeDeliveryTab === "cdek" && (
          <p className="meta-line">{copyLinkStatus}</p>
        )}
        {totalPlacesAll === 0 && (
          <p className="meta-line">
            Сначала добавьте товарные позиции или ручное место.
          </p>
        )}
        {positions.length > 0 && packing && !packing.canShip && (
          <p className="meta-line">
            Расчёт недоступен: исправьте ошибки упаковки выше.
          </p>
        )}
      </div>

      {/* Результат СДЭК */}
      {(quote || quoteError) && (
        <div className="card">
          <h2>Результат СДЭК</h2>
          {quoteError && <div className="error-message">{quoteError}</div>}
          {quote?.warnings && quote.warnings.length > 0 && (
            <ul className="warning-list">
              {quote.warnings.map((w, i) => (
                <li key={i}>⚠️ {w}</li>
              ))}
            </ul>
          )}
          {quote?.tariffs && quote.tariffs.length > 0 && (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Тариф</th>
                      <th>Стоимость, ₽</th>
                      <th>НДС ({Math.round(VAT_RATE * 100)}%), ₽</th>
                      <th>Итого к оплате, ₽</th>
                      <th>Срок, дн.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {quote.tariffs.map((t: TariffDto) => {
                      const vat = t.deliverySum * VAT_RATE;
                      const total =
                        (t.deliverySum + vat) *
                        (clientPays ? 1 + CLIENT_PAYS_MARKUP : 1);
                      return (
                        <tr key={t.code}>
                          <td className="cell-wrap">
                            <strong>{t.name}</strong>
                            {t.description && (
                              <div className="meta-line">{t.description}</div>
                            )}
                          </td>
                          <td>{rub(t.deliverySum)}</td>
                          <td>{rub(vat)}</td>
                          <td>
                            <strong>{rub(total)}</strong>
                          </td>
                          <td>
                            {t.periodMin === t.periodMax
                              ? t.periodMin
                              : `${t.periodMin}–${t.periodMax}`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="meta-line">
                Итого = стоимость СДЭК + НДС {Math.round(VAT_RATE * 100)}%
                {clientPays
                  ? `, плюс ${Math.round(CLIENT_PAYS_MARKUP * 100)}% (платит клиент)`
                  : ""}
                .
              </p>
            </>
          )}
        </div>
      )}
        </>
      )}

      {activeDeliveryTab === "dellin" && (
        <>
          <div className="card">
            <h2>Доставка Деловыми Линиями</h2>
            <div className="delivery-row">
              <DellinCityField
                label="Откуда (город)"
                value={dellinFromCity}
                onSelect={selectDellinFromCity}
              />
              <DellinCityField
                label="Куда (город)"
                value={dellinToCity}
                onSelect={selectDellinToCity}
              />
              <div className="field">
                <label>Режим доставки</label>
                <select
                  value={dellinMode}
                  onChange={(e) => {
                    setDellinMode(e.target.value as DeliveryMode);
                    setDellinQuote(null);
                    setDellinQuoteError(null);
                  }}
                >
                  {(
                    Object.entries(DELIVERY_MODE_LABELS) as [
                      DeliveryMode,
                      string,
                    ][]
                  ).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Платит клиент</label>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={clientPays}
                    onChange={(e) => setClientPays(e.target.checked)}
                  />
                  <span className="switch-slider" />
                  <span className="switch-text">{clientPays ? "Да" : "Нет"}</span>
                </label>
              </div>
            </div>
            <DirectionRecents
              carrier="dellin"
              items={recentDirections.dellin}
              onApply={applyDellinDirection}
              onTogglePinned={(key) => toggleRecentPinned("dellin", key)}
              formatCity={(city) =>
                [city.name, city.regionName].filter(Boolean).join(", ")
              }
            />
            <div className="delivery-row">
              {dellinMode.startsWith("door") ? (
                <>
                  <DellinStreetField
                    key={`from-${dellinFromCity?.cityId ?? "none"}`}
                    label="Улица забора"
                    city={dellinFromCity}
                    value={dellinFromStreet}
                    onSelect={setDellinFromStreet}
                  />
                  <div className="field dim-field">
                    <label>Дом</label>
                    <input
                      type="text"
                      value={dellinFromHouse}
                      maxLength={7}
                      placeholder="25"
                      onChange={(e) => setDellinFromHouse(e.target.value)}
                    />
                  </div>
                  <div className="field dim-field">
                    <label>Квартира</label>
                    <input
                      type="text"
                      value={dellinFromFlat}
                      placeholder="12"
                      onChange={(e) => setDellinFromFlat(e.target.value)}
                    />
                  </div>
                </>
              ) : (
                <DellinTerminalField
                  label="Терминал отправления"
                  city={dellinFromCity}
                  direction="derival"
                  value={dellinFromTerminal}
                  onSelect={setDellinFromTerminal}
                  items={positions}
                  manualPlaces={manualPlaces}
                  enabled={totalPlacesAll > 0}
                  restoredTerminalId={
                    shareRestore.payload?.dellin.terminal.from?.id ?? null
                  }
                />
              )}
              {dellinMode.endsWith("door") ? (
                <>
                  <DellinStreetField
                    key={`to-${dellinToCity?.cityId ?? "none"}`}
                    label="Улица доставки"
                    city={dellinToCity}
                    value={dellinToStreet}
                    onSelect={setDellinToStreet}
                  />
                  <div className="field dim-field">
                    <label>Дом</label>
                    <input
                      type="text"
                      value={dellinToHouse}
                      maxLength={7}
                      placeholder="25"
                      onChange={(e) => setDellinToHouse(e.target.value)}
                    />
                  </div>
                  <div className="field dim-field">
                    <label>Квартира</label>
                    <input
                      type="text"
                      value={dellinToFlat}
                      placeholder="12"
                      onChange={(e) => setDellinToFlat(e.target.value)}
                    />
                  </div>
                </>
              ) : (
                <DellinTerminalField
                  label="Терминал получения"
                  city={dellinToCity}
                  direction="arrival"
                  value={dellinToTerminal}
                  onSelect={setDellinToTerminal}
                  items={positions}
                  manualPlaces={manualPlaces}
                  enabled={totalPlacesAll > 0}
                  restoredTerminalId={
                    shareRestore.payload?.dellin.terminal.to?.id ?? null
                  }
                />
              )}
            </div>
            <p className="meta-line" style={{ marginTop: 0 }}>
              Деловые Линии используют свой справочник городов и КЛАДР. Расчет
              выполняется по тем же упаковочным местам, что и СДЭК. Страхование
              груза и срока ДЛ считают автоматически — оно видно в расшифровке
              тарифа. Допуслуги при оформлении (подъём на этаж и т.п.) в расчёт
              не входят.
            </p>
            <div className="add-row">
              <button
                type="button"
                className="button"
                disabled={!canDellinCalc}
                onClick={calcDellinDelivery}
              >
                {dellinQuoteLoading
                  ? "Расчёт..."
                  : "Рассчитать доставку Деловыми Линиями"}
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={!activeDirectionFilled}
                onClick={copyShareLink}
              >
                Скопировать ссылку
              </button>
            </div>
            {copyLinkStatus && activeDeliveryTab === "dellin" && (
              <p className="meta-line">{copyLinkStatus}</p>
            )}
            {totalPlacesAll === 0 && (
              <p className="meta-line">
                Сначала добавьте товарные позиции или ручное место.
              </p>
            )}
            {positions.length > 0 && packing && !packing.canShip && (
              <p className="meta-line">
                Расчет недоступен: исправьте ошибки упаковки выше.
              </p>
            )}
          </div>

          {(dellinQuote || dellinQuoteError) && (
            <div className="card">
              <h2>Результат Деловых Линий</h2>
              {dellinQuoteError && (
                <div className="error-message">{dellinQuoteError}</div>
              )}
              {(dellinQuote?.terminals?.derival ||
                dellinQuote?.terminals?.arrival) && (
                <div className="terminal-summary">
                  {dellinQuote.terminals.derival && (
                    <div className="terminal-line">
                      <strong>Терминал отправления:</strong>{" "}
                      {dellinQuote.terminals.derival.name}
                      {dellinQuote.terminals.derival.address
                        ? ` — ${dellinQuote.terminals.derival.address}`
                        : ""}
                    </div>
                  )}
                  {dellinQuote.terminals.arrival && (
                    <div className="terminal-line">
                      <strong>Терминал получения:</strong>{" "}
                      {dellinQuote.terminals.arrival.name}
                      {dellinQuote.terminals.arrival.address
                        ? ` — ${dellinQuote.terminals.arrival.address}`
                        : ""}
                    </div>
                  )}
                </div>
              )}
              {dellinQuote?.warnings && dellinQuote.warnings.length > 0 && (
                <ul className="warning-list">
                  {dellinQuote.warnings.map((w, i) => (
                    <li key={i}>⚠️ {w}</li>
                  ))}
                </ul>
              )}
              {dellinQuote?.tariffs && dellinQuote.tariffs.length > 0 && (
                <>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Тариф</th>
                          <th>Стоимость с НДС, ₽</th>
                          <th>Итого к оплате, ₽</th>
                          <th>Срок, дн.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dellinQuote.tariffs.map((t: DellinTariffDto) => {
                          const total =
                            t.deliverySum *
                            (clientPays ? 1 + CLIENT_PAYS_MARKUP : 1);
                          return (
                            <tr key={t.type}>
                              <td className="cell-wrap">
                                <strong>{t.name}</strong>
                                {t.description && (
                                  <div className="meta-line">{t.description}</div>
                                )}
                              </td>
                              <td>{rub(t.deliverySum)}</td>
                              <td>
                                <strong>{rub(total)}</strong>
                              </td>
                              <td>
                                {t.periodMin === t.periodMax
                                  ? t.periodMin || "—"
                                  : `${t.periodMin}–${t.periodMax}`}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <p className="meta-line">
                    Цена Деловых Линий уже включает НДС
                    {clientPays
                      ? `, плюс ${Math.round(CLIENT_PAYS_MARKUP * 100)}% (платит клиент)`
                      : ""}
                    .
                  </p>
                </>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}
