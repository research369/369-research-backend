import assert from "node:assert/strict";
import test from "node:test";
import {
  toPublicBankTransferPresentation,
  toReleasedBankTransferInstructions,
  type BankTransferPaymentInstructionsConfig,
} from "./paymentInstructionsConfig.js";

const config: BankTransferPaymentInstructionsConfig = {
  enabled: true,
  checkoutLabelDe: "SEPA- & Echtzeitüberweisung",
  checkoutLabelEn: "SEPA & instant transfer",
  checkoutHintDe: "Zwei Konten nach Bestellung.",
  checkoutHintEn: "Two accounts after order.",
  accounts: [{
    id: "test-account",
    labelDe: "Testbank",
    labelEn: "Test bank",
    accountHolder: "369 Research",
    iban: "DE00123456789012345678",
    bic: "TESTDEFFXXX",
  }],
};

test("öffentliche Überweisungspräsentation enthält keine Kontodaten", () => {
  const presentation = toPublicBankTransferPresentation(config);
  assert.ok(presentation);
  assert.equal(presentation.accountCount, 1);
  assert.doesNotMatch(JSON.stringify(presentation), /IBAN|DE00123456789012345678|TESTDEFFXXX|369 Research/);
});

test("Kontodaten werden ausschließlich in der Bestellfreigabe bereitgestellt", () => {
  const released = toReleasedBankTransferInstructions(config);
  assert.ok(released);
  assert.equal(released.accounts[0].iban, "DE00123456789012345678");
  assert.equal(released.accounts[0].bic, "TESTDEFFXXX");
});
