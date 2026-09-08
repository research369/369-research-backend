import assert from "node:assert/strict";
import { calculateAuthoritativeWawiManualOrder } from "../server/manualWawiPricing.js";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

test("ein WaWi-Verkauf ersetzt einen fehlenden Browser-Dauerrabatt serverseitig", () => {
  const result = calculateAuthoritativeWawiManualOrder({
    subtotal: 62,
    shipping: 8,
    submittedDiscount: 0,
    submittedAutomaticGlobalDiscount: 0,
    authoritativeAutomaticGlobalDiscount: 12.4,
  });

  assert.deepEqual(result, {
    manualDiscount: 0,
    automaticGlobalDiscount: 12.4,
    totalDiscount: 12.4,
    total: 57.6,
  });
});

test("ein alter oder abweichender Dialogbetrag wird nie übernommen", () => {
  const result = calculateAuthoritativeWawiManualOrder({
    subtotal: 62,
    shipping: 8,
    submittedDiscount: 17,
    submittedAutomaticGlobalDiscount: 5,
    authoritativeAutomaticGlobalDiscount: 12.4,
  });

  assert.deepEqual(result, {
    manualDiscount: 12,
    automaticGlobalDiscount: 12.4,
    totalDiscount: 24.4,
    total: 45.6,
  });
});

test("manuelle Nachlässe werden zusammen mit dem Dauerrabatt am Warenwert gedeckelt", () => {
  const result = calculateAuthoritativeWawiManualOrder({
    subtotal: 62,
    shipping: 8,
    submittedDiscount: 100,
    submittedAutomaticGlobalDiscount: 0,
    authoritativeAutomaticGlobalDiscount: 12.4,
  });

  assert.deepEqual(result, {
    manualDiscount: 49.6,
    automaticGlobalDiscount: 12.4,
    totalDiscount: 62,
    total: 8,
  });
});

console.log("Alle WaWi-Dauerrabatt-Preisregressionstests bestanden.");
