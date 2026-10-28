import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getOrderConfirmationPresentation } from "./emailService.js";

const baseOrder = {
  orderId: "369-10607",
  customer: {
    firstName: "Ada",
    lastName: "Test",
    email: "ada@example.test",
    phone: "000000000",
    street: "Musterstraße",
    houseNumber: "12",
    zip: "10115",
    city: "Berlin",
    country: "DE",
  },
  items: [{ name: "BPC-157", variant: "5 mg", price: 28, quantity: 1 }],
  subtotal: 28,
  discount: 0,
  shipping: 8,
  total: 36,
  paymentMethod: "wise",
};

test("369-Bestellbestätigung trennt Versandfrist und Zustellzeit", () => {
  const presentation = getOrderConfirmationPresentation(baseOrder);

  assert.ok(presentation);
  assert.match(presentation.html, /Versand spätestens innerhalb von 48 Stunden an Werktagen/);
  assert.match(presentation.html, /Die Zustellzeit richtet sich nach dem Versanddienstleister/);
});

test("Kommunikationsvorlagen verwenden die 48-Stunden-Versandregel ohne feste Zustellprognose", () => {
  const source = readFileSync(new URL("./communicationTemplateSchema.ts", import.meta.url), "utf8");

  assert.match(source, /Versand spätestens innerhalb von 48 Stunden an Werktagen/);
  assert.match(source, /Orders are dispatched no later than 48 hours on business days/);
  assert.doesNotMatch(source, /(?:1[–-]3|2[–-]4|3[–-]5|5[–-]7)\s*(?:Werktage|business days)/i);
});

test("Backend-Versandmail enthält keine alte Kühlversand- oder Zustellzeitcopy", () => {
  const source = readFileSync(new URL("./emailService.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /gek\\u00fchlten Versand|gekühlten Versand/i);
  assert.doesNotMatch(source, /Voraussichtliche Lieferzeit/i);
});
