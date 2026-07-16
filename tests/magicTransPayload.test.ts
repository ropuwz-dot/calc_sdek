import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMagicTransCalculatorPayload,
  filterMagicTransCities,
} from "../lib/magicTransPayload";

const onePlace = {
  article: "A-1",
  label: "Тестовый товар",
  unitsPerPlace: 1,
  count: 1,
  lengthCm: 30,
  widthCm: 30,
  heightCm: 30,
  weightKg: 30,
  volumeM3: 0.027,
};

test("Magic Trans payload rejects an empty list of places", () => {
  assert.throws(
    () =>
      buildMagicTransCalculatorPayload({
        from: { cityId: "from", address: "" },
        to: { cityId: "to", address: "" },
        mode: "warehouse-warehouse",
        pickupDate: "2026-07-16",
        places: [],
      }),
    /Нет упаковочных мест/
  );
});

test("Magic Trans payload selects terminal delivery and preserves dimensions in metres", () => {
  const payload = buildMagicTransCalculatorPayload({
    from: { cityId: "from", terminalId: "terminal-from", address: "" },
    to: { cityId: "to", terminalId: "terminal-to", address: "" },
    mode: "warehouse-warehouse",
    pickupDate: "2026-07-16",
    places: [onePlace],
  });

  assert.deepEqual(payload.options, {
    fromTerminal: true,
    toTerminal: true,
    toSupermarket: false,
    sensitiveCargo: false,
    additionalPackage: false,
  });
  assert.deepEqual(payload.cargo, {
    quantity: 1,
    weight: 30,
    volume: 0.027,
    length: 0.3,
    width: 0.3,
    height: 0.3,
    price: 0,
  });
});

test("Magic Trans city matching ranks the exact city above regional matches", () => {
  const cities = filterMagicTransCities(
    [
      { id: "1", name: "Кодинск", region: "Красноярский край" },
      { id: "2", name: "Красноярск", region: "Красноярский край" },
      { id: "3", name: "Красный Яр", region: "Красноярский край" },
    ],
    "красноярск"
  );

  assert.equal(cities[0]?.id, "2");
});
