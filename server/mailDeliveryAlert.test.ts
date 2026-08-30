import assert from "node:assert/strict";
import test from "node:test";
import { buildDeliveryFailureAlert, shouldAlertOnDeliveryEvent } from "./mailDeliveryAlert.js";

test("Zustellwarnung erfasst nur nicht zugestellte Kundenmailereignisse", () => {
  assert.equal(shouldAlertOnDeliveryEvent("email.bounced"), true);
  assert.equal(shouldAlertOnDeliveryEvent("email.failed"), true);
  assert.equal(shouldAlertOnDeliveryEvent("email.suppressed"), true);
  assert.equal(shouldAlertOnDeliveryEvent("email.delivery_delayed"), true);
  assert.equal(shouldAlertOnDeliveryEvent("email.delivered"), false);
  assert.equal(shouldAlertOnDeliveryEvent("email.opened"), false);
});

test("Zustellwarnung enthält nur prüfungsrelevante Metadaten und keinen Kundenmailinhalt", () => {
  const alert = buildDeliveryFailureAlert({
    providerEventId: "evt-123",
    eventType: "email.bounced",
    occurredAt: new Date("2026-08-30T08:00:00.000Z"),
    orderId: "369-10608",
    recipientEmail: "kunde@example.de",
    subject: "Bestellbestätigung P4P-1102 – Peps4pets",
    errorMessage: "Mailbox unavailable",
  });

  assert.match(alert.subject, /369-10608/);
  assert.match(alert.text, /kunde@example\.de/);
  assert.match(alert.html, /Bestellbestätigung P4P-1102/);
  assert.doesNotMatch(alert.text, /<body>|Produktinhalt|Zahlungsdetails/);
});
