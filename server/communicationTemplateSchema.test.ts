import assert from "node:assert/strict";
import test from "node:test";
import {
  DE_ORDER_CONFIRMATION_BODY,
  EN_ORDER_CONFIRMATION_BODY,
  LEGACY_DE_ORDER_CONFIRMATION_BODY,
  LEGACY_EN_ORDER_CONFIRMATION_BODY,
} from "./communicationTemplateSchema.js";

test("CRM-Bestellbestätigungen enthalten freigegebene Zahlungsplatzhalter", () => {
  for (const body of [DE_ORDER_CONFIRMATION_BODY, EN_ORDER_CONFIRMATION_BODY]) {
    assert.match(body, /{{paymentDetails}}/);
    assert.match(body, /{{orderId}}/);
  }
  assert.match(DE_ORDER_CONFIRMATION_BODY, /SEPA- oder Echtzeitüberweisung/);
  assert.match(EN_ORDER_CONFIRMATION_BODY, /SEPA or instant bank transfer/);
});

test("CRM-Upgrade erkennt ausschließlich die unangetasteten Altvorlagen", () => {
  assert.doesNotMatch(LEGACY_DE_ORDER_CONFIRMATION_BODY, /{{paymentDetails}}/);
  assert.doesNotMatch(LEGACY_EN_ORDER_CONFIRMATION_BODY, /{{paymentDetails}}/);
  assert.notEqual(LEGACY_DE_ORDER_CONFIRMATION_BODY, DE_ORDER_CONFIRMATION_BODY);
  assert.notEqual(LEGACY_EN_ORDER_CONFIRMATION_BODY, EN_ORDER_CONFIRMATION_BODY);
});
