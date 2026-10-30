import assert from "node:assert/strict";
import test from "node:test";
import {
  doesCommunicationPhoneVersionMatch,
  normalizeOrderCommunicationPhone,
  ORDER_COMMUNICATION_PHONE_SCHEMA_SQL,
  resolveEffectiveCommunicationPhoneFromEvent,
} from "./orderCommunicationPhoneService.js";

test("Kommunikationsnummer normalisiert lokale und internationale Schreibweisen nach E.164", () => {
  assert.equal(normalizeOrderCommunicationPhone("0176 123 45678"), "+4917612345678");
  assert.equal(normalizeOrderCommunicationPhone("0043 664 1234567"), "+436641234567");
  assert.equal(normalizeOrderCommunicationPhone("+44 20 7946 0018"), "+442079460018");
  assert.equal(normalizeOrderCommunicationPhone("123"), null);
  assert.equal(normalizeOrderCommunicationPhone(""), null);
});

test("Kommunikations-Override ersetzt nur den Nachrichtenempfänger, nicht den Bestellsnapshot", () => {
  const snapshot = resolveEffectiveCommunicationPhoneFromEvent("369-1", "0176 123 45678", null);
  assert.deepEqual(snapshot, {
    orderId: "369-1",
    orderPhone: "0176 123 45678",
    effectivePhone: "0176 123 45678",
    source: "order_snapshot",
    latestEventId: null,
  });

  const override = resolveEffectiveCommunicationPhoneFromEvent("369-1", "0176 123 45678", {
    id: 9,
    action: "set",
    phone_e164: "+4915112345678",
  });
  assert.equal(override.orderPhone, "0176 123 45678");
  assert.equal(override.effectivePhone, "+4915112345678");
  assert.equal(override.source, "order_override");
  assert.equal(override.latestEventId, 9);

  const cleared = resolveEffectiveCommunicationPhoneFromEvent("369-1", "0176 123 45678", {
    id: 10,
    action: "clear",
    phone_e164: null,
  });
  assert.equal(cleared.effectivePhone, "0176 123 45678");
  assert.equal(cleared.source, "order_snapshot");
  assert.equal(cleared.latestEventId, 10);
});

test("Kommunikationsnummernkorrektur vergleicht auch den leeren Erstzustand strikt", () => {
  assert.equal(doesCommunicationPhoneVersionMatch(null, null), true);
  assert.equal(doesCommunicationPhoneVersionMatch(null, 1), false);
  assert.equal(doesCommunicationPhoneVersionMatch(1, null), false);
  assert.equal(doesCommunicationPhoneVersionMatch(1, 2), false);
  assert.equal(doesCommunicationPhoneVersionMatch(2, 2), true);
});

test("Kommunikationsnummern-Audit überlebt eine Auftragslöschung und erlaubt keine Mutation", () => {
  assert.match(ORDER_COMMUNICATION_PHONE_SCHEMA_SQL, /order_id VARCHAR\(32\) NOT NULL,/);
  assert.doesNotMatch(ORDER_COMMUNICATION_PHONE_SCHEMA_SQL, /REFERENCES orders\(order_id\)/);
  assert.match(ORDER_COMMUNICATION_PHONE_SCHEMA_SQL, /BEFORE UPDATE OR DELETE ON order_communication_phone_override_events/);
  assert.match(ORDER_COMMUNICATION_PHONE_SCHEMA_SQL, /append-only/);
});
