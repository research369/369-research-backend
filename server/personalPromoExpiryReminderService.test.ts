import assert from "node:assert/strict";
import test from "node:test";
import {
  PERSONAL_PROMO_EXPIRY_REMINDER_DAYS,
  calculatePersonalPromoExpiryReminderSchedule,
  createPersonalPromoExpiryReminder,
} from "./personalPromoExpiryReminderService.js";

const NOW = new Date("2026-10-02T10:00:00.000Z");

test("order-issued code reminder is due exactly ten days before end-of-day expiry", () => {
  assert.equal(PERSONAL_PROMO_EXPIRY_REMINDER_DAYS, 10);
  const schedule = calculatePersonalPromoExpiryReminderSchedule(new Date("2026-10-22T00:00:00.000Z"), NOW);
  assert.ok(schedule);
  assert.equal(schedule.expiresAt.toISOString(), "2026-10-22T23:59:59.999Z");
  assert.equal(schedule.dueAt.toISOString(), "2026-10-12T23:59:59.999Z");
});

test("unlimited and already expired order-issued codes do not create reminders", () => {
  assert.equal(calculatePersonalPromoExpiryReminderSchedule(null, NOW), null);
  assert.equal(calculatePersonalPromoExpiryReminderSchedule(new Date("2026-10-01T00:00:00.000Z"), NOW), null);
});

test("queue creation stores one internal reminder without sending a customer message", async () => {
  const calls: Array<{ query: string; values?: unknown[] }> = [];
  const result = await createPersonalPromoExpiryReminder({
    query: async (query, values) => {
      calls.push({ query, values });
      return { rowCount: 1 };
    },
  }, {
    promoCodeId: 77,
    customerId: 101,
    originOrderId: "369-11125",
    code: "483921",
    validUntil: new Date("2026-10-22T00:00:00.000Z"),
  }, NOW);

  assert.equal(result.created, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].query, /INSERT INTO personal_promo_expiry_reminders/);
  assert.match(calls[0].query, /ON CONFLICT \(promo_code_id\) DO NOTHING/);
  assert.deepEqual(calls[0].values?.slice(0, 4), [77, 101, "369-11125", "483921"]);
});
