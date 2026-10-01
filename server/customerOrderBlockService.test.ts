import assert from "node:assert/strict";
import test from "node:test";
import {
  CUSTOMER_ORDER_BLOCKED_CODE,
  getBlockIdentifiers,
  hasUsableBlockIdentifier,
  isActiveBlockMatch,
  normalizeBlockedEmail,
  normalizeBlockedPhone,
} from "./customerOrderBlockService.js";

test("only a real e-mail or phone can activate a customer-specific block", () => {
  assert.equal(hasUsableBlockIdentifier({ email: "keine@angabe.de", phone: "" }), false);
  assert.equal(hasUsableBlockIdentifier({ email: "", phone: "123" }), false);
  assert.equal(hasUsableBlockIdentifier({ email: "muna@example.de", phone: "" }), true);
  assert.equal(hasUsableBlockIdentifier({ email: "", phone: "+49 171 1234567" }), true);
});

test("block matching normalizes formatting but never uses a name or address", () => {
  const block = {
    status: "active" as const,
    emailNormalized: normalizeBlockedEmail("Muna@Example.DE"),
    phoneNormalized: normalizeBlockedPhone("0171 1234567"),
  };

  assert.equal(isActiveBlockMatch(block, { email: "muna@example.de" }), true);
  assert.equal(isActiveBlockMatch(block, { phone: "+49 (171) 123-4567" }), true);
  assert.equal(isActiveBlockMatch(block, { email: "different@example.de", phone: "+49 172 9999999" }), false);
  assert.equal(isActiveBlockMatch({ ...block, status: "revoked" }, { email: "muna@example.de" }), false);
  assert.equal(getBlockIdentifiers({ email: "  Muna@Example.DE ", phone: "0171 1234567" }).emailNormalized, "muna@example.de");
  assert.equal(CUSTOMER_ORDER_BLOCKED_CODE, "CUSTOMER_ORDER_BLOCKED");
});
