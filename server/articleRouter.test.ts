import assert from "node:assert/strict";
import test from "node:test";
import { getPublicShopVariants } from "./articleRouter.js";

const image5 = "https://files.manuscdn.com/user_upload_by_module/session_file/119871539/tkRUpeAbIncIRHMq.webp";
const image10 = "https://files.manuscdn.com/user_upload_by_module/session_file/119871539/zLosPXxAlUgeZiYx.webp";
const article = {
  id: 236, name: "Eloralintide (5 mg)", sku: "ELORALINTIDE-5MG",
  stock: 9, sellingPrice: "64.00", shopProductId: "eloralintide", variants: null,
};
const inventory = [
  { ...article },
  { id: 237, sku: "ELORALINTIDE-10MG", stock: 9, shopProductId: "eloralintide" },
];
const legacy5 = {
  dosage: "5 mg", label: "5 mg", price: 64, stock: 9, inStock: true,
  articleId: 236, sku: "ELORALINTIDE-5MG",
};

test("explicit approved 5/10 mg WebP images are carried with unchanged price and inventory identity", () => {
  const configured = {
    ...article,
    variants: [
      { dosage: "5 mg", price: 64, stock: 100, inventoryArticleId: 236, imageUrl: image5, image: image5, images: [image5] },
      { dosage: "10 mg", price: 115, stock: 100, inventoryArticleId: 237, imageUrl: image10, image: image10, images: [image10] },
    ],
  };
  const before = structuredClone(configured);
  assert.deepEqual(getPublicShopVariants(configured, inventory), [
    { ...legacy5, image: image5 },
    { dosage: "10 mg", label: "10 mg", price: 115, stock: 9, inStock: true, articleId: 237, sku: "ELORALINTIDE-10MG", image: image10 },
  ]);
  assert.deepEqual(configured, before);
});

test("valid imageUrl takes precedence and explicit image remains supported", () => {
  for (const [sources, expected] of [
    [{ imageUrl: image10, image: image5 }, image10],
    [{ image: image5 }, image5],
    [{ imageUrl: "http://example.invalid/unsafe.webp", image: image5 }, image5],
  ] as const) {
    const [variant] = getPublicShopVariants({ ...article, variants: [{ dosage: "5 mg", price: 64, ...sources }] });
    assert.equal(variant.image, expected);
  }
});

test("image-less configured and legacy DTOs retain exact keys without inventory/mockup/gallery fallbacks", () => {
  const withUnrelatedImages = { ...article, mockupImageUrl: image5, labelImageUrl: image5, galleryImages: [image5] };
  const rows = inventory.map(row => ({ ...row, mockupImageUrl: image10, image: image10 }));
  for (const variants of [null, [], [{ dosage: "5 mg", price: 64, inventoryArticleId: 236 }], [{ dosage: "5 mg", price: 64, images: [image10] }]]) {
    const [variant] = getPublicShopVariants({ ...withUnrelatedImages, variants }, rows);
    assert.deepEqual(variant, legacy5);
    assert.deepEqual(Object.keys(variant), Object.keys(legacy5));
    assert.equal(Object.hasOwn(variant, "image"), false);
    assert.equal(Object.hasOwn(variant, "imageUrl"), false);
  }
});

test("empty, malformed, non-string and non-HTTPS image sources are omitted", () => {
  const invalid = [
    undefined, null, "", " ", 123, {}, [image5],
    "http://example.invalid/5.webp", "javascript:alert(1)", "data:image/webp;base64,AA==",
    "//example.invalid/5.webp", "https://", "https:///missing-host.webp",
    "https://[invalid/5.webp", "https://example.invalid:bad/5.webp",
    "https://example.invalid/bad image.webp", "https://example.invalid\\5.webp",
  ];
  for (const source of invalid) {
    const [variant] = getPublicShopVariants({ ...article, variants: [{ dosage: "5 mg", price: 64, image: source, imageUrl: source }] });
    assert.deepEqual(variant, legacy5, `unexpected image for ${JSON.stringify(source)}`);
    assert.equal(Object.hasOwn(variant, "image"), false);
  }
});

test("images do not change linked stock precedence, hidden flags, or cross-family inventory protection", () => {
  const configured = { ...article, variants: [{ dosage: "10 mg", price: 115, stock: 9, inventoryArticleId: 237, image: image10 }] };
  const linked = [{ ...inventory[1], stock: 0 }];
  assert.deepEqual(getPublicShopVariants(configured, linked), [
    { dosage: "10 mg", label: "10 mg", price: 115, stock: 0, inStock: false, articleId: 237, sku: "ELORALINTIDE-10MG", image: image10 },
  ]);
  for (const hidden of [{ hidden: true }, { isActive: false }, { isActive: 0 }]) {
    const [variant] = getPublicShopVariants({ ...configured, variants: [{ ...configured.variants[0], ...hidden }] }, inventory);
    assert.equal(variant.hidden, true);
    assert.equal(variant.inStock, false);
    assert.equal(variant.stock, 9);
    assert.equal(variant.image, image10);
  }
  const [foreign] = getPublicShopVariants(configured, [{ ...linked[0], shopProductId: "unrelated" }]);
  assert.deepEqual(foreign, { dosage: "10 mg", label: "10 mg", price: 115, stock: 9, inStock: true, articleId: 236, sku: "ELORALINTIDE-5MG", image: image10 });
});
