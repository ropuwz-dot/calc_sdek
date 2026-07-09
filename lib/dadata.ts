import "server-only";

/**
 * Подсказки улиц через DaData (suggestions API, бесплатно до 10 000
 * запросов в сутки). Используются для адресов «дверь» у СДЭК — у СДЭК
 * нет собственного справочника улиц в API.
 *
 * Подсказки — необязательное удобство: без ключа DADATA_API_KEY поле
 * улицы остаётся свободным текстом, ошибок пользователю не показываем.
 */

const SUGGEST_URL =
  "https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address";

export async function suggestStreets(
  cityName: string,
  query: string
): Promise<{ ok: true; streets: string[] } | { ok: false; message: string }> {
  const apiKey = process.env.DADATA_API_KEY?.trim();
  if (!apiKey) {
    // Интеграция не настроена — тихо работаем без подсказок
    return { ok: true, streets: [] };
  }

  const cityShort = cityName.split(",")[0].trim();
  if (cityShort === "" || query.trim().length < 2) {
    return { ok: true, streets: [] };
  }

  try {
    const response = await fetch(SUGGEST_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Token ${apiKey}`,
      },
      body: JSON.stringify({
        query: query.trim(),
        count: 8,
        from_bound: { value: "street" },
        to_bound: { value: "street" },
        restrict_value: true,
        // город и населённый пункт — CDEK-локацией может быть и село
        locations: [{ city: cityShort }, { settlement: cityShort }],
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(7_000),
    });
    if (!response.ok) {
      return {
        ok: false,
        message: `Сервис подсказок адресов вернул ошибку (HTTP ${response.status}).`,
      };
    }
    const data = (await response.json()) as {
      suggestions?: {
        value?: string;
        data?: { street_with_type?: string | null };
      }[];
    };
    const streets = [
      ...new Set(
        (data.suggestions ?? [])
          .map((s) => s.data?.street_with_type ?? s.value ?? "")
          .filter((s) => s !== "")
      ),
    ];
    return { ok: true, streets };
  } catch {
    return { ok: false, message: "Не удалось получить подсказки улиц." };
  }
}
