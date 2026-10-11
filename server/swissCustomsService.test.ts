import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import {
  THERMAL_LABEL_HEIGHT_PT,
  THERMAL_LABEL_WIDTH_PT,
  buildSwissCommercialInvoicePdf,
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

test("builds a DAP customs payload from manually entered commercial values", () => {
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

test("rejects incomplete manual customs data instead of inferring it", () => {
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
    assert.equal(page.getWidth(), THERMAL_LABEL_WIDTH_PT);
    assert.equal(page.getHeight(), THERMAL_LABEL_HEIGHT_PT);
  }
});

test("continues long standalone invoices on further readable pages", async () => {
  const lines = Array.from({ length: 4 }, (_, index) => ({
    orderItemId: index + 1,
    description: `Research material vial ${index + 1}`,
    hsCode: "30049000",
    countryOfOrigin: "CHN",
    unitWeightGrams: 50,
    quantity: 1,
    unitCustomsValueEur: 10,
  }));
  const validation = validateSwissCustomsDeclaration(draft({ packageWeightGrams: 500, subtotalEur: 40, discountEur: 0, lines }));
  assert.equal(validation.ok, true);
  if (!validation.ok) return;
  const output = await buildSwissCommercialInvoicePdf({ invoice: invoice(validation.value, "CH-369-TEST-LONG") });
  const rendered = await PDFDocument.load(output);
  assert.equal(rendered.getPageCount(), 4);
  for (const page of rendered.getPages()) {
    assert.equal(page.getWidth(), THERMAL_LABEL_WIDTH_PT);
    assert.equal(page.getHeight(), THERMAL_LABEL_HEIGHT_PT);
  }
});
