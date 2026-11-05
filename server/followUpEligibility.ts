/**
 * Follow-up candidates are intentionally limited to recent shipments.
 * This prevents a historic backlog from resurfacing if the queue is reset or
 * the manual "Neue prüfen" action was not used for an extended period.
 */
export const FOLLOWUP_MAX_SHIPMENT_AGE_DAYS = 10;

export type FollowUpShipmentWindow = {
  /** A shipment must be at least this old to be due for follow-up. */
  dueBy: Date;
  /** A shipment must not be older than this when it is first queued. */
  eligibleFrom: Date;
};

export function calculateFollowUpShipmentWindow(
  now: Date,
  reminderDaysAfterShipping: number,
): FollowUpShipmentWindow {
  return {
    dueBy: new Date(now.getTime() - reminderDaysAfterShipping * 24 * 60 * 60 * 1000),
    eligibleFrom: new Date(now.getTime() - FOLLOWUP_MAX_SHIPMENT_AGE_DAYS * 24 * 60 * 60 * 1000),
  };
}

export function isFollowUpShipmentEligible(
  shippedAt: Date | null | undefined,
  now: Date,
  reminderDaysAfterShipping: number,
): boolean {
  if (!shippedAt) return false;
  const { dueBy, eligibleFrom } = calculateFollowUpShipmentWindow(now, reminderDaysAfterShipping);
  return shippedAt >= eligibleFrom && shippedAt <= dueBy;
}
