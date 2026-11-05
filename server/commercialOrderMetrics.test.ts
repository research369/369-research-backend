import assert from "node:assert/strict";
import test from "node:test";
import {
  isBillableOrderItem,
  isCommercialOrder,
  isCompletedCommercialOrder,
} from "./commercialOrderMetrics.js";

test("zero-total goodwill orders remain historical but are not commercial sales", () => {
  assert.equal(isCommercialOrder({ status: "versendet", total: "0.00" }), false);
  assert.equal(isCompletedCommercialOrder({ status: "versendet", total: "0.00" }), false);
  assert.equal(isCommercialOrder({ status: "storniert", total: "99.00" }), false);
  assert.equal(isCompletedCommercialOrder({ status: "versendet", total: "99.00" }), true);
});

test("zero-priced gift line items never contribute product revenue", () => {
  assert.equal(isBillableOrderItem({ price: "0.00" }), false);
  assert.equal(isBillableOrderItem({ price: "45.00" }), true);
});
