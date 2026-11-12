import assert from "node:assert/strict";
import test from "node:test";
import {
  catalogueRequiresColdShipping,
  normalizePublicCheckoutPricingOptions,
  resolveTrustedColdShippingItems,
} from "./coldShippingCatalog.js";
import {
  calculateAuthoritativeShipping,
  requiresColdChainShipping,
  resolveAuthoritativeItemPrice,
  type KwkCatalogArticle,
  type ShippingCheckoutItem,
} from "./kwkCheckoutPricing.js";

type TestItem = ShippingCheckoutItem & {
  shopProductId: string;
  price: number;
  quantity: number;
  dosage?: string;
};

const catalog = [
  { sku: "VIAL-10", shopProductId: "vial", name: "Peptide (10 mg)", category: "Peptide", shopVisible: 1, isActive: 1, sellingPrice: 100, salePrice: null, variants: [] },
  { sku: "NASAL", shopProductId: "nasal", name: "Ready Nasenspray", category: "Nasensprays", shopVisible: 1, isActive: 1, sellingPrice: 115, salePrice: null, variants: [] },
  { sku: "PATRONE", shopProductId: "patrone", name: "Plug&Play Patrone", category: "Peptide", shopVisible: 1, isActive: 1, sellingPrice: 115, salePrice: null, variants: [] },
  { sku: "DIY", shopProductId: "diy", name: "Nasenspray DIY-Set", category: "Zubehör", shopVisible: 1, isActive: 1, sellingPrice: 107, salePrice: null, variants: [] },
  { sku: "PEN", shopProductId: "pen", name: "Plug&Play Pen", category: "Forscherpens", shopVisible: 1, isActive: 1, sellingPrice: 30, salePrice: null, variants: [] },
  { sku: "EMPTY", shopProductId: "empty", name: "Leere Plug&Play Patrone", category: "Zubehör", shopVisible: 1, isActive: 1, sellingPrice: 30, salePrice: null, variants: [] },
  { sku: "BOTTLE", shopProductId: "bottle", name: "Leere Nasensprayflasche", category: "Zubehör", shopVisible: 1, isActive: 1, sellingPrice: 30, salePrice: null, variants: [] },
  { sku: "SEMAX-10MG", shopProductId: "semax", name: "Semax (10 mg)", category: "Peptide", shopVisible: 1, isActive: 1, sellingPrice: 100, salePrice: null, variants: [] },
  { sku: "KLOW-STACK-80MG", shopProductId: "klow-stack", name: "KLOW Stack (80 mg)", category: "Forscher-Bundles", shopVisible: 1, isActive: 1, sellingPrice: 100, salePrice: null, variants: [] },
  { sku: "CAPSULE", shopProductId: "capsule", name: "Peptide capsules", category: "Kapseln / Tabletten", shopVisible: 1, isActive: 1, sellingPrice: 30, salePrice: null, variants: [] },
];

function checkout(item: TestItem, pricingCatalog: KwkCatalogArticle[] = catalog, freeBaseShipping = true) {
  const [pricingItem] = normalizePublicCheckoutPricingOptions([item], catalog);
  const merchandise = resolveAuthoritativeItemPrice(pricingItem, pricingCatalog);
  const [shippingItem] = resolveTrustedColdShippingItems([pricingItem], catalog);
  const shipping = calculateAuthoritativeShipping({
    country: "Deutschland", items: [shippingItem], freeBaseShipping,
    coldShippingSurcharge: 15,
  });
  return { pricingItem, shippingItem, merchandise, shipping, total: merchandise + shipping };
}

function line(shopProductId: string, flags: ShippingCheckoutItem = {}): TestItem {
  return { shopProductId, price: 1, quantity: 1, ...flags };
}

test("fixed ready nasal product cannot be disguised by public name or DIY flags", () => {
  const input = line("nasal", { name: "Vial", isNasalSpray: false, isNasalDiySet: true, isPlugPlay: true });
  const result = checkout(input);
  assert.equal(result.pricingItem.isNasalSpray, true);
  assert.equal(result.pricingItem.isNasalDiySet, false);
  assert.equal(result.pricingItem.isPlugPlay, false);
  assert.equal(result.shippingItem.isNasalSpray, true);
  assert.equal(result.shippingItem.isNasalDiySet, false);
  assert.equal(result.merchandise, 115);
  assert.equal(result.shipping, 15);
  assert.equal(result.total, 130);
  assert.equal(catalogueRequiresColdShipping([input], catalog), true);
});

test("fixed cartridge remains cold but its 115 catalogue price is not charged as 130", () => {
  for (const isPlugPlay of [undefined, false, true]) {
    const result = checkout(line("patrone", { name: "Vial", isPlugPlay, isNasalDiySet: true }));
    assert.equal(result.pricingItem.isPlugPlay, false);
    assert.equal(result.pricingItem.isNasalDiySet, false);
    assert.equal(result.shippingItem.isPlugPlay, true);
    assert.equal(result.shippingItem.isNasalSpray, false);
    assert.equal(result.merchandise, 115);
    assert.equal(result.shipping, 15);
    assert.equal(result.total, 130);
  }
});

test("ordinary vial remains 100 plus legitimate Plug&Play option 15 plus shipping 15", () => {
  const result = checkout(line("vial", { isPlugPlay: true }));
  assert.equal(result.pricingItem.isPlugPlay, true);
  assert.equal(result.merchandise, 115);
  assert.equal(result.shipping, 15);
  assert.equal(result.total, 130);
});

test("mixed-cart authoritative sum charges both product forms correctly and cold shipping only once", () => {
  const input = [
    line("vial", { variant: "Plug&Play Patrone", isPlugPlay: false }),
    line("patrone", { isPlugPlay: true }),
    line("pen", { variant: "Plug&Play Pen (Blau)", isPlugPlay: true }),
  ];
  const normalized = normalizePublicCheckoutPricingOptions(input, catalog);
  const prices = normalized.map((item) => resolveAuthoritativeItemPrice(item, catalog));
  assert.deepEqual(prices, [115, 115, 30]);
  const subtotal = normalized.reduce((sum, item, index) => sum + prices[index] * item.quantity, 0);
  const shipping = calculateAuthoritativeShipping({
    country: "Deutschland", items: resolveTrustedColdShippingItems(normalized, catalog),
    freeBaseShipping: true, coldShippingSurcharge: 15,
  });
  assert.equal(subtotal, 260);
  assert.equal(shipping, 15);
  assert.equal(subtotal + shipping, 275);
});

test("recognized legacy cartridge variant or bracketed name authorizes the same paid vial option", () => {
  const legacyOptions: ShippingCheckoutItem[] = [
    { variant: "Plug&Play Patrone", isPlugPlay: false },
    { variant: "Bundle: Plug&Play" },
    { variant: "Bundle: Plug and Play cartridge", isPlugPlay: false },
    { name: "Customer Peptide [Plug&Play Patrone]", isPlugPlay: false },
  ];
  for (const flags of legacyOptions) {
    const result = checkout(line("vial", flags));
    assert.equal(result.pricingItem.isPlugPlay, true);
    assert.equal(result.merchandise, 115);
    assert.equal(result.shipping, 15);
    assert.equal(result.total, 130);
  }
});

test("Plug&Play Pen and its color variant are 30 with base shipping and no cooling", () => {
  for (const isPlugPlay of [undefined, false, true]) {
    const result = checkout(line("pen", {
      variant: "Plug&Play Pen (Schwarz)", isPlugPlay,
      isNasalSpray: true, isNasalDiySet: true,
    }), catalog, false);
    assert.equal(result.pricingItem.isPlugPlay, false);
    assert.equal(result.pricingItem.isNasalDiySet, false);
    assert.equal(requiresColdChainShipping(result.shippingItem), false);
    assert.equal(result.merchandise, 30);
    assert.equal(result.shipping, 8);
    assert.equal(result.total, 38);
  }
});

test("accessories and capsules cannot acquire cartridge or nasal options from public text/flags", () => {
  for (const id of ["pen", "empty", "bottle", "capsule"]) {
    const input = line(id, {
      name: "Peptide [Plug&Play Patrone]", variant: "Plug&Play Patrone / Nasenspray",
      isPlugPlay: true, isNasalSpray: true, isNasalDiySet: true,
    });
    const result = checkout(input, catalog, false);
    assert.equal(result.merchandise, 30);
    assert.equal(result.shipping, 8);
    assert.equal(catalogueRequiresColdShipping([input], catalog), false);
  }
});

test("a Plug&Play Pen variant is not a legacy vial preparation request", () => {
  const result = checkout(line("vial", { variant: "Plug&Play Pen (Rot)", isPlugPlay: false }));
  assert.equal(result.pricingItem.isPlugPlay, false);
  assert.equal(result.merchandise, 100);
  assert.equal(result.shipping, 0);
});

test("normal vial and fixed DIY set remain non-cold without extra option pricing", () => {
  assert.equal(catalogueRequiresColdShipping([{ shopProductId: "vial" }, { shopProductId: "diy" }], catalog), false);
  const result = checkout(line("diy", { isNasalDiySet: true, isPlugPlay: true, isNasalSpray: true }));
  assert.equal(result.pricingItem.isNasalDiySet, false);
  assert.equal(result.pricingItem.isPlugPlay, false);
  assert.equal(result.shippingItem.isNasalDiySet, true);
  assert.equal(result.merchandise, 107);
  assert.equal(result.shipping, 0);
});

test("DIY nasal option is allowed only on a catalogue-confirmed eligible vial", () => {
  for (const id of ["semax", "SEMAX-10MG"]) {
    const result = checkout(line(id, { isNasalSpray: true, isNasalDiySet: true }));
    assert.equal(result.pricingItem.isNasalDiySet, true);
    assert.equal(result.pricingItem.isNasalSpray, true);
    assert.equal(result.merchandise, 107);
    assert.equal(result.shipping, 0);
  }
  const invalid = checkout(line("vial", { variant: "Nasenspray", isNasalSpray: true, isNasalDiySet: true }));
  assert.equal(invalid.pricingItem.isNasalDiySet, false);
  assert.equal(invalid.pricingItem.isNasalSpray, false);
  assert.equal(invalid.merchandise, 100);
  assert.equal(invalid.shipping, 0);
});

test("an unvalidated nasal form flag alone does not prepare an ordinary vial", () => {
  const result = checkout(line("semax", { name: "Nasenspray", variant: "Nasenspray", isNasalSpray: true }));
  assert.equal(result.pricingItem.isNasalSpray, false);
  assert.equal(result.pricingItem.isNasalDiySet, false);
  assert.equal(result.merchandise, 100);
  assert.equal(result.shipping, 0);
});

test("Plug&Play exclusions and narrow KLOW vial-bundle exception match product options", () => {
  const excluded = checkout(line("semax", { isPlugPlay: true, variant: "Bundle: Plug&Play Patrone" }));
  assert.equal(excluded.pricingItem.isPlugPlay, false);
  assert.equal(excluded.merchandise, 100);
  assert.equal(excluded.shipping, 0);
  const included = checkout(line("KLOW-STACK-80MG", { variant: "Bundle: Plug&Play" }));
  assert.equal(included.pricingItem.isPlugPlay, true);
  assert.equal(included.merchandise, 115);
  assert.equal(included.shipping, 15);
});

test("category arrays prohibit options even when primary category appears vial-like", () => {
  const categorized = [{ ...catalog[0], categories: ["Peptide", "Zubehör"] }];
  const input = line("vial", { isPlugPlay: true, variant: "Plug&Play Patrone" });
  const [normalized] = normalizePublicCheckoutPricingOptions([input], categorized);
  assert.equal(normalized.isPlugPlay, false);
  assert.equal(catalogueRequiresColdShipping([input], categorized), false);
});

test("normalization preserves catalogue sale/dosage pricing, custom text and quantity", () => {
  const withVariants = catalog.map((article) => article.shopProductId === "vial"
    ? { ...article, variants: [{ dosage: "20 mg", price: 140 }] } : article);
  const input = { ...line("vial", { isPlugPlay: true, variant: "Manual custom text" }), dosage: "20 mg", quantity: 3 };
  const result = checkout(input, withVariants);
  assert.equal(result.merchandise, 155);
  assert.equal(result.pricingItem.variant, "Manual custom text");
  assert.equal(result.pricingItem.dosage, "20 mg");
  assert.equal(result.pricingItem.quantity, 3);
  const withSale = withVariants.map((article) => article.shopProductId === "vial"
    ? { ...article, salePrice: 90 } : article);
  assert.equal(checkout(input, withSale).merchandise, 105);
});

test("neither projection mutates source line names, variants, prices or flags", () => {
  const input = [{ ...line("nasal", { name: "Customer label", variant: "100 mg", isNasalSpray: false, isNasalDiySet: true }), price: 42.5 }];
  const before = JSON.stringify(input);
  Object.freeze(input[0]);
  Object.freeze(input);
  const pricing = normalizePublicCheckoutPricingOptions(input, catalog);
  const trusted = resolveTrustedColdShippingItems(input, catalog);
  assert.equal(JSON.stringify(input), before);
  assert.notEqual(pricing[0], input[0]);
  assert.notEqual(trusted[0], input[0]);
  assert.equal(pricing[0].name, "Customer label");
  assert.equal(pricing[0].variant, "100 mg");
  assert.equal(pricing[0].price, 42.5);
  assert.equal(trusted[0].isNasalSpray, true);
  assert.equal(trusted[0].variant, "100 mg");
  assert.equal(trusted[0].price, 42.5);
});

test("unknown/inactive public references are not authorized by option normalization", () => {
  for (const id of ["unknown", ""]) {
    const [normalized] = normalizePublicCheckoutPricingOptions([line(id, { isPlugPlay: true, isNasalDiySet: true })], catalog);
    assert.equal(normalized.isPlugPlay, false);
    assert.equal(normalized.isNasalDiySet, false);
    assert.throws(() => resolveAuthoritativeItemPrice(normalized, catalog), /KWK_ARTIKEL_/);
  }
  const inactive = catalog.map((article) => ({ ...article, isActive: 0 }));
  const [normalized] = normalizePublicCheckoutPricingOptions([line("vial", { isPlugPlay: true })], inactive);
  assert.equal(normalized.isPlugPlay, false);
  assert.throws(() => resolveAuthoritativeItemPrice(normalized, inactive), /KWK_ARTIKEL_NICHT_GEFUNDEN/);
});
