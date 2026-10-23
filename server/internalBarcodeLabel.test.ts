import assert from "node:assert/strict";
import test from "node:test";
import { renderInternalBarcodeLabelSvg } from "./internalBarcodeLabel.js";

test("renders an opaque Code 128 label at the NIIMBOT 50 x 30 mm size", () => {
  const svg = renderInternalBarcodeLabelSvg("3690123456789ABCDEF");
  assert.match(svg, /width="50mm" height="30mm" viewBox="0 0 50 30"/);
  assert.match(svg, /<svg x="2" y="2" width="46" height="23"/);
  assert.match(svg, /font-family="monospace"[^>]*>3690123456789ABCDEF<\/text>/);
  assert.doesNotMatch(svg, /Peptid|Dosierung|SKU|q\.369research\.eu/i);
});

test("rejects values that are not generated opaque barcode payloads", () => {
  assert.throws(() => renderInternalBarcodeLabelSvg("BPC-157-10MG"), /Ungültiger interner Barcodewert/);
});
