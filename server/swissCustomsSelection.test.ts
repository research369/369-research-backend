import assert from "node:assert/strict";
import test from "node:test";
import { restoreSwissCustomsSelection, validateSwissCustomsSelection, type SwissCustomsDraftItem } from "./swissCustomsSelection.js";

const existing = [{ id: 11, quantity: 3 }, { id: 12, quantity: 2 }, { id: 13, quantity: 1 }];
function item(orderItemId: number): SwissCustomsDraftItem {
  return { orderItemId, description: "Declared research material", hsCode: "", countryOfOrigin: "", unitWeightGrams: 20, unitCustomsValueEur: 10 };
}

test("legacy all-position draft works without exclusions and preserves original order", () => {
  const result = validateSwissCustomsSelection(existing, [item(13), item(11), item(12)]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.lines.map((line) => line.orderItemId), [11, 12, 13]);
  assert.deepEqual(result.lines.map((line) => line.quantity), [3, 2, 1]);
});

test("explicit exclusions select only real shipment lines; caller quantity cannot override original quantity", () => {
  const submitted = { ...item(11), quantity: 999 };
  const result = validateSwissCustomsSelection(existing, [submitted], [12, 13]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.lines, [{ ...item(11), quantity: 3 }]);
  assert.equal(submitted.quantity, 999);
  assert.deepEqual(existing, [{ id: 11, quantity: 3 }, { id: 12, quantity: 2 }, { id: 13, quantity: 1 }]);
});

const invalidCases: [string, unknown, unknown][] = [
  ["implicit omission", [item(11)], []],
  ["selected duplicate", [item(11), item(11)], [12, 13]],
  ["foreign selected", [item(99)], [11, 12, 13]],
  ["excluded duplicate", [item(11)], [12, 12, 13]],
  ["foreign excluded", [item(11)], [12, 13, 99]],
  ["selected/excluded overlap", [item(11)], [11, 12, 13]],
  ["all removed", [], [11, 12, 13]],
  ["missing items", undefined, [11, 12, 13]],
  ["null selected item", [null], [12, 13]],
  ["null exclusion list", [item(11), item(12), item(13)], null],
  ["non-array exclusion list", [item(11), item(12), item(13)], ""],
  ["string selected ID", [{ ...item(11), orderItemId: "11" }], [12, 13]],
  ["string excluded ID", [item(11)], ["12", 13]],
  ["zero ID", [item(0)], [12, 13]],
  ["negative ID", [item(-11)], [12, 13]],
  ["fractional ID", [item(11.5)], [12, 13]],
  ["NaN ID", [item(NaN)], [12, 13]],
  ["infinite ID", [item(Infinity)], [12, 13]],
  ["unsafe ID", [item(Number.MAX_SAFE_INTEGER + 1)], [12, 13]],
];
for (const [name, items, exclusions] of invalidCases) {
  test(`rejects ${name}`, () => {
    assert.equal(validateSwissCustomsSelection(existing, items, exclusions).ok, false);
  });
}

test("empty original order cannot produce a declaration", () => {
  assert.equal(validateSwissCustomsSelection([], [], []).ok, false);
});

test("unsaved draft starts with all original positions and no exclusions", () => {
  assert.deepEqual(restoreSwissCustomsSelection(existing, false, new Set()), { items: existing, excludedItems: [] });
});

test("saved draft restores selected originals and excluded complement, ignoring foreign saved IDs", () => {
  assert.deepEqual(restoreSwissCustomsSelection(existing, true, new Set([13, 11, 99])), {
    items: [existing[0], existing[2]], excludedItems: [existing[1]],
  });
});

test("saved declaration with no surviving lines does not silently restore all positions", () => {
  assert.deepEqual(restoreSwissCustomsSelection(existing, true, new Set()), { items: [], excludedItems: existing });
});

test("restoring then resaving one excluded position remains an exact partition", () => {
  const restored = restoreSwissCustomsSelection(existing, true, new Set([11]));
  const result = validateSwissCustomsSelection(existing, [...restored.items.map((row) => item(row.id)), item(restored.excludedItems[0].id)], [13]);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.lines.map((line) => line.orderItemId), [11, 12]);
});
