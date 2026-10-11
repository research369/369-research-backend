import { PDFDocument, rgb, type PDFPage } from "pdf-lib";
import { normalizeCountryToAlpha3 } from "./dhlService.js";

export const SWISS_CUSTOMS_SHIPPING_CONDITION = "DAP" as const;
export const SWISS_CUSTOMS_EXPORT_TYPE = "COMMERCIAL_GOODS" as const;
export const THERMAL_LABEL_WIDTH_PT = 6 * 72;
export const THERMAL_LABEL_HEIGHT_PT = 4 * 72;

export type SwissCustomsLine = {
  orderItemId: number;
  description: string | null | undefined;
  hsCode: string | null | undefined;
  countryOfOrigin: string | null | undefined;
  /** Weight of a single sellable unit, in grams. */
  unitWeightGrams: number | null | undefined;
  quantity: number;
  /** Manually verified customs value per sellable unit, net in EUR. */
  unitCustomsValueEur: number | null | undefined;
};

export type SwissCustomsDeclaration = {
  orderId: string;
  packageWeightGrams: number;
  shippingEur: number;
  subtotalEur: number;
  discountEur: number;
  lines: SwissCustomsLine[];
};

export type ValidatedSwissCustomsLine = {
  orderItemId: number;
  description: string;
  hsCode: string;
  countryOfOrigin: string;
  unitWeightGrams: number;
  quantity: number;
  unitValueEur: number;
  lineValueEur: number;
  lineWeightGrams: number;
};

export type ValidatedSwissCustomsDeclaration = Omit<SwissCustomsDeclaration, "lines"> & {
  lines: ValidatedSwissCustomsLine[];
  goodsValueEur: number;
};

export type SwissCommercialInvoice = {
  invoiceNumber: string;
  invoiceDate: Date;
  seller: {
    name: string;
    street: string;
    zip: string;
    city: string;
    country: string;
    taxId: string;
  };
  consignee: {
    name: string;
    street: string;
    houseNumber: string;
    zip: string;
    city: string;
    country: string;
  };
  declaration: ValidatedSwissCustomsDeclaration;
};

function asPositiveInteger(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : null;
}

function asPositiveMoney(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? Math.round(numberValue * 100) / 100 : null;
}

function normalizedHsCode(value: string | null | undefined): string | null {
  const compact = String(value ?? "").replace(/\s+/g, "");
  return /^\d{6,10}$/.test(compact) ? compact : null;
}

function normalizedDescription(value: string | null | undefined): string | null {
  const result = String(value ?? "").replace(/\s+/g, " ").trim();
  return result.length >= 3 && result.length <= 200 ? result : null;
}

function toAscii(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7E]/g, "?");
}

function formatEur(value: number): string {
  return `EUR ${value.toFixed(2)}`;
}

function formatWeight(value: number): string {
  return `${value} g`;
}

function resolveDiscountFactor(subtotalEur: number, discountEur: number): number {
  if (!Number.isFinite(subtotalEur) || subtotalEur <= 0) return 1;
  const factor = (subtotalEur - Math.max(0, discountEur)) / subtotalEur;
  return Math.max(0, Math.min(1, factor));
}

/**
 * Validates every datum that DHL and the physical customs invoice need. It never
 * derives an HS code, origin, item weight, or legal sales value from a name.
 */
export function validateSwissCustomsDeclaration(
  declaration: SwissCustomsDeclaration,
): { ok: true; value: ValidatedSwissCustomsDeclaration } | { ok: false; error: string } {
  const packageWeightGrams = asPositiveInteger(declaration.packageWeightGrams);
  if (!packageWeightGrams) {
    return { ok: false, error: "Für Schweizer Sendungen ist das tatsächliche Paketgewicht in Gramm erforderlich." };
  }

  if (!Array.isArray(declaration.lines) || declaration.lines.length === 0) {
    return { ok: false, error: "Für die Schweizer Zollrechnung fehlt mindestens eine Warenposition." };
  }

  const subtotalEur = asPositiveMoney(declaration.subtotalEur);
  const discountEur = asPositiveMoney(declaration.discountEur);
  const shippingEur = asPositiveMoney(declaration.shippingEur);
  if (subtotalEur === null || discountEur === null || shippingEur === null) {
    return { ok: false, error: "Zollrechnung: Bestellwerte sind ungültig." };
  }
  if (discountEur > subtotalEur + 0.01) {
    return { ok: false, error: "Zollrechnung: Der Rabatt darf den Warenwert nicht übersteigen." };
  }

  const discountFactor = resolveDiscountFactor(subtotalEur, discountEur);
  const lines: ValidatedSwissCustomsLine[] = [];
  for (const line of declaration.lines) {
    const description = normalizedDescription(line.description);
    if (!description) {
      return { ok: false, error: `Zollposition ${line.orderItemId}: englische Warenbezeichnung fehlt oder ist ungültig.` };
    }
    const hsCode = normalizedHsCode(line.hsCode);
    if (!hsCode) {
      return { ok: false, error: `Zollposition ${line.orderItemId}: HS-Code muss 6 bis 10 Ziffern enthalten.` };
    }
    const countryOfOrigin = normalizeCountryToAlpha3(String(line.countryOfOrigin ?? ""));
    if (!/^[A-Z]{3}$/.test(countryOfOrigin)) {
      return { ok: false, error: `Zollposition ${line.orderItemId}: Ursprungsland muss als ISO-Ländercode angegeben werden.` };
    }
    const unitWeightGrams = asPositiveInteger(line.unitWeightGrams);
    if (!unitWeightGrams) {
      return { ok: false, error: `Zollposition ${line.orderItemId}: Gewicht je Einheit in Gramm fehlt.` };
    }
    const quantity = asPositiveInteger(line.quantity);
    if (!quantity) {
      return { ok: false, error: `Zollposition ${line.orderItemId}: Menge ist ungültig.` };
    }
    const unitCustomsValueEur = asPositiveMoney(line.unitCustomsValueEur);
    if (unitCustomsValueEur === null || unitCustomsValueEur <= 0) {
      return { ok: false, error: `Zollposition ${line.orderItemId}: manueller Warenwert je Einheit fehlt oder ist ungültig.` };
    }
    lines.push({
      orderItemId: line.orderItemId,
      description,
      hsCode,
      countryOfOrigin,
      unitWeightGrams,
      quantity,
      unitValueEur: unitCustomsValueEur,
      lineValueEur: Math.round(unitCustomsValueEur * quantity * 100) / 100,
      lineWeightGrams: unitWeightGrams * quantity,
    });
  }

  const declaredItemWeight = lines.reduce((sum, line) => sum + line.lineWeightGrams, 0);
  if (declaredItemWeight > packageWeightGrams) {
    return {
      ok: false,
      error: `Die Summe der Positionsgewichte (${declaredItemWeight} g) darf das tatsächliche Paketgewicht (${packageWeightGrams} g) nicht übersteigen.`,
    };
  }

  return {
    ok: true,
    value: {
      ...declaration,
      packageWeightGrams,
      subtotalEur,
      discountEur,
      shippingEur,
      lines,
      goodsValueEur: Math.round(lines.reduce((sum, line) => sum + line.lineValueEur, 0) * 100) / 100,
    },
  };
}

/** DHL Parcel DE Customs payload for the explicitly chosen DAP terms. */
export function toDhlSwissCustomsPayload(declaration: ValidatedSwissCustomsDeclaration) {
  return {
    exportType: SWISS_CUSTOMS_EXPORT_TYPE,
    shippingConditions: SWISS_CUSTOMS_SHIPPING_CONDITION,
    postalCharges: {
      currency: "EUR",
      value: declaration.shippingEur,
    },
    items: declaration.lines.map((line) => ({
      itemDescription: line.description,
      packagedQuantity: String(line.quantity),
      hsCode: line.hsCode,
      countryOfOrigin: line.countryOfOrigin,
      itemValue: {
        currency: "EUR",
        value: line.unitValueEur,
      },
      itemWeight: {
        uom: "g",
        value: String(line.unitWeightGrams),
      },
    })),
  };
}

function wrapText(text: string, maxCharacters: number): string[] {
  const words = toAscii(text).trim().split(/\s+/).filter(Boolean);
  const output: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (`${current} ${word}`.length <= maxCharacters) {
      current += ` ${word}`;
    } else {
      output.push(current);
      current = word;
    }
  }
  if (current) output.push(current);
  return output.length ? output : [""];
}

function drawText(page: PDFPage, text: string, x: number, y: number, size: number, bold = false) {
  page.drawText(toAscii(text), {
    x,
    y,
    size,
    color: rgb(0.08, 0.12, 0.2),
  });
}

function drawRule(page: PDFPage, y: number) {
  page.drawLine({ start: { x: 14, y }, end: { x: THERMAL_LABEL_WIDTH_PT - 14, y }, thickness: 0.5, color: rgb(0.6, 0.64, 0.7) });
}

function invoicePageChunks(lines: ValidatedSwissCustomsLine[]): ValidatedSwissCustomsLine[][] {
  const maxRows = 3;
  const chunks: ValidatedSwissCustomsLine[][] = [];
  for (let index = 0; index < lines.length; index += maxRows) chunks.push(lines.slice(index, index + maxRows));
  return chunks;
}

function addInvoicePage(
  document: PDFDocument,
  invoice: SwissCommercialInvoice,
  lines: ValidatedSwissCustomsLine[],
  copyNumber: number,
  copyCount: number,
  continuation: number,
  continuationCount: number,
) {
  const page = document.addPage([THERMAL_LABEL_WIDTH_PT, THERMAL_LABEL_HEIGHT_PT]);
  const { declaration } = invoice;
  let y = 270;
  drawText(page, "COMMERCIAL INVOICE", 14, y, 13, true);
  drawText(page, `CUSTOMS COPY ${copyNumber}/${copyCount}${continuationCount > 1 ? `  PAGE ${continuation}/${continuationCount}` : ""}`, 250, y + 2, 7, true);
  y -= 16;
  drawText(page, `Invoice: ${invoice.invoiceNumber}    Date: ${invoice.invoiceDate.toISOString().slice(0, 10)}`, 14, y, 7);
  y -= 8;
  drawRule(page, y);
  y -= 12;

  drawText(page, "SELLER / EXPORTER", 14, y, 7, true);
  drawText(page, "CONSIGNEE", 222, y, 7, true);
  y -= 10;
  const sellerLines = [invoice.seller.name, invoice.seller.street, `${invoice.seller.zip} ${invoice.seller.city}`, invoice.seller.country, `Tax ID: ${invoice.seller.taxId}`];
  const consigneeLines = [invoice.consignee.name, `${invoice.consignee.street} ${invoice.consignee.houseNumber}`.trim(), `${invoice.consignee.zip} ${invoice.consignee.city}`, invoice.consignee.country];
  for (let index = 0; index < Math.max(sellerLines.length, consigneeLines.length); index++) {
    if (sellerLines[index]) drawText(page, sellerLines[index], 14, y, 6.5);
    if (consigneeLines[index]) drawText(page, consigneeLines[index], 222, y, 6.5);
    y -= 8;
  }
  y -= 1;
  drawRule(page, y);
  y -= 11;

  drawText(page, "Description (English)", 14, y, 6.5, true);
  drawText(page, "Qty", 202, y, 6.5, true);
  drawText(page, "HS / Origin", 230, y, 6.5, true);
  drawText(page, "Weight", 318, y, 6.5, true);
  drawText(page, "Value", 372, y, 6.5, true);
  y -= 7;
  drawRule(page, y);
  y -= 10;

  for (const line of lines) {
    const descriptionLines = wrapText(line.description, 30).slice(0, 2);
    for (const descriptionLine of descriptionLines) {
      drawText(page, descriptionLine, 14, y, 6);
      y -= 7;
    }
    const rowTop = y + descriptionLines.length * 7;
    drawText(page, String(line.quantity), 202, rowTop, 6);
    drawText(page, `${line.hsCode} / ${line.countryOfOrigin}`, 230, rowTop, 6);
    drawText(page, formatWeight(line.lineWeightGrams), 318, rowTop, 6);
    drawText(page, formatEur(line.lineValueEur), 372, rowTop, 6);
    y -= 3;
    drawRule(page, y);
    y -= 8;
  }

  drawText(page, `Goods value: ${formatEur(declaration.goodsValueEur)}    Freight: ${formatEur(declaration.shippingEur)}`, 14, y, 6.5, true);
  y -= 10;
  drawText(page, "Export reason: Sale    Shipping terms: Delivered at Place (DAP)", 14, y, 6.5);
  y -= 10;
  drawText(page, `Package weight: ${formatWeight(declaration.packageWeightGrams)}    Currency: EUR`, 14, y, 6.5);
  y -= 12;
  drawText(page, "I certify that the information on this invoice is true and correct.", 14, y, 6.5);
  y -= 11;
  drawText(page, "Original signature: __________________________________", 14, y, 7);
  return page;
}

/**
 * Generates the two required commercial-invoice copies as a standalone PDF.
 * The document is persisted with the shipment evidence and deliberately never
 * included in, opened with, or sent to the thermal-label print flow.
 */
export async function buildSwissCommercialInvoicePdf(input: {
  invoice: SwissCommercialInvoice;
}): Promise<Uint8Array> {
  const output = await PDFDocument.create();
  const chunks = invoicePageChunks(input.invoice.declaration.lines);
  for (let copyNumber = 1; copyNumber <= 2; copyNumber++) {
    chunks.forEach((chunk, index) => addInvoicePage(output, input.invoice, chunk, copyNumber, 2, index + 1, chunks.length));
  }
  return output.save();
}
