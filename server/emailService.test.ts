import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEnglishOrderConfirmationHtml,
  buildOrderConfirmationHtml,
  getOrderConfirmationPresentation,
} from "./emailService.js";

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

test("Peps4pets-Bestellmail nutzt P4P-Referenz mit vorläufigem Coreversand-Absenderprofil", async () => {
  const presentation = await getOrderConfirmationPresentation({
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

test("bestehende 369-Bestellmail bleibt auf kanonischer Referenz und ohne P4P-Profil", async () => {
  const presentation = await getOrderConfirmationPresentation(baseOrder);

  assert.ok(presentation);
  assert.equal(presentation.subject, "Bestellbestätigung 369-10607 – 369 Research");
  assert.equal(presentation.profile, undefined);
  assert.match(presentation.html, /369-10607/);
});

test("Bestellmail nennt bei vorhandenen Zahlungsdaten ausschließlich das Wise-Konto", () => {
  const bankDetailsHtml = "<tr><td>Wise</td><td>Bankdaten</td></tr>";
  const german = buildOrderConfirmationHtml(baseOrder, bankDetailsHtml);
  const english = buildEnglishOrderConfirmationHtml({ ...baseOrder, communicationLanguage: "en" }, bankDetailsHtml);

  assert.match(german, /auf <strong>unser Wise-Konto<\/strong> überweisen/);
  assert.match(german, /auf unser Wise-Konto mit dem Verwendungszweck/);
  assert.doesNotMatch(german, /eines der oben genannten Konten/);
  assert.doesNotMatch(german, /eine der folgenden Bankverbindungen/);
  assert.match(english, /to <strong>our Wise bank account<\/strong>/);
  assert.match(english, /to our Wise bank account using/);
  assert.doesNotMatch(english, /one of the bank accounts above/);
  assert.doesNotMatch(english, /one of the following bank accounts/);
});

test("main-Bestellmail verwendet nach Wise-Konsolidierung keine veraltete Karten-Fallback-Copy", async () => {
  const presentation = await getOrderConfirmationPresentation({
    ...baseOrder,
    paymentMethod: "creditCard",
  });

  assert.ok(presentation);
  // Pinned main 2e707fd labels legacy creditCard as Wise; no obsolete fallback body.
  assert.match(presentation.html, /SEPA- oder Echtzeitüberweisung \(Wise\)/);
  assert.doesNotMatch(presentation.html, /Es tut uns leid|Kreditkartenzahlungen können/);
  assert.match(presentation.html, /Verwendungszweck/);
});

test("englische Kommunikation erzeugt eine vollständige englische Bestellbestätigung", async () => {
  const presentation = await getOrderConfirmationPresentation({
    ...baseOrder,
    communicationLanguage: "en",
    paymentMethod: "creditCard",
  });

  assert.ok(presentation);
  assert.equal(presentation.subject, "Order confirmation 369-10607 – 369 Research");
  assert.match(presentation.html, /<html lang="en">/);
  assert.match(presentation.html, /Important payment notice/);
  assert.match(presentation.html, /Payment information/);
  // Preserve current main payment wording, not the earlier branch expectation.
  assert.match(presentation.html, /SEPA or instant bank transfer \(Wise\)/);
  assert.doesNotMatch(presentation.html, /Card payment \(Bunq\)|card payments cannot always/);
  assert.doesNotMatch(presentation.html, /Bestellbestätigung/);
});

test("eine P4P-Bestellmail ohne externe Referenz wird nicht vorbereitet", async () => {
  assert.equal(await getOrderConfirmationPresentation({ ...baseOrder, storeKey: "peps4pets" }), null);
});
