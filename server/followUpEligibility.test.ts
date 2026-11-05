import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateFollowUpShipmentWindow,
  FOLLOWUP_MAX_SHIPMENT_AGE_DAYS,
  isFollowUpShipmentEligible,
} from "./followUpEligibility.js";

const NOW = new Date("2026-09-29T12:00:00.000Z");

test("follow-up window covers due shipments from the last ten days only", () => {
  const window = calculateFollowUpShipmentWindow(NOW, 7);
  assert.equal(FOLLOWUP_MAX_SHIPMENT_AGE_DAYS, 10);
  assert.equal(window.eligibleFrom.toISOString(), "2026-09-19T12:00:00.000Z");
  assert.equal(window.dueBy.toISOString(), "2026-09-22T12:00:00.000Z");

  assert.equal(isFollowUpShipmentEligible(new Date("2026-09-19T12:00:00.000Z"), NOW, 7), true);
  assert.equal(isFollowUpShipmentEligible(new Date("2026-09-22T12:00:00.000Z"), NOW, 7), true);
  assert.equal(isFollowUpShipmentEligible(new Date("2026-09-19T11:59:59.999Z"), NOW, 7), false);
  assert.equal(isFollowUpShipmentEligible(new Date("2026-09-22T12:00:00.001Z"), NOW, 7), false);
});

test("unshipped orders are never follow-up candidates", () => {
  assert.equal(isFollowUpShipmentEligible(null, NOW, 7), false);
  assert.equal(isFollowUpShipmentEligible(undefined, NOW, 7), false);
});
