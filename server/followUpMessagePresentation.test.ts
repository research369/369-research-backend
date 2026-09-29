import assert from "node:assert/strict";
import test from "node:test";
import { generateEmailContent, generateWhatsAppMessage } from "./followUpRouter.js";

const productCopy = "GHK-Cu 50 mg ist ein Beauty- und Regenerations-Favorit für Forschung rund um Hautmatrix, Kollagen, Elastin und Haarfollikel. Wenn du einen gezielten Artikel für Beauty-orientierte Forschungsprojekte suchst, ist das eine klare Ergänzung im Sortiment.";
const selectedProducts = [{
  id: 106,
  name: "GHK-Cu 50 mg",
  sellingPrice: "79.00",
  shopProductId: "ghk-cu",
  category: "Peptide",
  generatedCopy: productCopy,
}];
const order = { firstName: "Oja", orderDate: "2026-09-20T10:00:00.000Z" };
const terms = { discountPercent: 15, codeValidityHours: 72 };

test("WhatsApp follow-up uses the approved direct structure and exact product copy", () => {
  const message = generateWhatsAppMessage(order, selectedProducts, "[DISCOUNT_CODE]", null, terms);
  assert.match(message, /wir hoffen, du bist zufrieden mit deiner Bestellung/);
  assert.match(message, /Als Dankeschön für dein Vertrauen möchten wir dir eine gezielte Ergänzung zeigen/);
  assert.match(message, new RegExp(productCopy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(message, /Dein persönlicher Rabatt: \*\[DISCOUNT_CODE\] – 15%\*/);
  assert.match(message, /https:\/\/www\.369research\.eu\/product\/ghk-cu/);
  assert.doesNotMatch(message, /79,00 €/);
});

test("email follows the same product wording and escapes product copy", () => {
  const { subject, body } = generateEmailContent(order, selectedProducts, "[DISCOUNT_CODE]", null, terms);
  assert.match(subject, /15% Rabatt/);
  assert.match(body, /wir hoffen, du bist zufrieden mit deiner Bestellung/);
  assert.match(body, /Gezielt für dich ausgewählt/);
  assert.match(body, /GHK-Cu 50 mg ist ein Beauty- und Regenerations-Favorit/);

  const unsafe = [{ ...selectedProducts[0], generatedCopy: "Text <script>alert('x')</script> & mehr. Zweiter Satz ohne Wirkung." }];
  const escaped = generateEmailContent(order, unsafe, "CODE", null, terms).body;
  assert.match(escaped, /&lt;script&gt;/);
  assert.doesNotMatch(escaped, /<script>/);
});
