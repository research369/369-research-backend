import assert from "node:assert/strict";
import test from "node:test";
import { calculateCommissionAmount, calculateCommissionBase, resolveCommissionAmount } from "./partnerCreditService.js";

test("partner commission uses the discounted product subtotal and never credits shipping", () => {
  const base = calculateCommissionBase({
    subtotal: 100,
    totalProductDiscount: 10,
    creditUsed: 0,
  });
  assert.equal(base, 90);
  assert.equal(calculateCommissionAmount({
    subtotal: 100,
    totalProductDiscount: 10,
    creditUsed: 0,
    commissionPercent: 10,
  }), 9);
});

test("redeemed partner credit is a payment method and does not reduce newly earned credit", () => {
  const base = calculateCommissionBase({
    subtotal: 100,
    totalProductDiscount: 19,
    creditUsed: 9,
  });
  assert.equal(base, 90);
  assert.equal(calculateCommissionAmount({
    subtotal: 100,
    totalProductDiscount: 19,
    creditUsed: 9,
    commissionPercent: 10,
  }), 9);
});

test("an explicit order-bound credit amount remains auditable and cannot be negative", () => {
  assert.equal(resolveCommissionAmount({
    subtotal: 100,
    totalProductDiscount: 10,
    creditUsed: 0,
    commissionPercent: 10,
  }, 7), 7);
  assert.throws(() => resolveCommissionAmount({
    subtotal: 100,
    totalProductDiscount: 10,
    creditUsed: 0,
    commissionPercent: 10,
  }, -0.01));
});
