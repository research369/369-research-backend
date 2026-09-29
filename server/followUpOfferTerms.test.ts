import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateFollowUpCodeExpiry,
  normalizeFollowUpOfferTerms,
} from "./followUpRouter.js";
import { isPromoCodeExpired } from "./promoCodeRouter.js";

test("individual follow-up terms accept a custom discount and long validity", () => {
  const terms = normalizeFollowUpOfferTerms({
    discountPercent: 17.5,
    codeValidityHours: 336,
  });
  assert.deepEqual(terms, { discountPercent: 17.5, codeValidityHours: 336 });
});

test("follow-up terms reject unsafe discounts and durations", () => {
  assert.throws(() => normalizeFollowUpOfferTerms({ discountPercent: 100.1, codeValidityHours: 48 }));
  assert.throws(() => normalizeFollowUpOfferTerms({ discountPercent: 10, codeValidityHours: 0 }));
  assert.throws(() => normalizeFollowUpOfferTerms({ discountPercent: 10, codeValidityHours: 8761 }));
});

test("follow-up code expiry is exact to the selected hour", () => {
  const issuedAt = new Date("2026-09-29T09:13:00.000Z");
  const expiry = calculateFollowUpCodeExpiry(issuedAt, { discountPercent: 20, codeValidityHours: 72 });
  assert.equal(expiry.toISOString(), "2026-10-02T09:13:00.000Z");

  assert.equal(isPromoCodeExpired({ validUntil: expiry, validUntilExact: 1 }, new Date("2026-10-02T09:12:59.999Z")), false);
  assert.equal(isPromoCodeExpired({ validUntil: expiry, validUntilExact: 1 }, new Date("2026-10-02T09:13:00.001Z")), true);
});

test("legacy WaWi promotion codes remain valid through their expiry date", () => {
  const expiry = new Date("2026-10-02T00:00:00.000Z");
  assert.equal(isPromoCodeExpired({ validUntil: expiry, validUntilExact: 0 }, new Date("2026-10-02T23:59:59.999Z")), false);
  assert.equal(isPromoCodeExpired({ validUntil: expiry, validUntilExact: 0 }, new Date("2026-10-03T00:00:00.000Z")), true);
});
