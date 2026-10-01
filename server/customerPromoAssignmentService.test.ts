import assert from "node:assert/strict";
import test from "node:test";
import {
  getEffectivePersonalPromoUseLimit,
  getPersonalPromoContact,
  hasPersonalPromoContact,
  matchesPersonalPromoContact,
} from "./customerPromoAssignmentService.js";

test("persönliche Aktionscodes matchen ausschließlich normalisierte E-Mail oder Telefonnummer", () => {
  const assignment = {
    emailNormalized: "muna@example.com",
    phoneNormalized: "491701234567",
  };

  assert.equal(matchesPersonalPromoContact(assignment, { email: " MUNA@EXAMPLE.COM " }), true);
  assert.equal(matchesPersonalPromoContact(assignment, { phone: "0170 123 4567" }), true);
  assert.equal(matchesPersonalPromoContact(assignment, { email: "andere@example.com", phone: "01709999999" }), false);
  assert.equal(matchesPersonalPromoContact(assignment, { email: undefined, phone: undefined }), false);
});

test("die Kontaktbindung benötigt mindestens eine ausstellungszeitlich erfasste Kennung", () => {
  assert.equal(hasPersonalPromoContact({ email: "", phone: "" }), false);
  assert.deepEqual(getPersonalPromoContact({ email: " Test@Example.com ", phone: "0170 123 45 67" }), {
    emailNormalized: "test@example.com",
    phoneNormalized: "491701234567",
  });
});

test("das persönliche Nutzungslimit ist stets die strengere konfigurierte Grenze", () => {
  assert.equal(getEffectivePersonalPromoUseLimit(0, 0), 0);
  assert.equal(getEffectivePersonalPromoUseLimit(5, 0), 5);
  assert.equal(getEffectivePersonalPromoUseLimit(0, 1), 1);
  assert.equal(getEffectivePersonalPromoUseLimit(5, 1), 1);
});
