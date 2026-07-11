import type { CityDto, DellinCityDto } from "@/lib/types";

export type RecentCarrier = "cdek" | "dellin";

export interface RecentDirection<TCity> {
  from: TCity;
  to: TCity;
  pinned: boolean;
  touchedAt: number;
}

export interface RecentDirectionsState {
  cdek: RecentDirection<CityDto>[];
  dellin: RecentDirection<DellinCityDto>[];
}

const STORAGE_KEY = "cdekcalc.recents.v1";
const MAX_DIRECTIONS = 8;

const emptyState = (): RecentDirectionsState => ({
  cdek: [],
  dellin: [],
});

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

const cityKey = (city: CityDto) => String(city.code);
const dellinCityKey = (city: DellinCityDto) => `${city.code}:${city.cityId}`;

const directionKey = (
  carrier: RecentCarrier,
  direction: RecentDirection<CityDto> | RecentDirection<DellinCityDto>
) =>
  carrier === "cdek"
    ? `${cityKey(direction.from as CityDto)}>${cityKey(direction.to as CityDto)}`
    : `${dellinCityKey(direction.from as DellinCityDto)}>${dellinCityKey(
        direction.to as DellinCityDto
      )}`;

const normalizeList = <TCity>(
  carrier: RecentCarrier,
  list: RecentDirection<TCity>[]
) => {
  const seen = new Set<string>();
  const unique = list
    .filter((item) => item.from && item.to)
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.touchedAt - a.touchedAt;
    })
    .filter((item) => {
      const key = directionKey(
        carrier,
        item as RecentDirection<CityDto> | RecentDirection<DellinCityDto>
      );
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  if (unique.length <= MAX_DIRECTIONS) return unique;

  const pinned = unique.filter((item) => item.pinned);
  const unpinned = unique.filter((item) => !item.pinned);
  if (pinned.length >= MAX_DIRECTIONS) return pinned.slice(0, MAX_DIRECTIONS);
  return [...pinned, ...unpinned.slice(0, MAX_DIRECTIONS - pinned.length)];
};

const parseState = (raw: string | null): RecentDirectionsState => {
  if (!raw) return emptyState();
  try {
    const parsed = JSON.parse(raw) as Partial<RecentDirectionsState>;
    return {
      cdek: normalizeList("cdek", parsed.cdek ?? []),
      dellin: normalizeList("dellin", parsed.dellin ?? []),
    };
  } catch {
    return emptyState();
  }
};

export const loadRecentDirections = (): RecentDirectionsState => {
  if (!canUseStorage()) return emptyState();
  return parseState(window.localStorage.getItem(STORAGE_KEY));
};

export const saveRecentDirections = (state: RecentDirectionsState) => {
  if (!canUseStorage()) return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        cdek: normalizeList("cdek", state.cdek),
        dellin: normalizeList("dellin", state.dellin),
      })
    );
  } catch {
    // localStorage can fail after the initial probe in private modes.
  }
};

export function rememberDirection(
  state: RecentDirectionsState,
  carrier: "cdek",
  from: CityDto,
  to: CityDto
): RecentDirectionsState;
export function rememberDirection(
  state: RecentDirectionsState,
  carrier: "dellin",
  from: DellinCityDto,
  to: DellinCityDto
): RecentDirectionsState;
export function rememberDirection(
  state: RecentDirectionsState,
  carrier: RecentCarrier,
  from: CityDto | DellinCityDto,
  to: CityDto | DellinCityDto
): RecentDirectionsState {
  const list = state[carrier] as RecentDirection<CityDto | DellinCityDto>[];
  const key = directionKey(carrier, {
    from,
    to,
    pinned: false,
    touchedAt: 0,
  } as RecentDirection<CityDto> | RecentDirection<DellinCityDto>);
  const existing = list.find(
    (item) =>
      directionKey(
        carrier,
        item as RecentDirection<CityDto> | RecentDirection<DellinCityDto>
      ) === key
  );
  const nextItem = {
    from,
    to,
    pinned: existing?.pinned ?? false,
    touchedAt: Date.now(),
  };
  const nextList = normalizeList(carrier, [
    nextItem,
    ...list.filter(
      (item) =>
        directionKey(
          carrier,
          item as RecentDirection<CityDto> | RecentDirection<DellinCityDto>
        ) !== key
    ),
  ]);
  return { ...state, [carrier]: nextList } as RecentDirectionsState;
}

export const toggleDirectionPinned = (
  state: RecentDirectionsState,
  carrier: RecentCarrier,
  key: string
): RecentDirectionsState => {
  const list = state[carrier] as RecentDirection<CityDto | DellinCityDto>[];
  const nextList = normalizeList(
    carrier,
    list.map((item) =>
      directionKey(
        carrier,
        item as RecentDirection<CityDto> | RecentDirection<DellinCityDto>
      ) === key
        ? { ...item, pinned: !item.pinned, touchedAt: Date.now() }
        : item
    )
  );
  return { ...state, [carrier]: nextList } as RecentDirectionsState;
};

export const recentDirectionKey = <TCity>(
  carrier: RecentCarrier,
  direction: RecentDirection<TCity>
) =>
  directionKey(
    carrier,
    direction as RecentDirection<CityDto> | RecentDirection<DellinCityDto>
  );
