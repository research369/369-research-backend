import assert from "node:assert/strict";
import test from "node:test";
import {
  PARTNER_SUPPORT_CONTACT,
  PARTNER_TECHNICAL_CONTACT,
} from "./partnerContactProfile.js";

test("Partnerkontaktprofile verwenden getrennte, beantwortbare 369-Research-Adressen", () => {
  assert.equal(PARTNER_TECHNICAL_CONTACT.email, "dev@369research.eu");
  assert.equal(PARTNER_TECHNICAL_CONTACT.replyTo, PARTNER_TECHNICAL_CONTACT.email);
  assert.match(PARTNER_TECHNICAL_CONTACT.from, /<dev@369research\.eu>$/);

  assert.equal(PARTNER_SUPPORT_CONTACT.email, "partnersupport@369research.eu");
  assert.equal(PARTNER_SUPPORT_CONTACT.replyTo, PARTNER_SUPPORT_CONTACT.email);
  assert.match(PARTNER_SUPPORT_CONTACT.from, /<partnersupport@369research\.eu>$/);

  assert.notEqual(PARTNER_TECHNICAL_CONTACT.email, PARTNER_SUPPORT_CONTACT.email);
});
