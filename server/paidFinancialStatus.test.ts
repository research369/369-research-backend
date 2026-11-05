import assert from "node:assert/strict";
import test from "node:test";
import { isFinanciallyPaidStatus } from "./paidFinancialStatus.js";

test("all paid fulfilment states retain idempotent financial processing", () => {
  for (const status of ["bezahlt", "gepackt", "versendet", "zugestellt", "abgeholt"]) {
    assert.equal(isFinanciallyPaidStatus(status), true, status);
  }
});

test("open and cancelled orders never release pending financial credits", () => {
  assert.equal(isFinanciallyPaidStatus("offen"), false);
  assert.equal(isFinanciallyPaidStatus("storniert"), false);
});
