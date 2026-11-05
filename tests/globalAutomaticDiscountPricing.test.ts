import assert from "node:assert/strict";
import {
  calculateAutomaticGlobalDiscount,
  calculateAuthoritativeKwkOrder,
  calculatePromoDiscount,
} from "../server/kwkCheckoutPricing.js";
import {
  getActiveGlobalAutomaticDiscount,
  parseGlobalAutomaticDiscountConfig,
} from "../server/globalAutomaticDiscountConfig.js";
import { calculateCommissionAmount } from "../server/partnerCreditService.js";

const now = new Date("2026-09-07T10:00:00.000Z");

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

test("fehlende oder ungültige Konfiguration deaktiviert den Dauerrabatt sicher", () => {
  assert.equal(parseGlobalAutomaticDiscountConfig(undefined).enabled, false);
  assert.equal(parseGlobalAutomaticDiscountConfig("{").enabled, false);
});

test("eine gültige Konfiguration ist bis unmittelbar vor dem exakten Endzeitpunkt aktiv", () => {
  const config = parseGlobalAutomaticDiscountConfig(JSON.stringify({
    enabled: true,
    percentage: 12.5,
    expiresAt: "2026-09-07T10:00:00.000Z",
    stackWithPromotionCodes: true,
    labelDe: "Dauerrabatt",
    labelEn: "Automatic discount",
  }));
  assert.equal(getActiveGlobalAutomaticDiscount(config, new Date("2026-09-07T09:59:59.999Z"))?.percentage, 12.5);
  assert.equal(getActiveGlobalAutomaticDiscount(config, now), null);
});

test("der Dauerrabatt betrifft nur den Warenwert und respektiert die 100-Prozent-Grenze", () => {
  assert.equal(calculateAutomaticGlobalDiscount(123.45, 10), 12.35);
  assert.equal(calculateAutomaticGlobalDiscount(123.45, 100), 123.45);
  assert.equal(calculateAutomaticGlobalDiscount(123.45, 101), 123.45);
});

test("ein Prozentcode wird nach dem Dauerrabatt auf den verbleibenden Warenwert berechnet", () => {
  const codeDiscount = calculatePromoDiscount({
    subtotal: 100,
    items: [{ shopProductId: "bpc-157", price: 100, quantity: 1 }],
    promo: { discountType: "percent", percentage: 10, fixedAmount: 0 },
    precedingProductDiscount: 10,
  });
  assert.equal(codeDiscount, 9);
});

test("ein eingeschränkter Festbetragscode wird nach dem Dauerrabatt am verbleibenden berechtigten Wert gedeckelt", () => {
  const codeDiscount = calculatePromoDiscount({
    subtotal: 100,
    items: [
      { shopProductId: "bpc-157", price: 40, quantity: 1 },
      { shopProductId: "tb-500", price: 60, quantity: 1 },
    ],
    promo: {
      discountType: "fixed",
      percentage: 0,
      fixedAmount: 50,
      description: "BPC Aktion | {\"restrict\":[\"bpc-157\"],\"freeShipping\":[]}",
    },
    precedingProductDiscount: 10,
  });
  assert.equal(codeDiscount, 36);
});

test("das Partnerguthaben entsteht nur aus dem Warenwert nach Dauerrabatt und Eigenrabatt", () => {
  const credit = calculateCommissionAmount({
    subtotal: 100,
    // 10 € Dauerrabatt + 9 € Partnereigenrabatt auf den verbleibenden Warenwert
    totalProductDiscount: 19,
    creditUsed: 0,
    commissionPercent: 10,
  });
  assert.equal(credit, 8.1);
});

test("Dauerrabatt, Code, KWK und KWK-Guthaben folgen einer transparenten Reihenfolge bei unverändertem Versand", () => {
  const result = calculateAuthoritativeKwkOrder({
    subtotal: 100,
    shipping: 8,
    globalDiscount: 10,
    promoDiscount: 9,
    applyReferralDiscount: true,
    kwkCreditUsed: 81,
  });
  assert.deepEqual(result, {
    globalDiscount: 10,
    promoDiscount: 9,
    kwkDiscount: 8.1,
    kwkCreditUsed: 72.9,
    totalDiscount: 100,
    total: 8,
  });
});

console.log("Alle Dauerrabatt-Preisregressionstests bestanden.");
