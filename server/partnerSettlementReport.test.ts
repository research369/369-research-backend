import assert from "node:assert/strict";
import test from "node:test";
import { buildPartnerSettlementReport } from "./partnerSettlementReport.js";

const order = (overrides: Partial<Parameters<typeof buildPartnerSettlementReport>[0]["orders"][number]> = {}) => ({
  orderId: "369-10001",
  customerName: "Kunde Eins",
  orderDate: "2026-10-01T10:00:00.000Z",
  subtotal: 100,
  discount: 10,
  total: 90,
  status: "bezahlt",
  paidAt: "2026-10-01T10:15:00.000Z",
  appliedPartnerCode: "KASRA10",
  partnerCodeIdSnapshot: 1,
  partnerDiscount: 10,
  partnerCommission: 9,
  partnerCommissionPercentSnapshot: 10,
  partnerCustomerDiscountPercentSnapshot: 10,
  partnerCommissionBaseSnapshot: 90,
  items: [],
  ...overrides,
});

const transaction = (overrides: Partial<Parameters<typeof buildPartnerSettlementReport>[0]["transactions"][number]> = {}) => ({
  id: 1,
  partnerId: 8,
  type: "provision" as const,
  amount: 9,
  balanceAfter: 9,
  orderId: "369-10001",
  customerName: "Kunde Eins",
  description: "Provision",
  status: "normal" as const,
  adminNote: null,
  createdAt: "2026-10-01T10:16:00.000Z",
  ...overrides,
});

test("builds one complete settlement view from orders and the ledger", () => {
  const report = buildPartnerSettlementReport({
    currentBalance: 4,
    orders: [
      order(),
      order({
        orderId: "369-10002",
        orderDate: "2026-10-06T10:00:00.000Z",
        status: "offen",
        paidAt: null,
        total: 60,
        partnerCommission: 6,
      }),
    ],
    transactions: [
      transaction(),
      transaction({
        id: 2,
        type: "einloesung",
        amount: -3,
        balanceAfter: 6,
        orderId: "369-10003",
        createdAt: "2026-10-02T10:00:00.000Z",
      }),
      transaction({
        id: 3,
        type: "auszahlung",
        amount: -2,
        balanceAfter: 4,
        orderId: null,
        createdAt: "2026-10-03T10:00:00.000Z",
      }),
      transaction({
        id: 4,
        type: "korrektur",
        amount: 1,
        balanceAfter: 5,
        orderId: null,
        createdAt: "2026-10-04T10:00:00.000Z",
      }),
      transaction({
        id: 5,
        type: "provision",
        amount: 999,
        balanceAfter: 1003,
        orderId: "369-removed",
        status: "storniert",
      }),
    ],
  });

  assert.deepEqual(report.summary, {
    totalOrders: 2,
    paidOrders: 1,
    openOrders: 1,
    totalOrderValue: 150,
    paidOrderValue: 90,
    totalPartnerDiscount: 20,
    totalCommissionEarned: 9,
    totalRedeemed: 3,
    totalPaidOut: 2,
    totalAdjustments: 1,
    currentBalance: 4,
    pendingCommission: 6,
    paidUnbookedCommission: 0,
    paidUnbookedOrderCount: 0,
    excludedTransactionCount: 1,
  });
  assert.equal(report.orders[0].commissionBookingStatus, "gebucht");
  assert.equal(report.orders[1].commissionBookingStatus, "zahlungsbestaetigung_ausstehend");
  assert.equal(report.periods.monthly.length, 1);
  assert.deepEqual(report.periods.monthly[0], {
    key: "2026-10",
    label: "Oktober 2026",
    orderCount: 2,
    paidOrderCount: 1,
    orderValue: 150,
    paidOrderValue: 90,
    commissionBooked: 9,
    creditRedeemed: 3,
    payouts: 2,
    adjustments: 1,
    netMovement: 5,
  });
});

test("flags paid orders with an expected but missing commission booking", () => {
  const report = buildPartnerSettlementReport({
    currentBalance: 0,
    orders: [order({ partnerCommission: 8 })],
    transactions: [],
  });

  assert.equal(report.orders[0].commissionBookingStatus, "zu_pruefen");
  assert.equal(report.summary.paidUnbookedOrderCount, 1);
  assert.equal(report.summary.paidUnbookedCommission, 8);
});
