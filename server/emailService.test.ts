import assert from "node:assert/strict";
import test from "node:test";
import { getOrderConfirmationPresentation } from "./emailService.js";

const baseOrder = {
  orderId: "369-10607",
  customer: {
    firstName: "Ada",
    lastName: "Test",
    email: "ada@example.test",
    phone: "000000000",
    street: "Musterstraße",
    houseNumber: "12",
    zip: "10115",
    city: "Berlin",
    country: "DE",
  },
  items: [{ name: "BPC-157", variant: "5 mg", price: 28, quantity: 1 }],
  subtotal: 28,
  discount: 0,
  shipping: 8,
  total: 36,
  paymentMethod: "wise",
};

test("Peps4pets-Bestellmail nutzt P4P-Referenz mit vorläufigem Coreversand-Absenderprofil", () => {
  const presentation = getOrderConfirmationPresentation({
    ...baseOrder,
    storeKey: "peps4pets",
    externalOrderReference: "P4P-1101",
  });

  assert.ok(presentation);
  assert.equal(presentation.subject, "Bestellbestätigung P4P-1101 – Peps4pets");
  assert.equal(presentation.profile?.from, "369 Research <noreply@coreversand.de>");
  assert.equal(presentation.profile?.senderEmail, "noreply@coreversand.de");
  assert.equal(presentation.profile?.replyTo, "support@369research.eu");
  assert.match(presentation.html, /P4P-1101/);
  assert.match(presentation.html, /SEPA- oder Echtzeitüberweisung \(Wise\)/);
  assert.doesNotMatch(presentation.html, /369-10607/);
});

test("bestehende 369-Bestellmail bleibt auf kanonischer Referenz und ohne P4P-Profil", () => {
  const presentation = getOrderConfirmationPresentation(baseOrder);

  assert.ok(presentation);
  assert.equal(presentation.subject, "Bestellbestätigung 369-10607 – 369 Research");
  assert.equal(presentation.profile, undefined);
  assert.match(presentation.html, /369-10607/);
});

test("eine P4P-Bestellmail ohne externe Referenz wird nicht vorbereitet", () => {
  assert.equal(getOrderConfirmationPresentation({ ...baseOrder, storeKey: "peps4pets" }), null);
});
