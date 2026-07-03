"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CityDto,
  DeliveryMode,
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

/**
 * Клиент калькулятора. Работает только с собственным API приложения;
 * все данные о габаритах/весе сервер берёт из таблицы сам.
 */

interface Position extends PositionInput {
  name: string;
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

async function apiGet<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const data = (await res.json()) as T & { message?: string };
  if (!res.ok) throw new Error(data.message ?? `Ошибка запроса (${res.status})`);
  return data;
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

  useEffect(() => {
    if (value || debouncedQuery.trim().length < 2) {
      setOptions([]);
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
            onFocus={() => options.length > 0 && setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 200)}
          />
          {open && options.length > 0 && (
            <ul className="suggest-list">
              {options.map((city) => (
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

// ---------- Основной компонент ----------

export default function Calculator() {
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
    (ManualPlaceInput & { id: number })[]
  >([]);
  const [manualForm, setManualForm] = useState({
    lengthCm: "",
    widthCm: "",
    heightCm: "",
    weightKg: "",
    count: "1",
  });
  const manualIdRef = useRef(0);

  // Доставка
  const [fromCity, setFromCityState] = useState<CityDto | null>(null);
  const [toCity, setToCityState] = useState<CityDto | null>(null);
  const [fromAddress, setFromAddress] = useState("");
  const [toAddress, setToAddress] = useState("");
  const [fromPvz, setFromPvz] = useState<PvzDto | null>(null);
  const [toPvz, setToPvz] = useState<PvzDto | null>(null);
  const [mode, setMode] = useState<DeliveryMode>("warehouse-warehouse");

  // Смена города сбрасывает выбранный в нём ПВЗ
  const setFromCity = (city: CityDto | null) => {
    setFromCityState(city);
    setFromPvz(null);
  };
  const setToCity = (city: CityDto | null) => {
    setToCityState(city);
    setToPvz(null);
  };
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  const packRequestId = useRef(0);

  // Автокомплит товара
  useEffect(() => {
    if (selected || debouncedSearch.trim().length < 2) {
      setSuggestions([]);
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
      const data = (await res.json()) as {
        packing?: PackingDto;
        message?: string;
      };
      if (packRequestId.current !== requestId) return;
      if (!res.ok || !data.packing) {
        setPackError(data.message ?? "Не удалось рассчитать упаковку.");
        setPacking(null);
      } else {
        setPacking(data.packing);
        setPackError(null);
      }
    } catch {
      if (packRequestId.current === requestId) {
        setPackError("Не удалось рассчитать упаковку. Проверьте соединение.");
      }
    } finally {
      if (packRequestId.current === requestId) setPackLoading(false);
    }
  }, []);

  const changePositions = (next: Position[]) => {
    setPositions(next);
    setQuote(null);
    setQuoteError(null);
    void recalcPacking(next);
  };

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
  };

  const removeManualPlace = (id: number) => {
    setManualPlaces((prev) => prev.filter((m) => m.id !== id));
    setQuote(null);
    setQuoteError(null);
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
          fromAddress: mode.startsWith("door") ? fromAddress : "",
          toAddress: mode.endsWith("door") ? toAddress : "",
          fromPvzCode:
            mode.startsWith("warehouse") && fromPvz ? fromPvz.code : "",
          toPvzCode: mode.endsWith("warehouse") && toPvz ? toPvz.code : "",
        }),
      });
      const data = (await res.json()) as QuoteResponse;
      if (data.packing && positions.length > 0) setPacking(data.packing);
      if (!res.ok || !data.ok) {
        setQuoteError(data.message ?? "СДЭК не смог рассчитать доставку.");
        if (data.tariffs) setQuote(data);
      } else {
        setQuote(data);
      }
    } catch {
      setQuoteError("Не удалось выполнить расчёт. Проверьте соединение.");
    } finally {
      setQuoteLoading(false);
    }
  };

  const canCalc =
    canShipAll &&
    fromCity !== null &&
    toCity !== null &&
    !packLoading &&
    !quoteLoading;

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
                  onFocus={() => suggestions.length > 0 && setSuggestOpen(true)}
                />
                {suggestOpen && suggestions.length > 0 && (
                  <ul className="suggest-list">
                    {suggestions.map((p) => (
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
      <div className="card">
        <h2>Доставка СДЭК</h2>
        <div className="delivery-row">
          <CityField label="Откуда (город)" value={fromCity} onSelect={setFromCity} />
          <CityField label="Куда (город)" value={toCity} onSelect={setToCity} />
          <div className="field">
            <label>Режим доставки</label>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as DeliveryMode)}
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
        </div>
        <div className="delivery-row">
          {mode.startsWith("door") ? (
            <div className="field grow">
              <label>Адрес забора (улица, дом)</label>
              <input
                type="text"
                value={fromAddress}
                placeholder="Например: ул. Ленина, 10"
                onChange={(e) => setFromAddress(e.target.value)}
              />
            </div>
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
            <div className="field grow">
              <label>Адрес доставки (улица, дом)</label>
              <input
                type="text"
                value={toAddress}
                placeholder="Например: пр. Мира, 25, кв. 4"
                onChange={(e) => setToAddress(e.target.value)}
              />
            </div>
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
        <button
          type="button"
          className="button"
          disabled={!canCalc}
          onClick={calcDelivery}
        >
          {quoteLoading ? "Расчёт…" : "Рассчитать доставку СДЭК"}
        </button>
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
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Тариф</th>
                    <th>Стоимость, ₽</th>
                    <th>Срок, дн.</th>
                  </tr>
                </thead>
                <tbody>
                  {quote.tariffs.map((t: TariffDto) => (
                    <tr key={t.code}>
                      <td>
                        <strong>{t.name}</strong>
                        {t.description && (
                          <div className="meta-line">{t.description}</div>
                        )}
                      </td>
                      <td>
                        <strong>
                          {t.deliverySum.toLocaleString("ru-RU")}
                        </strong>
                      </td>
                      <td>
                        {t.periodMin === t.periodMax
                          ? t.periodMin
                          : `${t.periodMin}–${t.periodMax}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </>
  );
}
