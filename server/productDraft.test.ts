import assert from "node:assert/strict";
import test from "node:test";
import { createProductDraftInput, getProductDraftInput, isProductDraftArticle, createProductDraft } from "./productDraft.js";
import { createFamilyInput, createSingleBlendInput } from "./productFamily.js";

function payload() {
  return { requestKey: "AABBCCDD-1122-4344-8556-66778899AABB", shopProductId: "local-new-draft", name: "New Compound",
    category: "Vials", categories: ["Vials"], shortDescription: "Unveröffentlichter Entwurf. Research Use Only.",
    description: { kurztext: "Forschungskontext.", wirkung: "Laborforschung.", fazit: "Forschungsbaustein.", risiko: "Research Use Only. Not for human use." },
    variants: [{ label: "12.5 mg", sku: "NEW-12.5MG", imageUrl: "https://example.invalid/12.5.png", price: null, stock: 0,
      composition: { totalMassMg: 12.5, components: [{ name: "Alpha", massMg: 7.5 }, { name: "Beta", massMg: 5 }] } }],
    seo: { seoTitle: "New Compound | 369 Research", seoDescription: "Research Use Only.", canonical: "https://www.369research.eu/product/local-new-draft",
      imageAlt: "New Compound 12.5 mg", ogImage: "https://example.invalid/og.png" },
    merchant: { merchantTitle: "New Compound", merchantDescription: "Research Use Only.", brand: "369 Research",
      googleProductCategory: null, productType: "Research > Vials" },
    faqs: Array.from({ length: 4 }, (_, i) => ({ lang: "de", question: `Frage ${i + 1}?`, answer: "Nur Forschungszwecke." })) };
}
const rejects = (input: unknown) => assert.equal(createProductDraftInput.safeParse(input).success, false);

test("draft accepts one decimal variant, unknown chemistry and open-price defaults", () => {
  const parsed = createProductDraftInput.parse(payload());
  assert.equal(parsed.requestKey, "aabbccdd-1122-4344-8556-66778899aabb");
  assert.equal(parsed.badge, "Entwurf"); assert.equal(parsed.casNumber, null); assert.equal(parsed.molecularWeight, null); assert.equal(parsed.purity, null);
  assert.deepEqual(parsed.social, {}); assert.deepEqual(parsed.useCaseSlugs, []);
  assert.equal(parsed.variants[0].price, null); assert.equal(parsed.variants[0].stock, 0);
  assert.deepEqual(parsed.variants[0].composition, payload().variants[0].composition);
  assert(createProductDraftInput.safeParse({ ...payload(), casNumber: "123-45-6", molecularWeight: "123 g/mol", purity: "99%" }).success);
});

test("strict top-level schema rejects publication, IDs, SQL, endpoints and credentials", () => {
  for (const field of ["publish", "publishedAt", "shopVisible", "salePrice", "saleActive", "isActive", "articleId", "masterArticleId", "articleIds",
    "inventoryArticleId", "id", "sql", "table", "tableName", "credentials", "password", "endpoint", "translations", "composition"])
    rejects({ ...payload(), [field]: true });
  rejects({ ...payload(), shopProductId: "somatide" });
  rejects({ ...payload(), shopProductId: "SOMATIDE" });
  for (const shopProductId of ["../draft", "draft;DROP", "has space", "draft_foo", "", "x".repeat(101)]) rejects({ ...payload(), shopProductId });
  assert.equal(getProductDraftInput.safeParse({ shopProductId: "local-new-draft", sql: "SELECT 1" }).success, false);
});

test("strict nested schemas reject publish/ID injections and invented prices or nonzero stocks", () => {
  const p = payload(), v = p.variants[0];
  for (const price of [0, 1, 99.95, "open", "0", undefined]) rejects({ ...p, variants: [{ ...v, price }] });
  for (const stock of [-1, 1, 0.1, "0", undefined]) rejects({ ...p, variants: [{ ...v, stock }] });
  for (const key of ["inventoryArticleId", "hidden", "shopVisible", "priceStatus", "publishedAt", "id"])
    rejects({ ...p, variants: [{ ...v, [key]: 1 }] });
  rejects({ ...p, seo: { ...p.seo, robots: "index" } });
  rejects({ ...p, merchant: { ...p.merchant, availability: "in_stock" } });
  rejects({ ...p, faqs: p.faqs.map(f => ({ ...f, articleId: 1 })) });
  rejects({ ...p, variants: [{ ...v, composition: { ...v.composition, sku: "OTHER" } }] });
  rejects({ ...p, variants: [{ ...v, composition: { ...v.composition, components: [{ name: "Alpha", massMg: 12.5, ratio: 1 }] } }] });
});

test("exact decimal sums permit 0.1+0.2 and 12.5 but reject rounded or ratio-only masses", () => {
  const p = payload(), v = p.variants[0];
  const composition = { totalMassMg: 0.3, components: [{ name: "A", massMg: 0.1 }, { name: "B", massMg: 0.2 }] };
  assert(createProductDraftInput.safeParse({ ...p, variants: [{ ...v, label: "0.3 mg", composition }] }).success);
  rejects({ ...p, variants: [{ ...v, label: "0.3 mg", composition: { ...composition, totalMassMg: 0.30000000000000004 } }] });
  rejects({ ...p, variants: [{ ...v, composition: { ...v.composition, totalMassMg: 15 } }] });
  rejects({ ...p, variants: [{ ...v, label: "15 mg" }] });
  rejects({ ...p, variants: [{ ...v, composition: { totalMassMg: 12.5, components: [{ name: "A", ratio: "3:2" }] } }] });
  for (const massMg of [0, -1, NaN, Infinity, "12.5"])
    rejects({ ...p, variants: [{ ...v, composition: { totalMassMg: 12.5, components: [{ name: "A", massMg }] } }] });
  rejects({ ...p, variants: [{ ...v, composition: { totalMassMg: 12.5, components: [] } }] });
});

test("liquid volume times concentration must be exact, positive and paired", () => {
  const p = payload(), v = p.variants[0];
  const composition = { ...v.composition, volumeMl: 2.5, concentrationMgMl: 5, solvents: ["Water"] };
  assert(createProductDraftInput.safeParse({ ...p, variants: [{ ...v, composition }] }).success);
  rejects({ ...p, variants: [{ ...v, composition: { ...composition, concentrationMgMl: 4.9 } }] });
  rejects({ ...p, variants: [{ ...v, composition: { ...v.composition, volumeMl: 2.5 } }] });
  rejects({ ...p, variants: [{ ...v, composition: { ...v.composition, concentrationMgMl: 5 } }] });
  rejects({ ...p, variants: [{ ...v, composition: { ...composition, volumeMl: 0 } }] });
  rejects({ ...p, variants: [{ ...v, composition: { ...composition, solvents: ["Water", " water "] } }] });
});

test("numeric label aliases, case-insensitive SKU aliases and component aliases reject", () => {
  const p = payload(), v = p.variants[0];
  for (const label of ["12.5mg", "12.50 mg", "12.500 mg"])
    rejects({ ...p, variants: [v, { ...v, label, sku: "OTHER" }] });
  const other = { ...v, label: "25 mg", composition: { totalMassMg: 25, components: [{ name: "A", massMg: 25 }] } };
  rejects({ ...p, variants: [v, { ...other, sku: v.sku.toLowerCase() }] });
  rejects({ ...p, variants: [{ ...v, composition: { totalMassMg: 12.5, components: [{ name: "Alpha", massMg: 7.5 }, { name: " alpha ", massMg: 5 }] } }] });
  rejects({ ...p, categories: ["Vials", " vials "] });
  rejects({ ...p, useCaseSlugs: ["recovery", "recovery"] });
  rejects({ ...p, faqs: [p.faqs[0], { ...p.faqs[0], question: " frage 1? " }, ...p.faqs.slice(2)] });
});

test("bounded texts, exact canonical HTTPS and DE-only FAQs reject invalid metadata", () => {
  const p = payload();
  for (const [key, max] of [["name", 160], ["shortDescription", 2000], ["badge", 100], ["casNumber", 50], ["molecularWeight", 50], ["purity", 20]] as const)
    rejects({ ...p, [key]: "x".repeat(max + 1) });
  for (const [key, max] of [["seoTitle", 60], ["seoDescription", 155], ["imageAlt", 200]] as const)
    rejects({ ...p, seo: { ...p.seo, [key]: "x".repeat(max + 1) } });
  for (const canonical of ["https://www.369research.eu.evil.invalid/product/local-new-draft", "https://369research.eu/product/local-new-draft",
    "https://www.369research.eu/product/other", `${p.seo.canonical}/`, `${p.seo.canonical}?x=1`]) rejects({ ...p, seo: { ...p.seo, canonical } });
  for (const imageUrl of ["http://example.invalid/a.png", "https://secret:password@example.invalid/a.png", "data:image/png;base64,eA=="])
    rejects({ ...p, variants: [{ ...p.variants[0], imageUrl }] });
  rejects({ ...p, faqs: p.faqs.slice(0, 3) });
  rejects({ ...p, faqs: [...p.faqs, ...p.faqs.slice(0, 3)] });
  rejects({ ...p, faqs: p.faqs.map(f => ({ ...f, lang: "en" })) });
  rejects({ ...p, variants: [] }); rejects({ ...p, variants: Array.from({ length: 11 }, () => p.variants[0]) });
  rejects({ ...p, useCaseSlugs: Array.from({ length: 21 }, (_, i) => `use-${i}`) });
});

test("real bounded JSON preserves social drafts but rejects operational metadata, cycles and missing RUO", () => {
  const p = payload();
  const social = { instagram: { caption: "Research Use Only.", hashtags: ["research"] }, whatsapp: "Preis offen." };
  assert.deepEqual(createProductDraftInput.parse({ ...p, social }).social, social);
  for (const description of [JSON.stringify(p.description), {}, { ...p.description, risiko: "" }, { ...p.description, x: "x".repeat(50001) },
    { ...p.description, composition: p.variants[0].composition }, { ...p.description, draftMeta: { isDraft: false } },
    { ...p.description, eigenschaften: { composition: p.variants[0].composition } }, { ...p.description, x: new Date() },
    { ...p.description, x: undefined }, { ...p.description, x: () => 1 }, { ...p.description, x: NaN }]) rejects({ ...p, description });
  rejects({ ...p, description: { kurztext: "a", wirkung: "b", fazit: "c", risiko: "d" } });
  rejects({ ...p, social: "text" }); rejects({ ...p, social: { draftMeta: { isDraft: false } } });
  rejects({ ...p, social: { publish: true } });
  rejects({ ...p, description: { ...p.description, properties: { totalMassMg: 999 } } });
  rejects({ ...p, description: { ...p.description, components: [{ name: "False composition", massMg: 999 }] } });
  const cycle: any = {}; cycle.self = cycle; rejects({ ...p, social: cycle });
  let deep: any = 1; for (let i = 0; i < 8; i++) deep = { a: deep }; rejects({ ...p, social: deep });
  rejects({ ...p, social: { items: Array.from({ length: 2001 }, () => "a") } });
});

test("visibility guard recognizes only exact boolean marker and does not infer legacy identity", () => {
  for (const description of [undefined, null, "{}", [], {}, { draftMeta: null }, { draftMeta: "true" },
    { draftMeta: { isDraft: false } }, { draftMeta: { isDraft: "true" } }, { draftMeta: { isDraft: 1 } }])
    assert.equal(isProductDraftArticle({ description }), false);
  assert.equal(isProductDraftArticle({ description: { draftMeta: { isDraft: true } } }), true);
  assert.equal(isProductDraftArticle({ description: { draftMeta: { isDraft: true, status: "draft", priceStatus: "open" } } }), true);
});

test("service revalidates direct calls before database access; existing strict contracts are not broadened", async () => {
  let touched = false;
  const db = { transaction: () => { touched = true; throw Error("DB must not be reached"); } };
  await assert.rejects(createProductDraft(db as any, { ...payload(), shopVisible: 1 } as any, "unit"), (e: any) => e.code === "BAD_REQUEST");
  assert.equal(touched, false);
  assert.equal(createFamilyInput.safeParse(payload()).success, false);
  assert.equal(createSingleBlendInput.safeParse(payload()).success, false);
});
