import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateCheckoutV2Quote,
  CheckoutV2QuoteError,
  type CheckoutV2CatalogArticle,
} from "./checkoutV2Quote.js";

const catalog: CheckoutV2CatalogArticle[] = [
  {
    sku: "ADAMAX-10MG",
    shopProductId: "adamax",
    name: "Adamax (10 mg)",
    sellingPrice: "62.00",
    salePrice: null,
    variants: [{ dosage: "10 mg", price: 62 }],
    isActive: 1,
    shopVisible: 1,
    stock: 12,
  },
  {
    sku: "BAC-3ML",
    shopProductId: "bac-wasser-3ml",
    name: "BAC Wasser 3ml",
    sellingPrice: "5.00",
    salePrice: null,
    variants: [{ dosage: "3ml", price: 5 }],
    isActive: 1,
    shopVisible: 1,
    stock: 20,
    category: "Zubehör",
  },
  {
    sku: "SEMAX-SELANK-10MG",
    shopProductId: "semax-selank",
    name: "Semax + Selank (10 mg)",
    sellingPrice: "58.00",
    salePrice: null,
    variants: [{ dosage: "10 mg", price: 58 }],
    isActive: 1,
    shopVisible: 1,
    stock: 3,
  },
  {
    sku: "NASAL-READY-10MG",
    shopProductId: "ready-nasal",
    name: "Ready Nasal (10 mg)",
    sellingPrice: "45.00",
    salePrice: null,
    variants: [{ dosage: "10 mg", price: 45 }],
    isActive: 1,
    shopVisible: 1,
    stock: 4,
  },
  {
    sku: "BAC-10ML",
    shopProductId: "bac-wasser",
    name: "BAC Wasser (10 ml)",
    sellingPrice: "8.00",
    salePrice: null,
    variants: [],
    isActive: 1,
    shopVisible: 1,
    stock: 3,
  },
];

function quote(selection: Parameters<typeof calculateCheckoutV2Quote>[0]["selections"][number], benefit?: Parameters<typeof calculateCheckoutV2Quote>[0]["benefit"]) {
  return calculateCheckoutV2Quote({
    selections: [selection],
    delivery: { country: "Deutschland", deliveryType: "home" },
    benefit,
    catalog,
  });
}

test("Checkout V2 ignores client price and resolves the current catalog price", () => {
  const result = quote({ shopProductId: "adamax", dosage: "10 mg", quantity: 1 });
  assert.equal(result.lines[0]?.unitPrice, 62);
  assert.equal(result.subtotal, 62);
  assert.equal(result.shipping, 8);
  assert.equal(result.total, 70);
});

test("Checkout V2 refuses active articles hidden from the shop", () => {
  const hiddenCatalog = catalog.map((article) => article.shopProductId === "adamax" ? { ...article, shopVisible: 0 } : article);
  assert.throws(
    () => calculateCheckoutV2Quote({
      selections: [{ shopProductId: "adamax", dosage: "10 mg", quantity: 1 }],
      delivery: { country: "Deutschland", deliveryType: "home" },
      catalog: hiddenCatalog,
    }),
    (error: unknown) => error instanceof CheckoutV2QuoteError && error.code === "PRODUCT_NOT_AVAILABLE",
  );
});

test("Checkout V2 calculates restricted promotion and its shipping rule from server metadata", () => {
  const result = quote(
    { shopProductId: "adamax", dosage: "10 mg", quantity: 1 },
    { kind: "promo", code: "SAVE10", promo: { discountType: "percent", percentage: 10, fixedAmount: 0, description: 'Aktion | {"restrict":["adamax"],"freeShipping":["de"]}' } },
  );
  assert.equal(result.discount, 6.2);
  assert.equal(result.shipping, 0);
  assert.equal(result.total, 55.8);
  assert.deepEqual(result.discountLines, [{ source: "promotion_code", label: "Aktionsrabatt", amount: 6.2, code: "SAVE10" }]);
});

test("Checkout V2 keeps partner advantage server-shaped and limited to products", () => {
  const result = quote(
    { shopProductId: "adamax", dosage: "10 mg", quantity: 1 },
    { kind: "partner", code: "PARTNER", percent: 15 },
  );
  assert.equal(result.discount, 9.3);
  assert.equal(result.shipping, 8);
  assert.equal(result.total, 60.7);
});

test("Checkout V2 applies the referral advantage after no client-side price manipulation", () => {
  const result = quote(
    { shopProductId: "adamax", dosage: "10 mg", quantity: 1 },
    { kind: "kwk_referral", code: "FREUND" },
  );
  assert.equal(result.discount, 6.2);
  assert.equal(result.total, 63.8);
});

test("Checkout V2 calculates a general promotion and referral sequentially", () => {
  const result = calculateCheckoutV2Quote({
    selections: [{ shopProductId: "adamax", dosage: "10 mg", quantity: 1 }],
    delivery: { country: "Deutschland", deliveryType: "home" },
    benefits: {
      promotion: { kind: "promo", code: "SAVE10", promo: { discountType: "percent", percentage: 10, fixedAmount: 0 } },
      kwkReferralCode: "FREUND",
      kwkReferralPercent: 10,
    },
    catalog,
  });
  assert.equal(result.discount, 11.78);
  assert.equal(result.total, 58.22);
  assert.equal(result.discountLines.length, 2);
});

test("Checkout V2 refuses to combine a partner route with a referral route", () => {
  assert.throws(
    () => calculateCheckoutV2Quote({
      selections: [{ shopProductId: "adamax", dosage: "10 mg", quantity: 1 }],
      delivery: { country: "Deutschland", deliveryType: "home" },
      benefits: {
        promotion: { kind: "partner", code: "PARTNER", percent: 10 },
        kwkReferralCode: "FREUND",
      },
      catalog,
    }),
    (error: unknown) => error instanceof CheckoutV2QuoteError && error.code === "KWK_PARTNER_EXCLUDED",
  );
});

test("Checkout V2 rejects Packstation when cold-chain delivery is required", () => {
  assert.throws(
    () => calculateCheckoutV2Quote({
      selections: [{ shopProductId: "ready-nasal", dosage: "10 mg", quantity: 1, isNasalSpray: true }],
      delivery: { country: "Deutschland", deliveryType: "packstation" },
      catalog,
    }),
    (error: unknown) => error instanceof CheckoutV2QuoteError && error.code === "PICKUP_POINT_NOT_AVAILABLE",
  );
});

test("Checkout V2 permits all seven approved DIY nasal product families and adds the configured kit surcharge", () => {
  const result = quote({ shopProductId: "semax-selank", dosage: "10 mg", quantity: 1, isNasalDiySet: true });
  assert.equal(result.lines[0]?.unitPrice, 65);
  assert.equal(result.coldChainRequired, false);
  assert.equal(result.total, 73);
});

test("Checkout V2 refuses a DIY nasal kit when its tracked BAC component is insufficient", () => {
  assert.throws(
    () => calculateCheckoutV2Quote({
      selections: [{ shopProductId: "adamax", dosage: "10 mg", quantity: 4, isNasalDiySet: true }],
      delivery: { country: "Deutschland", deliveryType: "home" },
      catalog,
    }),
    (error: unknown) => error instanceof CheckoutV2QuoteError && error.code === "NASAL_KIT_COMPONENT_OUT_OF_STOCK",
  );
});

test("Checkout V2 rejects unavailable quantities before any order can be created", () => {
  assert.throws(
    () => quote({ shopProductId: "adamax", dosage: "10 mg", quantity: 13 }),
    (error: unknown) => error instanceof CheckoutV2QuoteError && error.code === "PRODUCT_OUT_OF_STOCK",
  );
});

test("Checkout V2 aggregates paid and 2-for-3 quantities before stock approval", () => {
  const tightCatalog = catalog.map((article) => article.shopProductId === "adamax" ? { ...article, stock: 5 } : article);
  assert.throws(
    () => calculateCheckoutV2Quote({
      selections: [{ shopProductId: "adamax", dosage: "10 mg", quantity: 4 }],
      delivery: { country: "Deutschland", deliveryType: "home" },
      promotion2for3: { enabled: true, mode: "all", products: [] },
      catalog: tightCatalog,
    }),
    (error: unknown) => error instanceof CheckoutV2QuoteError && error.code === "PRODUCT_OUT_OF_STOCK",
  );
});

test("Checkout V2 refuses a quote when a required Gratis-BAC item is out of stock", () => {
  const tightCatalog = catalog.map((article) => article.shopProductId === "bac-wasser-3ml" ? { ...article, stock: 1 } : article);
  assert.throws(
    () => calculateCheckoutV2Quote({
      selections: [{ shopProductId: "adamax", dosage: "10 mg", quantity: 2 }],
      delivery: { country: "Deutschland", deliveryType: "home" },
      catalog: tightCatalog,
    }),
    (error: unknown) => error instanceof CheckoutV2QuoteError && error.code === "GIFT_OUT_OF_STOCK",
  );
});

test("Checkout V2 rejects Postfiliale when cold-chain delivery is required", () => {
  assert.throws(
    () => calculateCheckoutV2Quote({
      selections: [{ shopProductId: "ready-nasal", dosage: "10 mg", quantity: 1, isNasalSpray: true }],
      delivery: { country: "Deutschland", deliveryType: "postfiliale" },
      catalog,
    }),
    (error: unknown) => error instanceof CheckoutV2QuoteError && error.code === "PICKUP_POINT_NOT_AVAILABLE",
  );
});

test("Checkout V2 derives partner self-discount and credit only from server-provided session values", () => {
  const result = calculateCheckoutV2Quote({
    selections: [{ shopProductId: "adamax", dosage: "10 mg", quantity: 1 }],
    delivery: { country: "Deutschland", deliveryType: "home" },
    benefits: {
      partnerSelf: {
        partnerNumber: "P-1001",
        partnerCode: "PARTNER1001",
        discountPercent: 10,
        requestedCredit: 20,
        availableCredit: 12,
      },
    },
    catalog,
  });
  assert.equal(result.discountLines.find((line) => line.source === "partner_self_discount")?.amount, 6.2);
  assert.equal(result.discountLines.find((line) => line.source === "partner_credit")?.amount, 12);
  assert.equal(result.total, 51.8);
});

test("Checkout V2 refuses to combine partner self-order and KWK referral", () => {
  assert.throws(
    () => calculateCheckoutV2Quote({
      selections: [{ shopProductId: "adamax", dosage: "10 mg", quantity: 1 }],
      delivery: { country: "Deutschland", deliveryType: "home" },
      benefits: {
        partnerSelf: { partnerNumber: "P-1001", partnerCode: "PARTNER1001", discountPercent: 10, requestedCredit: 0, availableCredit: 0 },
        kwkReferralCode: "FREUND",
      },
      catalog,
    }),
    (error: unknown) => error instanceof CheckoutV2QuoteError && error.code === "KWK_PARTNER_EXCLUDED",
  );
});
