import assert from "node:assert/strict";
import test from "node:test";
import { shouldSendOrderConfirmation } from "./orderConfirmationPolicy.js";

test("Shop-Bestellungen behalten die automatische Bestellbestätigung", () => {
  assert.equal(shouldSendOrderConfirmation({ isAuthenticatedWawiManualSale: false }), true);
  assert.equal(shouldSendOrderConfirmation({
    isAuthenticatedWawiManualSale: false,
    sendOrderConfirmation: false,
  }), true);
});

test("manuelle WaWi-Bestellungen versenden ohne Freigabe keine Bestellbestätigung", () => {
  assert.equal(shouldSendOrderConfirmation({ isAuthenticatedWawiManualSale: true }), false);
  assert.equal(shouldSendOrderConfirmation({
    isAuthenticatedWawiManualSale: true,
    sendOrderConfirmation: false,
  }), false);
});

test("manuelle WaWi-Bestellungen versenden erst nach expliziter Freigabe", () => {
  assert.equal(shouldSendOrderConfirmation({
    isAuthenticatedWawiManualSale: true,
    sendOrderConfirmation: true,
  }), true);
});
