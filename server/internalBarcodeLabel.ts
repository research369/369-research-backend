import bwipjs from "bwip-js/node";

const BARCODE_VALUE_PATTERN = /^369[0-9A-F]{16}$/;

/** Vector artwork sized for one 50 x 30 mm NIIMBOT M2 label. */
export function renderInternalBarcodeLabelSvg(barcodeValue: string): string {
  if (!BARCODE_VALUE_PATTERN.test(barcodeValue)) {
    throw new Error("Ungültiger interner Barcodewert");
  }

  const barcode = bwipjs.toSVG({
    bcid: "code128",
    text: barcodeValue,
    scale: 3,
    height: 14,
    includetext: false,
  });
  const rootTag = barcode.match(/^<svg\b[^>]*>/);
  const viewBox = barcode.match(/\bviewBox="([^"]+)"/);
  if (!rootTag || !viewBox) throw new Error("Code-128-Grafik konnte nicht erstellt werden");

  const embeddedBarcode = barcode.replace(
    rootTag[0],
    `<svg x="2mm" y="2mm" width="46mm" height="23mm" viewBox="${viewBox[1]}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">`,
  );
  const barcodeContent = embeddedBarcode.replace(/^<svg\b[^>]*>/, "").replace(/<\/svg>\s*$/, "");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="50mm" height="30mm" viewBox="0 0 50 30">
  <rect x="0" y="0" width="50" height="30" fill="#fff"/>
  <svg x="2" y="2" width="46" height="23" viewBox="${viewBox[1]}" preserveAspectRatio="xMidYMid meet">${barcodeContent}</svg>
  <text x="25" y="28.5" text-anchor="middle" font-family="monospace" font-size="2.8" fill="#000">${barcodeValue}</text>
</svg>`;
}
