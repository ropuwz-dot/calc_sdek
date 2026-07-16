"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  DeliveryMode,
  MagicTransCityDto,
  MagicTransQuoteResponse,
  MagicTransTerminalDto,
  ManualPlaceInput,
  PositionInput,
} from "@/lib/types";
import { DELIVERY_MODE_LABELS } from "@/lib/types";

type Props = {
  items: PositionInput[];
  manualPlaces: ManualPlaceInput[];
  canShip: boolean;
  totalPlaces: number;
};

async function parseJson<T>(response: Response): Promise<T & { message?: string }> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T & { message?: string };
  } catch {
    throw new Error(`Сервер вернул неожиданный ответ (HTTP ${response.status}).`);
  }
}

function CityPicker({
  label,
  value,
  onSelect,
}: {
  label: string;
  value: MagicTransCityDto | null;
  onSelect: (city: MagicTransCityDto | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<MagicTransCityDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  const activeOptions = value || query.trim().length < 2 ? [] : options;

  useEffect(() => {
    if (value || query.trim().length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/magic-trans/locations?q=${encodeURIComponent(query)}`, {
          signal: controller.signal,
        });
        const data = await parseJson<{ cities: MagicTransCityDto[] }>(response);
        if (!response.ok) throw new Error(data.message ?? "Не удалось найти города.");
        setOptions(data.cities);
        setError(null);
      } catch (reason) {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : "Не удалось найти города.");
      }
    }, 300);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, value]);

  return (
    <div className="field grow">
      <label>{label}</label>
      {value ? (
        <div className="selected-chip">
          <span>{[value.name, value.region].filter(Boolean).join(", ")}</span>
          <button type="button" className="link-button" onClick={() => { onSelect(null); setQuery(""); }}>
            изменить
          </button>
        </div>
      ) : (
        <div className="suggest-wrap">
          <input value={query} placeholder="Начните вводить город…" onChange={(event) => setQuery(event.target.value)} />
          {activeOptions.length > 0 && (
            <ul className="suggest-list">
              {activeOptions.map((city) => (
                <li key={city.id}>
                  <button type="button" onClick={() => { onSelect(city); setOptions([]); }}>
                    {city.name}{city.region ? <span className="suggest-meta"> · {city.region}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error ? <p className="field-error">{error}</p> : null}
    </div>
  );
}

function TerminalPicker({
  label,
  city,
  value,
  onSelect,
}: {
  label: string;
  city: MagicTransCityDto | null;
  value: MagicTransTerminalDto | null;
  onSelect: (terminal: MagicTransTerminalDto | null) => void;
}) {
  const [options, setOptions] = useState<MagicTransTerminalDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const cityId = city?.id ?? "";

  useEffect(() => {
    if (!cityId) return;
    const controller = new AbortController();
    fetch(`/api/magic-trans/terminals?cityId=${encodeURIComponent(cityId)}`, { signal: controller.signal })
      .then(async (response) => {
        const data = await parseJson<{ terminals: MagicTransTerminalDto[] }>(response);
        if (!response.ok) throw new Error(data.message ?? "Не удалось получить терминалы.");
        setOptions(data.terminals);
        setError(null);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Не удалось получить терминалы.");
      });
    return () => controller.abort();
  }, [cityId]);

  return (
    <div className="field grow">
      <label>{label}</label>
      <select value={value?.id ?? ""} disabled={!city} onChange={(event) => onSelect(options.find((terminal) => terminal.id === event.target.value) ?? null)}>
        <option value="">{city ? "Выберите терминал" : "Сначала выберите город"}</option>
        {options.map((terminal) => <option key={terminal.id} value={terminal.id}>{terminal.name}{terminal.address ? ` — ${terminal.address}` : ""}</option>)}
      </select>
      {error ? <p className="field-error">{error}</p> : null}
    </div>
  );
}

export default function MagicTransPanel({ items, manualPlaces, canShip, totalPlaces }: Props) {
  const [fromCity, setFromCity] = useState<MagicTransCityDto | null>(null);
  const [toCity, setToCity] = useState<MagicTransCityDto | null>(null);
  const [fromTerminal, setFromTerminal] = useState<MagicTransTerminalDto | null>(null);
  const [toTerminal, setToTerminal] = useState<MagicTransTerminalDto | null>(null);
  const [fromAddress, setFromAddress] = useState("");
  const [toAddress, setToAddress] = useState("");
  const [mode, setMode] = useState<DeliveryMode>("warehouse-warehouse");
  const [quote, setQuote] = useState<MagicTransQuoteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const selectFromCity = (city: MagicTransCityDto | null) => {
    setFromCity(city);
    setFromTerminal(null);
    setQuote(null);
  };
  const selectToCity = (city: MagicTransCityDto | null) => {
    setToCity(city);
    setToTerminal(null);
    setQuote(null);
  };

  const requiresFromTerminal = mode.startsWith("warehouse");
  const requiresToTerminal = mode.endsWith("warehouse");
  const canCalculate = useMemo(
    () => canShip && totalPlaces > 0 && fromCity && toCity &&
      (!requiresFromTerminal || fromTerminal) &&
      (!requiresToTerminal || toTerminal) &&
      (requiresFromTerminal || fromAddress.trim()) &&
      (requiresToTerminal || toAddress.trim()) && !loading,
    [canShip, fromAddress, fromCity, fromTerminal, loading, requiresFromTerminal, requiresToTerminal, toAddress, toCity, toTerminal, totalPlaces]
  );

  const calculate = async () => {
    if (!canCalculate || !fromCity || !toCity) return;
    setLoading(true); setError(null); setQuote(null);
    try {
      const response = await fetch("/api/magic-trans/quote", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items,
          manualPlaces,
          fromCityId: fromCity.id,
          toCityId: toCity.id,
          fromTerminalId: requiresFromTerminal ? fromTerminal?.id : "",
          toTerminalId: requiresToTerminal ? toTerminal?.id : "",
          fromAddress: requiresFromTerminal ? "" : fromAddress,
          toAddress: requiresToTerminal ? "" : toAddress,
          mode,
        }),
      });
      const data = await parseJson<MagicTransQuoteResponse>(response);
      if (!response.ok || !data.ok) throw new Error(data.message ?? "Magic Trans не смогли рассчитать доставку.");
      setQuote(data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось выполнить расчёт Magic Trans.");
    } finally { setLoading(false); }
  };

  return (
    <>
      <div className="card">
        <h2>Доставка Magic Trans</h2>
        <div className="delivery-row">
          <CityPicker label="Откуда (город)" value={fromCity} onSelect={selectFromCity} />
          <CityPicker label="Куда (город)" value={toCity} onSelect={selectToCity} />
          <div className="field"><label>Режим доставки</label><select value={mode} onChange={(event) => { setMode(event.target.value as DeliveryMode); setQuote(null); setError(null); }}>{(Object.entries(DELIVERY_MODE_LABELS) as [DeliveryMode, string][]).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
        </div>
        <div className="delivery-row">
          {requiresFromTerminal ? <TerminalPicker label="Терминал отправления" city={fromCity} value={fromTerminal} onSelect={setFromTerminal} /> : <div className="field grow"><label>Адрес забора</label><input value={fromAddress} placeholder="г. Воронеж, ул. Ленина, 1" onChange={(event) => setFromAddress(event.target.value)} /></div>}
          {requiresToTerminal ? <TerminalPicker label="Терминал получения" city={toCity} value={toTerminal} onSelect={setToTerminal} /> : <div className="field grow"><label>Адрес доставки</label><input value={toAddress} placeholder="г. Красноярск, пр. Мира, 2" onChange={(event) => setToAddress(event.target.value)} /></div>}
        </div>
        <p className="meta-line">Расчет Magic Trans использует те же упаковочные места. Объявленная стоимость, дополнительная упаковка и режимный груз пока не включены.</p>
        <div className="add-row"><button type="button" className="button" disabled={!canCalculate} onClick={calculate}>{loading ? "Расчёт…" : "Рассчитать доставку Magic Trans"}</button></div>
        {totalPlaces === 0 ? <p className="meta-line">Сначала добавьте товарные позиции или ручное место.</p> : null}
        {!canShip ? <p className="meta-line">Расчёт недоступен: исправьте ошибки упаковки выше.</p> : null}
      </div>
      {(quote || error) && <div className="card"><h2>Результат Magic Trans</h2>{error ? <div className="error-message">{error}</div> : null}{quote?.tariffs?.map((tariff) => <div key={tariff.name} className="result-main"><strong>{tariff.deliverySum.toLocaleString("ru-RU")} ₽</strong><span>{tariff.periodMin} дн.</span>{tariff.deliveryDate ? <span>Плановая дата: {new Date(tariff.deliveryDate).toLocaleDateString("ru-RU")}</span> : null}</div>)}</div>}
    </>
  );
}
