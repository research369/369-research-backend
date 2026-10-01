import assert from "node:assert/strict";
import test from "node:test";
import {
  DE_ORDER_CONFIRMATION_BODY,
  EN_ORDER_CONFIRMATION_BODY,
  LEGACY_DE_ORDER_CONFIRMATION_BODY,
  LEGACY_EN_ORDER_CONFIRMATION_BODY,
  PREVIOUS_DE_ORDER_CONFIRMATION_BODY,
  PREVIOUS_EN_ORDER_CONFIRMATION_BODY,
} from "./communicationTemplateSchema.js";

test("CRM-Bestellbestätigungen enthalten freigegebene Zahlungsplatzhalter", () => {
  for (const body of [DE_ORDER_CONFIRMATION_BODY, EN_ORDER_CONFIRMATION_BODY]) {
    assert.match(body, /{{paymentDetails}}/);
    assert.match(body, /{{orderId}}/);
  }
  assert.match(DE_ORDER_CONFIRMATION_BODY, /SEPA- oder Echtzeitüberweisung/);
  assert.match(EN_ORDER_CONFIRMATION_BODY, /SEPA or instant bank transfer/);
  assert.match(DE_ORDER_CONFIRMATION_BODY, /Es tut uns leid/);
  assert.match(DE_ORDER_CONFIRMATION_BODY, /Kreditkartenzahlungen können in unserer Branche technisch nicht immer verarbeitet werden/);
  assert.match(DE_ORDER_CONFIRMATION_BODY, /Überweisung funktioniert zuverlässig/);
  assert.match(EN_ORDER_CONFIRMATION_BODY, /We are sorry/);
  assert.match(EN_ORDER_CONFIRMATION_BODY, /card payments may not always be processed successfully in our industry/);
});

test("CRM-Upgrade erkennt ausschließlich die unangetasteten Altvorlagen", () => {
  assert.doesNotMatch(LEGACY_DE_ORDER_CONFIRMATION_BODY, /{{paymentDetails}}/);
  assert.doesNotMatch(LEGACY_EN_ORDER_CONFIRMATION_BODY, /{{paymentDetails}}/);
  assert.notEqual(LEGACY_DE_ORDER_CONFIRMATION_BODY, DE_ORDER_CONFIRMATION_BODY);
  assert.notEqual(LEGACY_EN_ORDER_CONFIRMATION_BODY, EN_ORDER_CONFIRMATION_BODY);
  assert.notEqual(PREVIOUS_DE_ORDER_CONFIRMATION_BODY, DE_ORDER_CONFIRMATION_BODY);
  assert.notEqual(PREVIOUS_EN_ORDER_CONFIRMATION_BODY, EN_ORDER_CONFIRMATION_BODY);
});
