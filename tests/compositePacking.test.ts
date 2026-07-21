import assert from "node:assert/strict";
import test from "node:test";

import { parseCatalog } from "../lib/catalog";
import { packItems } from "../lib/packing";

const header = [
  "Артикул", "Наименование", "Длина, см", "Ширина, см", "Высота, см", "Вес брутто, кг",
];
const compositeHeader = [
  "Артикул комплекта", "№ места", "Артикул места", "Количество мест",
];

function catalogWithComposite() {
  return parseCatalog("Тестовый справочник", [
    {
      title: "Справочник (шт)",
      rows: [
        header,
        ["DON.0233", "Зенитная тренога ПКТ", "", "", "", ""],
        ["DON.0235", "Лафет для ПКТ", 92, 34, 27, 11.3],
        ["DON.0174", "Зенитная тренога ПКМ", 125, 27, 27, 10.3],
      ],
    },
    {
      title: "Составные артикулы",
      rows: [
        compositeHeader,
        ["DON.0233", 1, "DON.0235", 1],
        ["DON.0233", 2, "DON.0174", 1],
      ],
    },
  ]);
}

test("составной артикул разворачивается в отдельные места из компонентов", () => {
  const catalog = catalogWithComposite();
  assert.deepEqual(
    catalog.composites["DON.0233"].map(({ placeNumber, componentArticle, count }) => ({
      placeNumber, componentArticle, count,
    })),
    [
      { placeNumber: 1, componentArticle: "DON.0235", count: 1 },
      { placeNumber: 2, componentArticle: "DON.0174", count: 1 },
    ]
  );

  const result = packItems([{ article: "DON.0233", qty: 1 }], catalog);
  assert.equal(result.canShip, true);
  assert.equal(result.totalPlaces, 2);
  assert.equal(result.totalWeightKg, 21.6);
  assert.equal(result.totalVolumeM3, 0.175581);
  assert.deepEqual(
    result.places.map(({ count, lengthCm, widthCm, heightCm, weightKg }) => ({
      count, lengthCm, widthCm, heightCm, weightKg,
    })),
    [
      { count: 1, lengthCm: 92, widthCm: 34, heightCm: 27, weightKg: 11.3 },
      { count: 1, lengthCm: 125, widthCm: 27, heightCm: 27, weightKg: 10.3 },
    ]
  );
});

test("количество комплектов линейно увеличивает число мест", () => {
  const result = packItems([{ article: "DON.0233", qty: 2 }], catalogWithComposite());
  assert.equal(result.canShip, true);
  assert.equal(result.totalPlaces, 4);
  assert.equal(result.totalWeightKg, 43.2);
  assert.deepEqual(result.places.map((place) => place.count), [2, 2]);
});

test("количество одинаковых мест умножается на количество комплектов", () => {
  const catalog = parseCatalog("Тест", [
    {
      title: "Справочник (шт)",
      rows: [
        header,
        ["KIT", "Комплект", "", "", "", ""],
        ["PART", "Одинаковое место", 20, 10, 5, 2],
      ],
    },
    {
      title: "Составные артикулы",
      rows: [compositeHeader, ["KIT", 1, "PART", 2]],
    },
  ]);

  const result = packItems([{ article: "KIT", qty: 3 }], catalog);
  assert.equal(catalog.stats.compositePlaceCount, 2);
  assert.equal(result.totalPlaces, 6);
  assert.equal(result.totalWeightKg, 12);
  assert.equal(result.places[0]?.count, 6);
});

test("комплект с полными компонентами считается готовым к расчёту", () => {
  const catalog = catalogWithComposite();
  assert.equal(catalog.stats.compositeArticleCount, 1);
  assert.equal(catalog.stats.compositePlaceCount, 2);
  assert.equal(catalog.stats.productsComplete, 3);
  assert.equal(catalog.stats.productsWithoutWeight, 0);
  assert.equal(catalog.stats.productsWithoutDims, 0);
});

test("собственные ДШВ комплекта не маскируют неполный компонент", () => {
  const catalog = parseCatalog("Тест", [
    {
      title: "Справочник (шт)",
      rows: [
        header,
        ["KIT", "Комплект", 10, 10, 10, 1],
        ["PART", "Место без веса", 20, 20, 20, ""],
      ],
    },
    {
      title: "Составные артикулы",
      rows: [compositeHeader, ["KIT", 1, "PART", 1]],
    },
  ]);
  assert.equal(catalog.stats.productsComplete, 0);
  assert.equal(catalog.stats.productsWithoutWeight, 2);
});

test("вложенный состав отклоняется", () => {
  const catalog = parseCatalog("Тест", [
    {
      title: "Справочник (шт)",
      rows: [
        header,
        ["KIT.A", "Внешний комплект", "", "", "", ""],
        ["KIT.B", "Вложенный комплект", 30, 30, 30, 3],
        ["PART", "Физическое место", 20, 20, 20, 2],
      ],
    },
    {
      title: "Составные артикулы",
      rows: [compositeHeader, ["KIT.A", 1, "KIT.B", 1], ["KIT.B", 1, "PART", 1]],
    },
  ]);
  const result = packItems([{ article: "KIT.A", qty: 1 }], catalog);
  assert.equal(result.canShip, false);
  assert.match(result.errors.join("\n"), /вложенн/i);
  assert.match(catalog.issues.map((issue) => issue.message).join("\n"), /вложенн/i);
});

test("повторный номер места отклоняется", () => {
  const catalog = parseCatalog("Тест", [
    {
      title: "Составные артикулы",
      rows: [
        compositeHeader,
        ["DON.0233", 1, "DON.0235", 1],
        ["DON.0233", 1, "DON.0174", 1],
      ],
    },
  ]);
  assert.equal(catalog.composites["DON.0233"].length, 1);
  assert.match(catalog.issues[0]?.message ?? "", /повторный номер места 1/i);
});

test("отсутствующий артикул места попадает в отчёт качества", () => {
  const catalog = parseCatalog("Тест", [
    {
      title: "Справочник (шт)",
      rows: [header, ["DON.0233", "Комплект", "", "", "", ""]],
    },
    {
      title: "Составные артикулы",
      rows: [compositeHeader, ["DON.0233", 1, "DON.MISSING", 1]],
    },
  ]);
  assert.match(
    catalog.issues.map((issue) => issue.message).join("\n"),
    /DON\.MISSING.*не найден/i
  );
});
