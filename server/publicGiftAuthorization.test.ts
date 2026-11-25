import assert from "node:assert/strict";
import test from "node:test";
import { authorizePublicGiftLines } from "./publicGiftAuthorization.js";
const catalog = [{ sku: "TEST", shopProductId: "test", name: "Synthetic (10 mg)", sellingPrice: "100", salePrice: null, isActive: 1, shopVisible: 1, variants: [{ dosage: "10 mg", price: 100 }] }];
const active = { enabled: true, expiresAt: "2099-01-01T00:00:00Z", mode: "all" as const, products: [] };
const paid = { shopProductId: "test", dosage: "10 mg", price: 100, quantity: 2 };
const gift = { ...paid, price: 0, quantity: 1, isFreeGift: true };
test("free merchandise cannot bypass exclusive campaign or disabled multi-buy", () => {
  assert.throws(() => authorizePublicGiftLines([paid, gift], catalog, active, true), /NICHT_AUTORISIERT/);
  assert.throws(() => authorizePublicGiftLines([paid, gift], catalog, { ...active, enabled: false }, false), /NICHT_AUTORISIERT/);
});
test("legitimate existing two-paid-one-free remains supported outside exclusive campaign", () => {
  assert.doesNotThrow(() => authorizePublicGiftLines([paid, gift], catalog, active, false));
  assert.throws(() => authorizePublicGiftLines([paid, gift, gift], catalog, active, false), /NICHT_AUTORISIERT/);
});
test("free item must match paid variant and server-owned filter", () => {
  assert.throws(() => authorizePublicGiftLines([paid, { ...gift, dosage: "20 mg" }], catalog, active, false), /NICHT_AUTORISIERT/);
  assert.throws(() => authorizePublicGiftLines([paid, gift], catalog, { ...active, mode: "exclude", products: ["test"] }, false), /NICHT_AUTORISIERT/);
  assert.throws(() => authorizePublicGiftLines([paid, { ...gift, shopProductId: "nonexistent" }], catalog, active, false), /NICHT_AUTORISIERT/);
});
test("expired multi-buy and gift without paid counterpart fail closed", () => {
  assert.throws(() => authorizePublicGiftLines([paid, gift], catalog, { ...active, expiresAt: "2020-01-01T00:00:00Z" }, false), /NICHT_AUTORISIERT/);
  assert.throws(() => authorizePublicGiftLines([gift], catalog, active, false), /NICHT_AUTORISIERT/);
});
