import assert from "node:assert/strict";
import test from "node:test";
import { calculateCustomerOrderMetrics } from "./customerOrderMetrics.js";

test("CRM metrics count only directly assigned active orders", () => {
  const metrics = calculateCustomerOrderMetrics([
    { total: "100.00", status: "bezahlt", orderDate: new Date("2026-01-04T10:00:00.000Z") },
    { total: "30.00", status: "offen", orderDate: new Date("2026-02-05T10:00:00.000Z") },
    { total: "0.00", status: "versendet", orderDate: new Date("2026-02-08T10:00:00.000Z") },
    { total: "90.00", status: "storniert", orderDate: new Date("2026-03-06T10:00:00.000Z") },
  ]);

  assert.equal(metrics.totalOrders, 2);
  assert.equal(metrics.totalSpent, 130);
  assert.equal(metrics.firstOrderDate?.toISOString(), "2026-01-04T10:00:00.000Z");
  assert.equal(metrics.lastOrderDate?.toISOString(), "2026-02-05T10:00:00.000Z");
});

test("CRM metrics remain empty when only cancelled orders are assigned", () => {
  const metrics = calculateCustomerOrderMetrics([
    { total: "90.00", status: "storniert", orderDate: new Date("2026-03-06T10:00:00.000Z") },
  ]);

  assert.deepEqual(metrics, {
    totalOrders: 0,
    totalSpent: 0,
    firstOrderDate: null,
    lastOrderDate: null,
  });
});
