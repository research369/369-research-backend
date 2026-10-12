import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import {
  CUSTOMS_DOCUMENT_HEIGHT_PT,
  CUSTOMS_DOCUMENT_WIDTH_PT,
  buildSwissCommercialInvoicePdf,
  buildSwissCustomsDocumentsPdf,
  toDhlSwissCustomsPayload,
  validateSwissCustomsDeclaration,
  type ValidatedSwissCustomsDeclaration,
} from "./swissCustomsService.js";

function draft(overrides: Record<string, unknown> = {}) {
  return {
    orderId: "369-TEST-CH",
    packageWeightGrams: 800,
    shippingEur: 15,
    subtotalEur: 120,
    discountEur: 12,
    lines: [{
      orderItemId: 91,
      description: "Research peptide vial",
      hsCode: "30049000",
      countryOfOrigin: "CHN",
      unitWeightGrams: 100,
      quantity: 2,
      unitCustomsValueEur: 54,
    }],
    ...overrides,
  };
}

function invoice(declaration: ValidatedSwissCustomsDeclaration, invoiceNumber: string) {
  return {
    invoiceNumber,
    invoiceDate: new Date("2026-10-11T00:00:00.000Z"),
    seller: { name: "369 RESEARCH Sp. z o.o.", street: "Hoża 86/210", zip: "00-682", city: "Warszawa", country: "Poland", taxId: "PL5214161163" },
    consignee: { name: "Test Customer", street: "Example Street", houseNumber: "7", zip: "8000", city: "Zürich", country: "Switzerland" },
    declaration,
  };
}

test("builds a DHL Paket International customs payload from manually entered commercial values", () => {
  const result = validateSwissCustomsDeclaration(draft());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.goodsValueEur, 108);
  assert.deepEqual(toDhlSwissCustomsPayload(result.value), {
    exportType: "COMMERCIAL_GOODS",
    postalCharges: { currency: "EUR", value: 15 },
    items: [{
      itemDescription: "Research peptide vial",
      packagedQuantity: 2,
      hsCode: "30049000",
      countryOfOrigin: "CHN",
      itemValue: { currency: "EUR", value: 54 },
      itemWeight: { uom: "g", value: 100 },
    }],
  });
});

test("accepts the DHL minimum commodity data without HS code or country of origin", () => {
  const result = validateSwissCustomsDeclaration(draft({
    lines: [{
      orderItemId: 91,
      description: "Collagen and amino acids",
      hsCode: "",
      countryOfOrigin: "",
      unitWeightGrams: 100,
      quantity: 2,
      unitCustomsValueEur: 54,
    }],
  }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(toDhlSwissCustomsPayload(result.value), {
    exportType: "COMMERCIAL_GOODS",
    postalCharges: { currency: "EUR", value: 15 },
    items: [{
      itemDescription: "Collagen and amino acids",
      packagedQuantity: 2,
      itemValue: { currency: "EUR", value: 54 },
      itemWeight: { uom: "g", value: 100 },
    }],
  });
});

test("rejects missing required DHL commodity data instead of inferring it", () => {
  const result = validateSwissCustomsDeclaration(draft({
    lines: [{
      orderItemId: 91,
      description: "",
      hsCode: "",
      countryOfOrigin: "",
      unitWeightGrams: 0,
      quantity: 2,
      unitCustomsValueEur: 0,
    }],
  }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /Warenbezeichnung/);
});

test("rejects declared goods heavier than the actual package", () => {
  const result = validateSwissCustomsDeclaration(draft({ packageWeightGrams: 100 }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /Positionsgewichte/);
});

test("stores two standalone invoice copies without a DHL label page", async () => {
  const validation = validateSwissCustomsDeclaration(draft());
  assert.equal(validation.ok, true);
  if (!validation.ok) return;
  const output = await buildSwissCommercialInvoicePdf({ invoice: invoice(validation.value, "CH-369-TEST-SEPARATE") });
  const rendered = await PDFDocument.load(output);
  assert.equal(rendered.getPageCount(), 2);
  for (const page of rendered.getPages()) {
    assert.equal(page.getWidth(), CUSTOMS_DOCUMENT_WIDTH_PT);
    assert.equal(page.getHeight(), CUSTOMS_DOCUMENT_HEIGHT_PT);
  }
});

test("creates separate A4 Swiss customs documents in CN23-two-invoice order", async () => {
  const validation = validateSwissCustomsDeclaration(draft());
  assert.equal(validation.ok, true);
  if (!validation.ok) return;

  const cn23 = await PDFDocument.create();
  cn23.addPage([CUSTOMS_DOCUMENT_WIDTH_PT, CUSTOMS_DOCUMENT_HEIGHT_PT]);
  const output = await buildSwissCustomsDocumentsPdf({
    customsDocPdfBase64: Buffer.from(await cn23.save()).toString("base64"),
    invoice: invoice(validation.value, "CH-369-TEST-PRINT"),
  });
  const rendered = await PDFDocument.load(output);

  assert.equal(rendered.getPageCount(), 3);
  for (const page of rendered.getPages()) {
    assert.equal(page.getWidth(), CUSTOMS_DOCUMENT_WIDTH_PT);
    assert.equal(page.getHeight(), CUSTOMS_DOCUMENT_HEIGHT_PT);
  }
});

test("continues long standalone invoices on further readable pages", async () => {
  const lines = Array.from({ length: 13 }, (_, index) => ({
    orderItemId: index + 1,
    description: `Research material vial ${index + 1}`,
    hsCode: "30049000",
    countryOfOrigin: "CHN",
    unitWeightGrams: 50,
    quantity: 1,
    unitCustomsValueEur: 10,
  }));
  const validation = validateSwissCustomsDeclaration(draft({ packageWeightGrams: 1000, subtotalEur: 130, discountEur: 0, lines }));
  assert.equal(validation.ok, true);
  if (!validation.ok) return;
  const output = await buildSwissCommercialInvoicePdf({ invoice: invoice(validation.value, "CH-369-TEST-LONG") });
  const rendered = await PDFDocument.load(output);
  assert.equal(rendered.getPageCount(), 4);
  for (const page of rendered.getPages()) {
    assert.equal(page.getWidth(), CUSTOMS_DOCUMENT_WIDTH_PT);
    assert.equal(page.getHeight(), CUSTOMS_DOCUMENT_HEIGHT_PT);
  }
});
