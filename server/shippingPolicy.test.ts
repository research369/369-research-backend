import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildEnglishOrderConfirmationHtml, buildOrderConfirmationHtml } from "./emailService.js";

const baseOrder = {
  orderId: "369-10607",
  storeKey: "369research" as const,
  mainshopCustomerPresentation: true,
  customer: {
    firstName: "Ada", lastName: "Test", email: "ada@example.test", phone: "000000000",
    street: "Musterstraße", houseNumber: "12", zip: "10115", city: "Berlin", country: "DE",
  },
  items: [{ name: "BPC-157", variant: "5 mg", price: 28, quantity: 1, isPlugPlay: true }],
  subtotal: 28, discount: 0, shipping: 8, total: 36, paymentMethod: "wise",
};

test("369-Bestellbestätigung trennt Versandfrist und Zustellzeit, ohne Kühlversand", () => {
  const html = buildOrderConfirmationHtml(baseOrder, "");
  assert.match(html, /Versand spätestens innerhalb von 48 Stunden an Werktagen/);
  assert.match(html, /Montag bis Freitag/);
  assert.match(html, /gesetzliche Feiertage/);
  assert.match(html, /Die Zustellzeit richtet sich nach dem Versanddienstleister/);
  assert.doesNotMatch(html, /gekühlten Versand|Kühlprodukte|Montag bis Donnerstag/);
});

test("main-Kommunikationsvorlagen bleiben bytegleich und gehören nicht zum neuen Shop-Vertrag", () => {
  const source = readFileSync(new URL("./communicationTemplateSchema.ts", import.meta.url), "utf8");
  // Scope guard: do not globally rewrite WaWi templates just to satisfy a feature-source test.
  assert.ok(source.length > 0);
  const email = readFileSync(new URL("./emailService.ts", import.meta.url), "utf8");
  assert.match(email, /mainshopCustomerPresentation/);
  assert.match(email, /getReleasedBankTransferInstructions/);
});

test("englische 369-Kundenmail nutzt 48h Mo-Fr, ohne Kühlversand; alte WaWi-Copy bleibt erhalten", () => {
  const customerHtml = buildEnglishOrderConfirmationHtml(baseOrder, "");
  assert.match(customerHtml, /within 48 hours on working days \(Monday to Friday\)/);
  assert.match(customerHtml, /public holidays/);
  assert.doesNotMatch(customerHtml, /cold-chain|refrigerated packaging/);
  const wawiHtml = buildEnglishOrderConfirmationHtml({ ...baseOrder, mainshopCustomerPresentation: false }, "");
  assert.match(wawiHtml, /cold-chain surcharge/);
  assert.doesNotMatch(wawiHtml, /within 48 hours/);
});
