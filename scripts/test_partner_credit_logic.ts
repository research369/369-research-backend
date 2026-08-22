import assert from "node:assert/strict";
import { calculateCommissionAmount, calculateCommissionBase, resolveCommissionAmount } from "../server/partnerCreditService.js";

const order10533Base = calculateCommissionBase({
  subtotal: 140,
  totalProductDiscount: 116.60,
  creditUsed: 102.60,
});
assert.equal(order10533Base, 126.00, "10533: Guthabeneinsatz darf die Guthabenbasis nicht reduzieren");
assert.equal(calculateCommissionAmount({
  subtotal: 140,
  totalProductDiscount: 116.60,
  creditUsed: 102.60,
  commissionPercent: 10,
}), 12.60, "10533: korrektes neues Guthaben");

const order10572Base = calculateCommissionBase({
  subtotal: 130,
  totalProductDiscount: 25.60,
  creditUsed: 12.60,
});
assert.equal(order10572Base, 117.00, "10572: nur der reguläre 10-%-Rabatt reduziert die Guthabenbasis");
assert.equal(calculateCommissionAmount({
  subtotal: 130,
  totalProductDiscount: 25.60,
  creditUsed: 12.60,
  commissionPercent: 10,
}), 11.70, "10572: Guthaben erst nach Zahlung korrekt berechnen");

assert.throws(
  () => calculateCommissionBase({ subtotal: 130, totalProductDiscount: 12, creditUsed: 13 }),
  /Ungültige Rabatt- oder Guthabenwerte/,
  "Ein Guthabeneinsatz darf den gesamten Produktrabatt nicht übersteigen",
);

assert.equal(resolveCommissionAmount({
  subtotal: 926,
  totalProductDiscount: 44.60,
  creditUsed: 0,
  commissionPercent: 10,
}, 47), 47, "Bestellgebundene, freigegebene Guthabenhöhe überschreibt die Standardformel erst bei Zahlung");

console.log("Partner credit logic regression checks passed");
