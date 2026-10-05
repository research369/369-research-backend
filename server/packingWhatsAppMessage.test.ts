import assert from "node:assert/strict";
import test from "node:test";
import { buildPackingWhatsAppMessage } from "./packingWhatsAppMessage.js";

test("Pack-WhatsApp nutzt ausschließlich die gespeicherte Kommunikationssprache", () => {
  const english = buildPackingWhatsAppMessage({ customerName: "Alex Smith", orderId: "369-11125", communicationLanguage: "en" });
  assert.match(english, /^Hello Alex Smith/);
  assert.match(english, /currently being packed and prepared for shipping/);
  assert.doesNotMatch(english, /dein Paket/);

  const german = buildPackingWhatsAppMessage({ customerName: "Alex Smith", orderId: "369-11125", communicationLanguage: "de" });
  assert.match(german, /^Hallo Alex Smith/);
  assert.match(german, /wird gerade gepackt und für den Versand vorbereitet/);
});
