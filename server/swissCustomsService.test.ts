import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import {
  THERMAL_LABEL_HEIGHT_PT,
  THERMAL_LABEL_WIDTH_PT,
  buildSwissThermalPrintPdf,
  toDhlSwissCustomsPayload,
  validateSwissCustomsDeclaration,
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
      unitPriceEur: 60,
    }],
    ...overrides,
  };
}

test("builds a DAP customs payload with discount-adjusted commercial values", () => {
  const result = validateSwissCustomsDeclaration(draft());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.goodsValueEur, 108);
  assert.deepEqual(toDhlSwissCustomsPayload(result.value), {
    exportType: "COMMERCIAL_GOODS",
    shippingConditions: "DAP",
    postalCharges: { currency: "EUR", value: 15 },
    items: [{
      itemDescription: "Research peptide vial",
      packagedQuantity: "2",
      hsCode: "30049000",
      countryOfOrigin: "CHN",
      itemValue: { currency: "EUR", value: 54 },
      itemWeight: { uom: "g", value: "100" },
    }],
  });
});

test("rejects missing customs data rather than inferring it from the product name", () => {
  const result = validateSwissCustomsDeclaration(draft({
    lines: [{
      orderItemId: 91,
      description: "",
      hsCode: "",
      countryOfOrigin: "",
      unitWeightGrams: 0,
      quantity: 2,
      unitPriceEur: 60,
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

test("creates a 4×6 document with one label and two customs invoice copies", async () => {
  const validation = validateSwissCustomsDeclaration(draft());
  assert.equal(validation.ok, true);
  if (!validation.ok) return;
  const label = await PDFDocument.create();
  const labelPage = label.addPage([THERMAL_LABEL_WIDTH_PT, THERMAL_LABEL_HEIGHT_PT]);
  labelPage.drawText("DHL TEST LABEL", { x: 20, y: 140, size: 16 });
  const output = await buildSwissThermalPrintPdf({
    dhlLabelPdf: await label.save(),
    invoice: {
      invoiceNumber: "CH-369-TEST-CH",
      invoiceDate: new Date("2026-10-11T00:00:00.000Z"),
      seller: {
        name: "369 RESEARCH Spółka z ograniczoną odpowiedzialnością",
        street: "Hoża 86/210",
        zip: "00-682",
        city: "Warszawa",
        country: "Poland",
        taxId: "PL5214161163",
      },
      consignee: {
        name: "Test Customer",
        street: "Example Street",
        houseNumber: "7",
        zip: "8000",
        city: "Zürich",
        country: "Switzerland",
      },
      declaration: validation.value,
    },
  });
  const rendered = await PDFDocument.load(output);
  assert.equal(rendered.getPageCount(), 3);
  for (const page of rendered.getPages()) {
    assert.equal(page.getWidth(), THERMAL_LABEL_WIDTH_PT);
    assert.equal(page.getHeight(), THERMAL_LABEL_HEIGHT_PT);
  }
});

test("continues long customs invoices on additional 4×6 pages instead of shrinking them", async () => {
  const lines = Array.from({ length: 4 }, (_, index) => ({
    orderItemId: index + 1,
    description: `Research material vial ${index + 1}`,
    hsCode: "30049000",
    countryOfOrigin: "CHN",
    unitWeightGrams: 50,
    quantity: 1,
    unitPriceEur: 10,
  }));
  const validation = validateSwissCustomsDeclaration(draft({ packageWeightGrams: 500, subtotalEur: 40, discountEur: 0, lines }));
  assert.equal(validation.ok, true);
  if (!validation.ok) return;
  const label = await PDFDocument.create();
  const labelPage = label.addPage([THERMAL_LABEL_WIDTH_PT, THERMAL_LABEL_HEIGHT_PT]);
  labelPage.drawText("DHL TEST LABEL", { x: 20, y: 140, size: 16 });
  const output = await buildSwissThermalPrintPdf({
    dhlLabelPdf: await label.save(),
    invoice: {
      invoiceNumber: "CH-369-TEST-CH-LONG",
      invoiceDate: new Date("2026-10-11T00:00:00.000Z"),
      seller: { name: "369 RESEARCH Sp. z o.o.", street: "Hoża 86/210", zip: "00-682", city: "Warszawa", country: "Poland", taxId: "PL5214161163" },
      consignee: { name: "Test Customer", street: "Example Street", houseNumber: "7", zip: "8000", city: "Zürich", country: "Switzerland" },
      declaration: validation.value,
    },
  });
  const rendered = await PDFDocument.load(output);
  assert.equal(rendered.getPageCount(), 5);
  for (const page of rendered.getPages()) {
    assert.equal(page.getWidth(), THERMAL_LABEL_WIDTH_PT);
    assert.equal(page.getHeight(), THERMAL_LABEL_HEIGHT_PT);
  }
});
