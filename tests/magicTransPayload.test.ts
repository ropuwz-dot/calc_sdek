import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMagicTransCalculatorPayload,
  calculateMagicTransInsurance,
  filterMagicTransCities,
  parseMagicTransPublicAddressCosts,
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

test("Magic Trans payload retains the terminal GUID for door pickup", () => {
  const payload = buildMagicTransCalculatorPayload({
    from: {
      cityId: "from",
      terminalId: "servicing-terminal-from",
      address: "Воронеж, Ленинский проспект, 158/3",
    },
    to: { cityId: "to", terminalId: "terminal-to", address: "" },
    mode: "door-warehouse",
    pickupDate: "2026-07-16",
    places: [onePlace],
  });

  assert.equal(payload.options.fromTerminal, false);
  assert.equal(payload.from.terminal, "servicing-terminal-from");
  assert.equal(payload.from.address, "Воронеж, Ленинский проспект, 158/3");
});

test("Magic Trans public calculator exposes base tariff and address charges", () => {
  assert.deepEqual(
    parseMagicTransPublicAddressCosts({
      result: {
        terminal: "750",
        addressCost: {
          from: { total: 800 },
          to: { total: "650" },
        },
      },
    }),
    { base: 750, pickup: 800, delivery: 650 }
  );
});

test("Magic Trans insurance has a minimum of 40 rubles", () => {
  assert.equal(calculateMagicTransInsurance(0), 40);
  assert.equal(calculateMagicTransInsurance(10_000), 40);
  assert.equal(calculateMagicTransInsurance(125_000), 250);
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
