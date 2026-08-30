import assert from "node:assert/strict";
import test from "node:test";
import { intelligentMatch } from "./bunqService.js";

const payment = (description: string, amount = "36.00") => ({
  id: 1,
  amount: { value: amount, currency: "EUR" },
  description,
  counterpartyAlias: { type: "IBAN", value: "DE0012345678", name: "Alex Beispiel" },
  created: "2026-08-30T00:00:00.000Z",
  type: "MASTERCARD",
  subType: "PAYMENT",
});

test("P4P-Kundenreferenz wird für die Zahlungszuordnung neben der WaWi-Nummer erkannt", () => {
  const result = intelligentMatch({
    orderId: "369-10607",
    externalOrderReference: "P4P-1101",
    firstName: "Alex",
    lastName: "Beispiel",
    total: "36.00",
  }, [payment("P4P 1101")]);

  assert.equal(result.orderNumberMatch, true);
  assert.equal(result.confidence, "high");
});

test("bestehende kanonische 369-Referenz bleibt für die Zahlungszuordnung gültig", () => {
  const result = intelligentMatch({
    orderId: "369-10607",
    firstName: "Alex",
    lastName: "Beispiel",
    total: "36.00",
  }, [payment("369 10607")]);

  assert.equal(result.orderNumberMatch, true);
  assert.equal(result.confidence, "high");
});
