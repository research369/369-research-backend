import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import {
  CUSTOMS_DOCUMENT_HEIGHT_PT,
  CUSTOMS_DOCUMENT_WIDTH_PT,
  THERMAL_LABEL_HEIGHT_PT,
  THERMAL_LABEL_WIDTH_PT,
  buildSwissCommercialInvoicePdf,
  buildSwissCustomsDocumentsPdf,
  buildSwissThermalLabelPackagePdf,
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

test("builds the DHL counter-style package with one portrait label and two full-width landscape CN23 sections", async () => {
  const label = await PDFDocument.create();
  const labelPage = label.addPage([432, 288]); // 6 × 4 inches
  labelPage.drawText("DHL SHIPPING LABEL", { x: 120, y: 140, size: 18 });

  const cn23 = await PDFDocument.create();
  const cn23Page = cn23.addPage([CUSTOMS_DOCUMENT_WIDTH_PT, CUSTOMS_DOCUMENT_HEIGHT_PT]);
  // The real DHL CN23 occupies the upper A5 landscape half of an A4 page.
  cn23Page.drawText("CN23 UPPER SECTION", { x: 20, y: 790, size: 16 });
  cn23Page.drawText("CN23 LOWER SECTION", { x: 20, y: 560, size: 16 });
  cn23Page.drawText("CUSTOMS DECLARATION", { x: 170, y: 425, size: 12 });

  const output = await buildSwissThermalLabelPackagePdf({
    shippingLabelPdfBase64: Buffer.from(await label.save()).toString("base64"),
    customsDocPdfBase64: Buffer.from(await cn23.save()).toString("base64"),
  });
  const rendered = await PDFDocument.load(output);

  assert.equal(rendered.getPageCount(), 3);
  assert.equal(rendered.getPage(0).getWidth(), THERMAL_LABEL_WIDTH_PT);
  assert.equal(rendered.getPage(0).getHeight(), THERMAL_LABEL_HEIGHT_PT);
  for (const page of rendered.getPages().slice(1)) {
    assert.equal(page.getWidth(), THERMAL_LABEL_HEIGHT_PT);
    assert.equal(page.getHeight(), THERMAL_LABEL_WIDTH_PT);
  }
});

test("converts a DHL Onlinefrankierung A4 carrier sheet into the mixed thermal format", async () => {
  const label = await PDFDocument.create();
  const labelPage = label.addPage([CUSTOMS_DOCUMENT_WIDTH_PT, CUSTOMS_DOCUMENT_HEIGHT_PT]);
  // The actual Onlinefrankierung carries its label in the upper A5-landscape half.
  labelPage.drawText("DHL CARRIER LABEL", { x: 20, y: 790, size: 16 });

  const cn23 = await PDFDocument.create();
  const cn23Page = cn23.addPage([CUSTOMS_DOCUMENT_WIDTH_PT, CUSTOMS_DOCUMENT_HEIGHT_PT]);
  cn23Page.drawText("DHL CN23", { x: 20, y: 790, size: 16 });
  const output = await buildSwissThermalLabelPackagePdf({
    shippingLabelPdfBase64: Buffer.from(await label.save()).toString("base64"),
    customsDocPdfBase64: Buffer.from(await cn23.save()).toString("base64"),
  });
  const rendered = await PDFDocument.load(output);

  assert.equal(rendered.getPageCount(), 3);
  assert.equal(rendered.getPage(0).getWidth(), THERMAL_LABEL_WIDTH_PT);
  assert.equal(rendered.getPage(0).getHeight(), THERMAL_LABEL_HEIGHT_PT);
  for (const page of rendered.getPages().slice(1)) {
    assert.equal(page.getWidth(), THERMAL_LABEL_HEIGHT_PT);
    assert.equal(page.getHeight(), THERMAL_LABEL_WIDTH_PT);
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
