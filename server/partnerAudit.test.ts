import test from "node:test";
import assert from "node:assert/strict";
import { auditCommissionRow } from "./partnerAudit.js";
const now = Date.parse("2026-10-16T02:00:00Z");
const row = {
  resolved_partner_id: 7,
  partner_source_id: 7,
  code_partner_id: 7,
  partner_number: null,
  status: "bezahlt",
  paid_at: "2026-10-15T12:00:00Z",
  policy: "each_paid_code_order",
  expected_amount: "18",
  commission_base: "90",
  commission_percent: "20",
  override_amount: null,
  entries: [],
  paid_rank: 1,
  reversed_count: 0,
};
test("whole-history commission audit catches missing, wrong amount/recipient, duplicates and corrupt snapshots", () => {
  assert.equal(auditCommissionRow(row, now).kind, "missing");
  assert.equal(
    auditCommissionRow({ ...row, entries: [{ partnerId: 7, amount: 18 }] }, now)
      .kind,
    "booked",
  );
  assert.equal(
    auditCommissionRow({ ...row, entries: [{ partnerId: 7, amount: 9 }] }, now)
      .kind,
    "amount_mismatch",
  );
  assert.equal(
    auditCommissionRow({ ...row, entries: [{ partnerId: 8, amount: 18 }] }, now)
      .kind,
    "wrong_recipient",
  );
  assert.equal(
    auditCommissionRow(
      {
        ...row,
        entries: [
          { partnerId: 7, amount: 9 },
          { partnerId: 7, amount: 9 },
        ],
      },
      now,
    ).kind,
    "duplicate",
  );
  assert.equal(
    auditCommissionRow(
      { ...row, expected_amount: 19, entries: [{ partnerId: 7, amount: 19 }] },
      now,
    ).kind,
    "snapshot_mismatch",
  );
  assert.equal(
    auditCommissionRow(
      {
        ...row,
        override_amount: 19,
        expected_amount: 19,
        entries: [{ partnerId: 7, amount: 19 }],
      },
      now,
    ).kind,
    "booked",
  );
});
test("first paid entitlement is chronological, never suppressed for an unbooked first order by later paid orders", () => {
  const first = { ...row, policy: "first_paid_code_order", paid_rank: 1 };
  assert.equal(auditCommissionRow(first, now).kind, "missing");
  assert.equal(
    auditCommissionRow({ ...first, paid_rank: 2 }, now).kind,
    "not_due",
  );
  assert.equal(
    auditCommissionRow(
      { ...first, paid_rank: 2, entries: [{ partnerId: 7, amount: 18 }] },
      now,
    ).kind,
    "amount_mismatch",
  );
  assert.equal(
    auditCommissionRow({ ...first, paid_rank: 2, partner_number: "P-OWN" }, now)
      .kind,
    "missing",
  );
});
test("payment grace, inactive payments, reversals and historical uncertainty never become false green", () => {
  assert.equal(
    auditCommissionRow({ ...row, paid_at: new Date(now - 60000) }, now).kind,
    "pending",
  );
  assert.equal(
    auditCommissionRow({ ...row, status: "storniert", entries: [] }, now).kind,
    "not_paid",
  );
  assert.equal(
    auditCommissionRow(
      { ...row, status: "storniert", entries: [{ partnerId: 7, amount: 18 }] },
      now,
    ).kind,
    "unexpected_booking",
  );
  assert.equal(
    auditCommissionRow({ ...row, policy: null, expected_amount: 0 }, now)
      .severity,
    "review",
  );
  assert.equal(
    auditCommissionRow({ ...row, reversed_count: 1 }, now).kind,
    "reversed_paid",
  );
  assert.equal(
    auditCommissionRow({ ...row, resolved_partner_id: null }, now).kind,
    "unattributed_order",
  );
});

test("legacy shipped orders without payment timestamp or saved rule remain uncertain, not proven financial errors", () => {
  const legacy = {
    ...row,
    status: "versendet",
    paid_at: null,
    policy: null,
    entries: [{ partnerId: 7, amount: 18 }],
  };
  assert.equal(auditCommissionRow(legacy, now).kind, "legacy_unknown");
  assert.equal(auditCommissionRow(legacy, now).severity, "review");
  assert.equal(
    auditCommissionRow({ ...legacy, policy: "each_paid_code_order" }, now)
      .severity,
    "error",
  );
});
