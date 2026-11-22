import assert from "node:assert/strict";
import test, { before, after, beforeEach, mock } from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { ENV } from "./env.js";
import { closeDb, getPool } from "./db.js";
import { productAdminRouter } from "./productAdminRouter.js";
import { router, adminProcedure } from "./trpc.js";
import { articleRouter, getPublicShopVariants } from "./articleRouter.js";
import { createFamilyInput, createSingleBlendInput } from "./productFamily.js";
import { singleBlendCompositionSchema } from "./singleBlendComposition.js";
import { validateProductData } from "./productValidation.js";

// Never skips; must run under our secret-free disposable PostgreSQL wrapper.
const socket = process.env.FAMILY_TEST_PG_SOCKET;
if (!socket?.startsWith("/tmp/369-product-family.") || !socket.endsWith("/socket")
  || process.env.DATABASE_URL || process.env.RAILWAY_DB_URL
  || process.env.DOTENV_CONFIG_PATH !== "/dev/null" || process.env.FAMILY_TEST_SANITIZED !== "1")
  throw Error("DEDICATED_LOCAL_SECRET_FREE_FIXTURE_REQUIRED");
const app = router({ productAdmin: productAdminRouter, article: articleRouter });
const manager = { id: 2, username: "local_product_manager", role: "product_manager", name: null, email: null };
const caller = (user: any = manager) => app.createCaller({ req: { headers: {} }, res: {}, user } as any).productAdmin;
let pool: NonNullable<Awaited<ReturnType<typeof getPool>>>;
let networkCalls = 0;
const productTables = ["articles", "article_seo", "article_merchant", "article_translations", "article_faq", "article_use_cases", "stock_history", "product_audit_log", "use_cases"];
async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const table of productTables) result[table] = (await pool.query("SELECT to_regclass($1) AS oid", [table])).rows[0].oid
    ? (await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows : null;
  return result;
}
async function articleSequence() {
  // PostgreSQL sequences do not roll back: an unchanged sequence proves that
  // rejection happened before any attempted article insertion, not just rollback.
  return (await pool.query("SELECT last_value, is_called FROM articles_id_seq")).rows[0];
}
async function withSchemaChange(statement: string, work: () => Promise<void>) {
  await pool.query(statement);
  try { await work(); } finally {
    // Restore only our secret-free disposable schema, including CASCADE'd FKs.
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await pool.query(readFileSync(`${socket}/../schema.sql`, "utf8"));
    await seedFixture();
  }
}
function payload(shopProductId = "local-eloralintide") {
  return { requestKey: randomUUID(), shopProductId, name: "Eloralintide", category: "Vials",
    categories: ["Metabolisch & Körperkomposition"], shortDescription: "99 % Reinheit garantiert. Research Use Only. Not for human use.",
    badge: "Amylinrezeptor-Forschung", casNumber: "2883634-40-8", molecularWeight: "ca. 4526,1 g/mol (Referenzwert)", purity: "99% garantiert",
    description: { kurztext: "Modifiziertes Amylinanalogon für Laborforschung.", wirkung: "AMY1-Rezeptor und cAMP-Signalwege in Zellassays.",
      highlights: ["99 % Reinheit garantiert", "5 mg oder 10 mg"], eigenschaften: { reinheit: "99 % Reinheit garantiert" },
      fazit: "Gezielter Forschungsbaustein.", risiko: "Research Use Only. Not for human use.", quellen: ["https://example.invalid/research"] },
    variants: [{ label: "5 mg", sku: `${shopProductId}-5MG`, price: 64, stock: 9, imageUrl: "https://example.invalid/5mg.png" },
      { label: "10 mg", sku: `${shopProductId}-10MG`, price: 115, stock: 9, imageUrl: "https://example.invalid/10mg.png" }],
    seo: { seoTitle: "Eloralintide 5 mg & 10 mg | 369 Research", seoDescription: "Amylinrezeptor-Forschung. 99 % Reinheit garantiert. Research Use Only.",
      canonical: `https://www.369research.eu/product/${shopProductId}`, imageAlt: "Eloralintide Research-Vials 5 mg und 10 mg", ogImage: "https://example.invalid/og.png" },
    merchant: { merchantTitle: "Eloralintide Research-Vial", merchantDescription: "99 % Reinheit garantiert. Research Use Only. Not for human use.",
      brand: "369 Research", googleProductCategory: "491", productType: "Research > Vials > Amylinrezeptor-Forschung" },
    faqs: Array.from({ length: 6 }, (_, i) => ({ lang: "de", question: `Forschungsfrage ${i + 1}?`, answer: "Ausschließlich für Laborforschung. Research Use Only. Not for human use." })),
    useCaseSlugs: ["metabolic-research"], translations: [] as any[] };
}
const conflict = (e: any) => e.code === "CONFLICT";
const denied = (e: any) => ["FORBIDDEN", "UNAUTHORIZED"].includes(e.code);
const pub = <S extends string>(created: { shopProductId: S; masterArticleId: number }, requestKey = randomUUID()) =>
  ({ shopProductId: created.shopProductId, masterArticleId: created.masterArticleId, requestKey });
async function failAudit(action: string, work: () => Promise<unknown>) {
  await pool.query(`CREATE FUNCTION local_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='${action}' THEN RAISE EXCEPTION 'LOCAL_AUDIT_FAILURE'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER local_audit_failure BEFORE INSERT ON product_audit_log FOR EACH ROW EXECUTE FUNCTION local_fail_audit()`);
  try { await work(); } finally { await pool.query("DROP TRIGGER local_audit_failure ON product_audit_log; DROP FUNCTION local_fail_audit()"); }
}

before(async () => {
  mock.method(globalThis, "fetch", async () => { networkCalls++; throw Error("NETWORK_FORBIDDEN"); });
  await closeDb();
  // Erase even env.ts legacy fallbacks; tests never load real external keys.
  for (const key of Object.keys(ENV) as Array<keyof typeof ENV>) {
    if (/key|password|secret/i.test(key)) (ENV as any)[key] = "";
  }
  ENV.databaseUrl = `postgresql://family_local@localhost:55461/postgres?host=${encodeURIComponent(socket!)}`;
  const local = await getPool(); assert(local); pool = local;
  assert.equal((await pool.query("SELECT current_user")).rows[0].current_user, "family_local");
});
async function seedFixture() {
  await pool.query("TRUNCATE article_seo,article_merchant,article_translations,article_faq,article_use_cases,stock_history,product_audit_log,articles,use_cases RESTART IDENTITY CASCADE");
  await pool.query("INSERT INTO use_cases(slug,visible) VALUES('metabolic-research',0),('fat-loss',1)");
  await pool.query("INSERT INTO articles(sku,name,shop_product_id,selling_price,stock,shop_visible,is_active,purity) VALUES('EXISTING-SKU','Unrelated sentinel (20 mg)','unrelated-existing',123.45,7,1,1,'99%')");
  await pool.query("INSERT INTO article_seo(article_id,slug,seo_title) VALUES(1,'unrelated-existing','Untouched SEO'); INSERT INTO article_merchant(article_id,brand) VALUES(1,'Untouched brand'); INSERT INTO stock_history(article_id,change_type,quantity_before,quantity_change,quantity_after,reason) VALUES(1,'wareneingang',0,7,7,'sentinel'); INSERT INTO product_audit_log(article_id,action,changed_by,new_value) VALUES(1,'SENTINEL','fixture','untouched')");
}
beforeEach(seedFixture);
after(async () => {
  assert.equal(networkCalls, 0);
  console.log("Isolation evidence: external HTTP calls=0; dedicated family_local PostgreSQL fixture; external credentials erased.");
  await closeDb(); ENV.databaseUrl = ""; mock.restoreAll();
});

test("missing-family read returns null master and only existing use-case slugs without writes", async () => {
  const old = await snapshot(), result = await caller().getFamily({ shopProductId: "does-not-exist" });
  assert.equal(result.master, null); assert.equal(result.masterArticleId, null); assert.deepEqual(result.articles, []);
  assert.deepEqual(result.availableUseCases.map(u => ({ slug: u.slug, visible: u.visible })), [{ slug: "fat-loss", visible: 1 }, { slug: "metabolic-research", visible: 0 }]);
  assert.deepEqual(await snapshot(), old);
});

test("hidden creation writes linked inventory IDs, exact prices/stock, stock audit and master-only complete metadata", async () => {
  const input = payload(), old = await snapshot(), created = await caller().createFamily(input);
  assert.equal(created.success, true); assert.equal(created.shopVisible, false);
  assert.equal(created.articleIds.length, 2); assert.equal(created.masterArticleId, created.articleIds[0]);
  const family = await caller().getFamily({ shopProductId: input.shopProductId });
  assert.equal(family.masterArticleId, created.masterArticleId); assert(family.master);
  assert.equal(family.master.purity, "99% garantiert"); assert.deepEqual(family.master.description, input.description);
  assert.deepEqual(family.master.galleryImages, input.variants.map(v => v.imageUrl));
  assert.deepEqual(family.articles.map(a => [a.name, a.sellingPrice, a.stock, a.shopVisible, a.isActive]),
    [["Eloralintide (5 mg)", "64.00", 9, 0, 1], ["Eloralintide (10 mg)", "115.00", 9, 0, 1]]);
  assert.equal(family.articles[1].variants, null);
  for (const [i, v] of created.variants.entries()) {
    assert.equal(v.inventoryArticleId, family.articles[i].id); assert.equal(v.price, Number(family.articles[i].sellingPrice));
    assert.equal(v.stock, family.articles[i].stock); assert.equal(v.imageUrl, input.variants[i].imageUrl);
  }
  assert.equal(family.seo?.canonical, input.seo.canonical); assert.equal(family.seo?.faqEnabled, 1);
  assert.equal(family.merchant?.merchantTitle, input.merchant.merchantTitle);
  assert.equal(family.translations.length, 1); assert.equal(family.translations[0].lang, "de");
  assert.equal(family.translations[0].merchantTitle, input.merchant.merchantTitle);
  assert.equal(family.translations[0].merchantDescription, input.merchant.merchantDescription);
  assert.equal(family.faqs.length, 6); assert(family.faqs.every(f => f.articleId === created.masterArticleId));
  assert.equal(family.productSchemaStatus.faqLayout, "current");
  const { getDb } = await import("./db.js"), { articleFaq } = await import("../drizzle/schema.js");
  const { asc } = await import("drizzle-orm");
  assert.deepEqual(family.faqs, await (await getDb())!.select().from(articleFaq).orderBy(asc(articleFaq.sortOrder), asc(articleFaq.id)));
  assert.equal(family.useCases.length, 1); assert.equal(family.useCases[0].slug, "metabolic-research");
  assert.equal(family.validation?.isValid, true); assert.equal(family.validation?.score, 100); assert.deepEqual(family.validation?.warnings, []);
  const logs = (await pool.query("SELECT * FROM stock_history WHERE article_id=ANY($1::int[]) ORDER BY article_id", [created.articleIds])).rows;
  assert.equal(logs.length, 2); assert(logs.every(l => l.change_type === "wareneingang" && l.reason === "Produktanlage" && l.quantity_before === 0 && l.quantity_change === 9 && l.quantity_after === 9));
  const audit = (await pool.query("SELECT * FROM product_audit_log WHERE article_id=$1", [created.masterArticleId])).rows;
  assert.equal(audit.length, 1); assert.equal(audit[0].action, "CREATE_FAMILY"); assert.equal(audit[0].field_name, `request:${input.requestKey}`);
  assert.match(JSON.parse(audit[0].new_value).fingerprint, /^[a-f0-9]{64}$/);
  const now: any = await snapshot(), prior: any = old;
  for (const table of productTables) {
    if (["articles", "article_seo", "article_merchant", "stock_history", "product_audit_log"].includes(table))
      assert.deepEqual(now[table].filter((r: any) => r.id === 1), prior[table]);
  }
  assert.deepEqual(now.use_cases, prior.use_cases);
});

test("canonical object-key order replay and three concurrent identical UUIDs return original IDs without duplicates", async () => {
  const input = payload();
  const results = await Promise.all([caller().createFamily(input), caller().createFamily(input), caller().createFamily(input)]);
  assert.deepEqual(results[1], results[0]); assert.deepEqual(results[2], results[0]);
  const stable = await snapshot();
  const reordered: Record<string, unknown> = Object.fromEntries(Object.entries(input).reverse());
  reordered.description = Object.fromEntries(Object.entries(input.description).reverse());
  assert.deepEqual(await caller().createFamily(reordered as any), results[0]);
  assert.deepEqual(await snapshot(), stable);
});

test("changed payload or changed family with same request UUID rejects, preserving all rows", async () => {
  const input = payload(); await caller().createFamily(input); const stable = await snapshot();
  await assert.rejects(caller().createFamily({ ...input, badge: "changed" }), conflict);
  const changed = payload("different-family"); changed.requestKey = input.requestKey;
  await assert.rejects(caller().createFamily(changed), conflict); assert.deepEqual(await snapshot(), stable);
});

test("existing family, SKU and independent SEO slug collisions never overwrite", async () => {
  const input = payload(); await caller().createFamily(input); const stable = await snapshot();
  await assert.rejects(caller().createFamily({ ...input, requestKey: randomUUID() }), conflict);
  const sku = payload("sku-collision"); sku.variants[1].sku = "EXISTING-SKU";
  await assert.rejects(caller().createFamily(sku), conflict);
  const seo = payload("unrelated-existing"); await assert.rejects(caller().createFamily(seo), conflict);
  await pool.query("INSERT INTO article_seo(article_id,slug) VALUES(1,'seo-slug-only')");
  const withSeo = await snapshot(); await assert.rejects(caller().createFamily(payload("seo-slug-only")), conflict);
  assert.deepEqual(await snapshot(), withSeo);
  await pool.query("DELETE FROM article_seo WHERE slug='seo-slug-only'"); assert.deepEqual(await snapshot(), stable);
});

test("concurrent new request keys collide safely by family and sorted overlapping SKU locks", async () => {
  const a = payload(), b = { ...a, requestKey: randomUUID() };
  const same = await Promise.allSettled([caller().createFamily(a), caller().createFamily(b)]);
  assert.equal(same.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(same.filter(r => r.status === "rejected" && conflict(r.reason)).length, 1);
  const x = payload("concurrent-a"), y = payload("concurrent-b");
  x.variants[0].sku = "SHARED-A"; x.variants[1].sku = "SHARED-B";
  y.variants[0].sku = "SHARED-B"; y.variants[1].sku = "SHARED-A";
  const overlap = await Promise.allSettled([caller().createFamily(x), caller().createFamily(y)]);
  assert.equal(overlap.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(overlap.filter(r => r.status === "rejected" && conflict(r.reason)).length, 1);
  assert.equal((await pool.query("SELECT count(*)::int n FROM articles")).rows[0].n, 5);
});

test("mandatory product-audit failure rolls back entire creation, inventory history and all metadata", async () => {
  const before = await snapshot(), input = payload();
  await failAudit("CREATE_FAMILY", async () => { await assert.rejects(caller().createFamily(input)); });
  assert.deepEqual(await snapshot(), before);
  // The same UUID can succeed after the failed transaction; no hidden idempotency tombstone.
  assert.equal((await caller().createFamily(input)).articleIds.length, 2);
});

test("stock-history insert failure also rolls back entire creation", async () => {
  const stable = await snapshot();
  await pool.query("CREATE FUNCTION local_fail_stock() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.reason='Produktanlage' THEN RAISE EXCEPTION 'LOCAL_STOCK_AUDIT_FAILURE'; END IF; RETURN NEW; END $$; CREATE TRIGGER local_stock_failure BEFORE INSERT ON stock_history FOR EACH ROW EXECUTE FUNCTION local_fail_stock()");
  try { await assert.rejects(caller().createFamily(payload())); } finally { await pool.query("DROP TRIGGER local_stock_failure ON stock_history; DROP FUNCTION local_fail_stock()"); }
  assert.deepEqual(await snapshot(), stable);
});

test("invalid SEO injected after insertion rolls back creation rather than committing an incomplete draft", async () => {
  const stable = await snapshot();
  await pool.query("CREATE FUNCTION local_break_seo() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.seo_title=repeat('x',61); RETURN NEW; END $$; CREATE TRIGGER local_invalid_seo BEFORE INSERT ON article_seo FOR EACH ROW EXECUTE FUNCTION local_break_seo()");
  try { await assert.rejects(caller().createFamily(payload())); } finally { await pool.query("DROP TRIGGER local_invalid_seo ON article_seo; DROP FUNCTION local_break_seo()"); }
  assert.deepEqual(await snapshot(), stable);
});

test("publication accepts only the exact master, is audited/idempotent and keeps every child hidden", async () => {
  const created = await caller().createFamily(payload()), publish = pub(created);
  const hidden = await snapshot();
  await assert.rejects(caller().publishFamily({ ...publish, masterArticleId: created.articleIds[1] }), conflict);
  await assert.rejects(caller().publishFamily({ ...publish, masterArticleId: 1 }), conflict);
  assert.deepEqual(await snapshot(), hidden);
  const result = await caller().publishFamily(publish); assert.equal(result.shopVisible, true);
  const family = await caller().getFamily({ shopProductId: created.shopProductId });
  assert.equal(family.master?.shopVisible, 1); assert(family.master?.publishedAt); assert.equal(family.articles[1].shopVisible, 0);
  const published: any = await snapshot();
  assert.deepEqual(await caller().publishFamily(publish), result); assert.deepEqual(await snapshot(), published);
  assert.equal(published.product_audit_log.filter((a: any) => a.action === "PUBLISH_FAMILY").length, 1);
  assert.deepEqual(published.stock_history, (hidden as any).stock_history);
  assert.deepEqual(published.articles[0], (hidden as any).articles[0]);
  // Create replay remains the original hidden-creation response even after publication.
  const audit = published.product_audit_log.find((a: any) => a.action === "CREATE_FAMILY");
  assert.equal(JSON.parse(audit.new_value).response.shopVisible, false);
  const noOp = pub(created);
  assert.deepEqual(await caller().publishFamily(noOp), result);
  const noOpState: any = await snapshot();
  assert.deepEqual(noOpState.articles, published.articles);
  assert.equal(noOpState.product_audit_log.filter((a: any) => a.action === "PUBLISH_FAMILY").length, 2);
  assert.deepEqual(await caller().publishFamily(noOp), result);
  assert.deepEqual(await snapshot(), noOpState);
});

test("publication request key cannot be reused for another family, child or create action", async () => {
  const inputA = payload("family-a"), inputB = payload("family-b");
  const a = await caller().createFamily(inputA), b = await caller().createFamily(inputB), publish = pub(a);
  await caller().publishFamily(publish); const stable = await snapshot();
  await assert.rejects(caller().publishFamily(pub(b, publish.requestKey)), conflict);
  await assert.rejects(caller().publishFamily({ ...publish, masterArticleId: a.articleIds[1] }), conflict);
  await assert.rejects(caller().publishFamily(pub(a, inputA.requestKey)), conflict);
  assert.deepEqual(await snapshot(), stable);
});

test("publication audit failure rolls visibility/timestamps back atomically", async () => {
  const created = await caller().createFamily(payload()), stable = await snapshot();
  await failAudit("PUBLISH_FAMILY", async () => { await assert.rejects(caller().publishFamily(pub(created))); });
  assert.deepEqual(await snapshot(), stable);
});

test("publication fails closed on invalid persisted SEO, description, links, prices, stock and ambiguous master", async () => {
  const created = await caller().createFamily(payload());
  const cases: Array<[string, unknown[]]> = [
    ["UPDATE article_seo SET seo_title=repeat('x',61) WHERE article_id=$1", [created.masterArticleId]],
    ["UPDATE article_seo SET canonical='https://www.369research.eu.evil.invalid/product/local-eloralintide' WHERE article_id=$1", [created.masterArticleId]],
    ["UPDATE articles SET description='{}'::jsonb WHERE id=$1", [created.masterArticleId]],
    ["UPDATE article_translations SET merchant_title=NULL WHERE article_id=$1", [created.masterArticleId]],
    ["UPDATE articles SET selling_price=114 WHERE id=$1", [created.articleIds[1]]],
    ["UPDATE articles SET stock=8 WHERE id=$1", [created.articleIds[1]]],
    ["UPDATE articles SET variants=jsonb_set(variants,'{1,inventoryArticleId}','1'::jsonb) WHERE id=$1", [created.masterArticleId]],
    ["UPDATE articles SET shop_visible=1 WHERE id=$1", [created.articleIds[1]]],
    ["UPDATE articles SET variants=(SELECT variants FROM articles WHERE id=$1) WHERE id=$2", [created.masterArticleId, created.articleIds[1]]],
    ["DELETE FROM article_faq WHERE id IN (SELECT id FROM article_faq WHERE article_id=$1 LIMIT 3)", [created.masterArticleId]],
  ];
  const original: any = await snapshot();
  for (const [statement, values] of cases) {
    await pool.query(statement, values); const invalid = await snapshot();
    await assert.rejects(caller().publishFamily(pub(created))); assert.deepEqual(await snapshot(), invalid);
    // Restore only this disposable product fixture from its known original values.
    for (const row of original.articles.filter((a: any) => created.articleIds.includes(a.id)))
      await pool.query("UPDATE articles SET variants=$2::jsonb,stock=$3,selling_price=$4,description=$5::jsonb,shop_visible=$6 WHERE id=$1", [row.id, JSON.stringify(row.variants), row.stock, row.selling_price, JSON.stringify(row.description), row.shop_visible]);
    await pool.query("UPDATE article_seo SET seo_title=$2,canonical=$3 WHERE article_id=$1", [created.masterArticleId, original.article_seo[1].seo_title, original.article_seo[1].canonical]);
    await pool.query("UPDATE article_translations SET merchant_title=$2 WHERE article_id=$1", [created.masterArticleId, original.article_translations[0].merchant_title]);
  }
});

test("strict bounded input rejects invalid canonical, SEO, price, stock, purity, duplicate variants and unknown fields without writes", async () => {
  const input = payload(), stable = await snapshot();
  const invalid: any[] = [
    { ...input, seo: { ...input.seo, seoTitle: "x".repeat(61) } },
    { ...input, seo: { ...input.seo, seoDescription: "x".repeat(156) } },
    { ...input, seo: { ...input.seo, canonical: "https://www.369research.eu.evil.invalid/product/local-eloralintide" } },
    { ...input, purity: "99 % Reinheit garantiert" }, { ...input, saleActive: true },
    { ...input, variants: [input.variants[0]] },
    { ...input, variants: input.variants.map(v => ({ ...v, sku: "DUPLICATE" })) },
    { ...input, variants: [{ ...input.variants[0], label: "5mg" }, { ...input.variants[1], label: "5.0 mg" }] },
    { ...input, variants: [{ ...input.variants[0], price: 64.001 }, input.variants[1]] },
    { ...input, variants: [{ ...input.variants[0], price: 0 }, input.variants[1]] },
    { ...input, variants: [{ ...input.variants[0], stock: -1 }, input.variants[1]] },
    { ...input, variants: [{ ...input.variants[0], stock: 1.5 }, input.variants[1]] },
    { ...input, variants: [{ ...input.variants[0], imageUrl: "http://example.invalid/a.png" }, input.variants[1]] },
    { ...input, variants: [{ ...input.variants[0], imageUrl: "https://secret:password@example.invalid/a.png" }, input.variants[1]] },
    { ...input, description: {} }, { ...input, description: { ...input.description, risiko: "" } },
    { ...input, description: { ...input.description, x: "x".repeat(50001) } },
    { ...input, description: { ...input.description, x: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } } } },
    { ...input, shortDescription: "Keine Laborangabe", description: { ...input.description, risiko: "Kein Hinweis" } },
    { ...input, shortDescription: "Dosierung und Therapie für Menschen" },
    { ...input, faqs: input.faqs.slice(0, 3) },
    { ...input, useCaseSlugs: ["not-existing"] },
    { ...input, translations: [{ lang: "de", name: "Wrong", shortDescription: input.shortDescription, description: input.description,
      merchantTitle: input.merchant.merchantTitle, merchantDescription: input.merchant.merchantDescription }] },
  ];
  for (const bad of invalid) { await assert.rejects(caller().createFamily(bad)); assert.deepEqual(await snapshot(), stable); }
});

test("zero and unequal variant stocks remain per-article, optional translation only on master", async () => {
  const input = payload(); input.variants[0].stock = 0; input.variants[1].stock = 13;
  input.translations.push({ lang: "en", name: "Eloralintide", shortDescription: "Research Use Only.",
    description: input.description, merchantTitle: "Eloralintide Research Vial", merchantDescription: "Research Use Only. Not for human use." });
  const created = await caller().createFamily(input), family = await caller().getFamily({ shopProductId: input.shopProductId });
  assert.deepEqual(family.articles.map(a => a.stock), [0, 13]); assert.deepEqual(created.variants.map(v => v.stock), [0, 13]);
  assert.equal(family.master?.stock, 0); assert.equal(family.merchant?.availability, "in_stock");
  assert.deepEqual(family.translations.map(t => t.lang), ["de", "en"]); assert(family.translations.every(t => t.articleId === created.masterArticleId));
  assert(family.master);
  const publicVariants = getPublicShopVariants(family.master, family.articles);
  assert.deepEqual(publicVariants.map(v => [v.dosage, v.price, v.stock, v.articleId, v.sku]),
    [["5 mg", 64, 0, created.articleIds[0], input.variants[0].sku], ["10 mg", 115, 13, created.articleIds[1], input.variants[1].sku]]);
  await caller().publishFamily(pub(created));
  const logs = (await pool.query("SELECT quantity_before,quantity_change,quantity_after FROM stock_history WHERE article_id=ANY($1::int[]) ORDER BY article_id", [created.articleIds])).rows;
  assert.deepEqual(logs, [{ quantity_before: 0, quantity_change: 0, quantity_after: 0 }, { quantity_before: 0, quantity_change: 13, quantity_after: 13 }]);
});

test("manager is allowed, customers/packing/unauthenticated are denied on all three real endpoints; shared rights unchanged", async () => {
  const input = payload(), stable = await snapshot();
  for (const principal of [null, { ...manager, role: "user" }, { ...manager, role: "customer" }, { ...manager, role: "packing" }]) {
    const c = caller(principal);
    await assert.rejects(c.createFamily(input), denied);
    await assert.rejects(c.getFamily({ shopProductId: input.shopProductId }), denied);
    await assert.rejects(c.publishFamily({ shopProductId: input.shopProductId, masterArticleId: 2, requestKey: randomUUID() }), denied);
  }
  assert.deepEqual(await snapshot(), stable);
  const adminOnly = router({ probe: adminProcedure.query(() => "admin") });
  await assert.rejects(adminOnly.createCaller({ req: { headers: { "x-role": "admin" } }, res: {}, user: { ...manager, meta: { role: "admin" } } } as any).probe(), denied);
  assert.equal((await caller().createFamily(input)).success, true);
  const routerSource = readFileSync(new URL("./productAdminRouter.ts", import.meta.url), "utf8");
  assert.match(routerSource, /createFamily: productManagerProcedure/); assert.match(routerSource, /getFamily: productManagerProcedure/); assert.match(routerSource, /publishFamily: productManagerProcedure/);
  const serviceSource = readFileSync(new URL("./productFamily.ts", import.meta.url), "utf8");
  assert(!/\b(customers|orders|payments|invoices|users)\b/.test(serviceSource));
  assert(!/ALTER TABLE|CREATE TABLE|ensure.*Schema|saleActive|limit\(1\)/.test(serviceSource));
});

test("schema status exposes only fixed product table booleans and required field names without writes", async () => {
  const stable = await snapshot(), sequence = await articleSequence();
  const result = await caller().getFamily({ shopProductId: "does-not-exist" });
  assert.deepEqual(Object.keys(result.productSchemaStatus).sort(), ["faqLayout", "missingRequiredFields", "tables"]);
  assert.equal(result.productSchemaStatus.faqLayout, "current");
  assert.deepEqual(Object.keys(result.productSchemaStatus.tables).sort(), [...productTables].sort());
  assert(Object.values(result.productSchemaStatus.tables).every(value => value === true));
  assert.deepEqual(result.productSchemaStatus.missingRequiredFields, []);
  await assert.rejects(caller().getFamily({ shopProductId: "does-not-exist", sql: "SELECT 1" } as any));
  assert.deepEqual(await snapshot(), stable); assert.deepEqual(await articleSequence(), sequence);
});

test("dropped optional tables: absent read, hidden creation, exact metadata/FAQ/stock, publication and final read succeed without links", async () => {
  for (const statement of ["DROP TABLE article_use_cases; DROP TABLE use_cases CASCADE", "DROP TABLE article_use_cases", "DROP TABLE use_cases CASCADE"]) {
    await withSchemaChange(statement, async () => {
      const input = payload(); input.useCaseSlugs = [];
      const old: any = await snapshot(), absent = await caller().getFamily({ shopProductId: input.shopProductId });
      assert.equal(absent.master, null); assert.deepEqual(absent.productSchemaStatus.missingRequiredFields, []);
      assert.equal(absent.productSchemaStatus.tables.use_cases, old.use_cases !== null);
      assert.equal(absent.productSchemaStatus.tables.article_use_cases, old.article_use_cases !== null);
      assert.deepEqual(absent.useCases, []);
      assert.equal(absent.availableUseCases.length, old.use_cases === null ? 0 : 2);
      assert.deepEqual(await snapshot(), old);
      const created = await caller().createFamily(input), hidden = await caller().getFamily({ shopProductId: input.shopProductId });
      assert(hidden.articles.every(a => a.shopVisible === 0 && a.publishedAt === null));
      assert.deepEqual(hidden.useCases, []); assert.equal(hidden.validation?.score, 100);
      assert.equal(hidden.seo?.canonical, input.seo.canonical); assert.equal(hidden.seo?.faqEnabled, 1);
      assert.equal(hidden.merchant?.merchantTitle, input.merchant.merchantTitle);
      assert.equal(hidden.merchant?.merchantDescription, input.merchant.merchantDescription);
      assert.equal(hidden.translations.length, 1); assert.equal(hidden.translations[0].merchantDescription, input.merchant.merchantDescription);
      assert.deepEqual(hidden.faqs.map(f => ({ lang: f.lang, question: f.question, answer: f.answer })), input.faqs);
      assert(hidden.faqs.every(f => f.articleId === created.masterArticleId && f.isVisible === 1));
      assert.deepEqual(hidden.articles.map(a => [a.sellingPrice, a.stock]), [["64.00", 9], ["115.00", 9]]);
      const stocks = (await pool.query("SELECT article_id,change_type,quantity_before,quantity_change,quantity_after,reason FROM stock_history WHERE article_id=ANY($1::int[]) ORDER BY article_id", [created.articleIds])).rows;
      assert.deepEqual(stocks, created.articleIds.map(articleId => ({ article_id: articleId, change_type: "wareneingang", quantity_before: 0, quantity_change: 9, quantity_after: 9, reason: "Produktanlage" })));
      const beforePublish: any = await snapshot();
      const publish = pub(created); assert.equal((await caller().publishFamily(publish)).shopVisible, true);
      const family = await caller().getFamily({ shopProductId: input.shopProductId });
      assert.equal(family.master?.shopVisible, 1); assert(family.master?.publishedAt); assert.equal(family.articles[1].shopVisible, 0);
      assert.equal(family.articles[1].publishedAt, null); assert.deepEqual(family.useCases, []);
      assert.deepEqual(family.seo, hidden.seo); assert.deepEqual(family.merchant, hidden.merchant);
      assert.deepEqual(family.faqs, hidden.faqs); assert.deepEqual(family.translations, hidden.translations);
      const now: any = await snapshot();
      assert.deepEqual(now.stock_history, beforePublish.stock_history);
      for (const table of ["articles", "article_seo", "article_merchant", "stock_history", "product_audit_log"])
        assert.deepEqual(now[table].filter((r: any) => r.id === 1), old[table]);
      assert.deepEqual(now.use_cases, old.use_cases);
      assert.deepEqual(now.product_audit_log.filter((r: any) => r.article_id === created.masterArticleId).map((r: any) => r.action), ["CREATE_FAMILY", "PUBLISH_FAMILY"]);
      const published = await snapshot(); await caller().publishFamily(publish); assert.deepEqual(await snapshot(), published);
    });
  }
});

test("explicit slugs with missing/incompatible optional relations reject clearly before any insert; unknown slugs do not create global use cases", async () => {
  for (const statement of ["DROP TABLE article_use_cases; DROP TABLE use_cases CASCADE", "DROP TABLE article_use_cases", "DROP TABLE use_cases CASCADE",
    "ALTER TABLE use_cases DROP COLUMN slug", "ALTER TABLE article_use_cases DROP COLUMN use_case_id",
    "ALTER TABLE use_cases ALTER COLUMN slug TYPE integer USING id"]) {
    await withSchemaChange(statement, async () => {
      const stable = await snapshot(), sequence = await articleSequence();
      await assert.rejects(caller().createFamily(payload()), (e: any) => e.code === "BAD_REQUEST" && /Use-Case-Slugs.*fehlen oder sind inkompatibel/.test(e.message));
      assert.deepEqual(await snapshot(), stable); assert.deepEqual(await articleSequence(), sequence);
      const noLinks = payload(); noLinks.useCaseSlugs = [];
      const created = await caller().createFamily(noLinks); await caller().publishFamily(pub(created));
      assert.deepEqual((await caller().getFamily({ shopProductId: noLinks.shopProductId })).useCases, []);
    });
  }
  const unknown = payload(); unknown.useCaseSlugs = ["not-existing"];
  const stable = await snapshot(), sequence = await articleSequence();
  await assert.rejects(caller().createFamily(unknown), (e: any) => e.code === "BAD_REQUEST" && /Use-Case-Slug existiert nicht/.test(e.message));
  assert.deepEqual(await snapshot(), stable); assert.deepEqual(await articleSequence(), sequence);
});

test("obsolete visible column and missing nonessential link fields do not break read/create/publish or assume visibility", async () => {
  await withSchemaChange("ALTER TABLE use_cases DROP COLUMN visible; ALTER TABLE use_cases DROP COLUMN image_url; ALTER TABLE article_use_cases DROP COLUMN sort_order; ALTER TABLE article_use_cases DROP COLUMN is_primary", async () => {
    const absent = await caller().getFamily({ shopProductId: "does-not-exist" });
    assert.deepEqual(absent.availableUseCases.map(u => u.slug), ["fat-loss", "metabolic-research"]);
    assert(absent.availableUseCases.every(u => !Object.hasOwn(u, "visible")));
    assert.deepEqual(absent.productSchemaStatus.missingRequiredFields, []);
    const input = payload(), created = await caller().createFamily(input);
    await caller().publishFamily(pub(created));
    const family = await caller().getFamily({ shopProductId: input.shopProductId });
    assert.equal(family.useCases[0].slug, "metabolic-research"); assert.equal(family.useCases[0].articleId, created.masterArticleId);
    assert(!Object.hasOwn(family.useCases[0], "sortOrder")); assert(!Object.hasOwn(family.useCases[0], "isPrimary"));
    assert(family.availableUseCases.every(u => !Object.hasOwn(u, "visible")));
  });
});

test("nullable unknown visibility is omitted and actual boolean visibility remains explicit", async () => {
  await withSchemaChange("UPDATE use_cases SET visible=NULL WHERE slug='metabolic-research'; ALTER TABLE use_cases ALTER COLUMN visible DROP DEFAULT; ALTER TABLE use_cases ALTER COLUMN visible TYPE boolean USING visible=1", async () => {
    const result = await caller().getFamily({ shopProductId: "does-not-exist" });
    assert.equal(result.availableUseCases[0].visible, true);
    assert(!Object.hasOwn(result.availableUseCases[1], "visible"));
    const created = await caller().createFamily(payload()); await caller().publishFamily(pub(created));
  });
});

test("missing mandatory metadata/audit/stock tables are reported for absent families and reject creation/publication before inserts", async () => {
  for (const table of ["article_seo", "article_merchant", "article_translations", "article_faq", "product_audit_log", "stock_history"]) {
    const created = await caller().createFamily(payload());
    await withSchemaChange(`DROP TABLE ${table} CASCADE`, async () => {
      const stable = await snapshot(), sequence = await articleSequence();
      const missing = await caller().getFamily({ shopProductId: "does-not-exist" });
      assert.equal(missing.master, null); assert.equal(missing.productSchemaStatus.tables[table as keyof typeof missing.productSchemaStatus.tables], false);
      assert(missing.productSchemaStatus.missingRequiredFields.includes(`${table}.id`));
      const clear = (e: any) => e.code === "CONFLICT" && e.message.includes("Produkt-Schema unvollständig:") && e.message.includes(`${table}.id`);
      await assert.rejects(caller().getFamily({ shopProductId: created.shopProductId }), clear);
      const input = payload("other-family"); input.useCaseSlugs = [];
      await assert.rejects(caller().createFamily(input), clear);
      await assert.rejects(caller().publishFamily(pub(created)), clear);
      assert.deepEqual(await snapshot(), stable); assert.deepEqual(await articleSequence(), sequence);
    });
  }
});

test("missing required FAQ/translation/article fields are detected before insert, while missing articles table fails clearly", async () => {
  for (const [table, column] of ["id", "article_id", "lang", "question", "answer", "sort_order", "is_visible", "created_at"]
    .map(column => ["article_faq", column]).concat([["article_translations", "merchant_description"], ["articles", "purity"]])) {
    const created = await caller().createFamily(payload());
    await withSchemaChange(`ALTER TABLE ${table} DROP COLUMN ${column}`, async () => {
      // Missing FAQ id has no ORDER BY id available even for the fixture snapshot.
      const stable = column === "id" ? (await pool.query("SELECT * FROM article_faq")).rows : await snapshot();
      const sequence = await articleSequence();
      const result = await caller().getFamily({ shopProductId: "does-not-exist" });
      assert.equal(result.productSchemaStatus.tables[table as keyof typeof result.productSchemaStatus.tables], true);
      assert.deepEqual(result.productSchemaStatus.missingRequiredFields, [`${table}.${column}`]);
      if (table === "article_faq") assert.equal(result.productSchemaStatus.faqLayout, "unavailable");
      const clear = (e: any) => e.code === "CONFLICT" && e.message.includes(`${table}.${column}`);
      await assert.rejects(caller().createFamily(payload("other-family")), clear);
      await assert.rejects(caller().getFamily({ shopProductId: created.shopProductId }), clear);
      await assert.rejects(caller().publishFamily(pub(created)), clear);
      assert.deepEqual(column === "id" ? (await pool.query("SELECT * FROM article_faq")).rows : await snapshot(), stable);
      assert.deepEqual(await articleSequence(), sequence);
    });
  }
  await withSchemaChange("DROP TABLE articles CASCADE", async () => {
    const stable = await snapshot(), clear = (e: any) => e.code === "CONFLICT" && e.message.includes("articles.id");
    await assert.rejects(caller().getFamily({ shopProductId: "does-not-exist" }), clear);
    await assert.rejects(caller().createFamily(payload()), clear);
    assert.deepEqual(await snapshot(), stable);
  });
});

async function seedSentinelFaqs() {
  await pool.query(`INSERT INTO article_faq(article_id,lang,question,answer,sort_order,is_visible,created_at,updated_at)
    VALUES (1,'de','Unrelated visible?','Never change me',1,1,'2020-01-02 03:04:05.123456','2021-02-03 04:05:06.654321'),
      (1,'de','Unrelated hidden?','Keep hidden',2,0,'2020-01-02','2021-02-03'),
      (1,'en','Unrelated English?','Keep original',3,1,'2020-01-02','2021-02-03')`);
}
const legacyFaqSchema = "ALTER TABLE article_faq RENAME COLUMN is_visible TO active; ALTER TABLE article_faq DROP COLUMN updated_at";

test("legacy active without updated_at supports six exact DE FAQs, minimal metabolic link, publication, stable IDs and untouched sentinel FAQs", async () => {
  await seedSentinelFaqs();
  await withSchemaChange(`${legacyFaqSchema}; ALTER TABLE use_cases DROP COLUMN visible; ALTER TABLE use_cases DROP COLUMN image_url;
    ALTER TABLE article_use_cases DROP COLUMN sort_order; ALTER TABLE article_use_cases DROP COLUMN is_primary`, async () => {
    const input = payload(), old: any = await snapshot(), sequence = await articleSequence();
    input.faqs[0].question = "Forschungsfrage 'active; DROP TABLE article_faq' ?";
    const absent = await caller().getFamily({ shopProductId: input.shopProductId });
    assert.equal(absent.master, null); assert.equal(absent.productSchemaStatus.faqLayout, "legacy-active");
    assert(Object.values(absent.productSchemaStatus.tables).every(Boolean));
    assert.deepEqual(absent.productSchemaStatus.missingRequiredFields, []);
    assert(absent.availableUseCases.some(u => u.slug === "metabolic-research"));
    assert.deepEqual(await snapshot(), old); assert.deepEqual(await articleSequence(), sequence);
    const created = await caller().createFamily(input), hidden = await caller().getFamily({ shopProductId: input.shopProductId });
    assert.equal(hidden.productSchemaStatus.faqLayout, "legacy-active");
    assert.deepEqual(hidden.productSchemaStatus.missingRequiredFields, []);
    assert(hidden.articles.every(a => a.shopVisible === 0 && a.publishedAt === null));
    assert.deepEqual(hidden.articles.map(a => [a.sellingPrice, a.stock]), [["64.00", 9], ["115.00", 9]]);
    assert.equal(hidden.seo?.canonical, input.seo.canonical); assert.equal(hidden.merchant?.merchantTitle, input.merchant.merchantTitle);
    assert.equal(hidden.translations[0].merchantDescription, input.merchant.merchantDescription);
    assert.deepEqual(hidden.faqs.map(f => ({ lang: f.lang, question: f.question, answer: f.answer })), input.faqs);
    assert(hidden.faqs.every(f => f.articleId === created.masterArticleId && f.isVisible === 1 && f.updatedAt === null && f.createdAt instanceof Date));
    assert.deepEqual(Object.keys(hidden.faqs[0]).sort(), ["id", "articleId", "lang", "question", "answer", "sortOrder", "isVisible", "createdAt", "updatedAt"].sort());
    assert.equal(hidden.useCases.length, 1); assert.equal(hidden.useCases[0].slug, "metabolic-research");
    assert.equal(hidden.useCases[0].articleId, created.masterArticleId); assert(!Object.hasOwn(hidden.useCases[0], "sortOrder"));
    assert.equal(hidden.validation?.score, 100); assert.deepEqual(hidden.validation?.warnings, []);
    const publicFaqs = () => pool.query("SELECT * FROM article_faq WHERE article_id=ANY($1) AND active=1 ORDER BY sort_order,id", [created.articleIds]);
    const publicHidden = (await publicFaqs()).rows;
    assert.equal(publicHidden.length, 6); assert(publicHidden.every(f => f.article_id === created.masterArticleId && f.lang === "de"));
    assert.deepEqual(publicHidden.map(f => [f.question, f.answer]), input.faqs.map(f => [f.question, f.answer]));
    assert.deepEqual(hidden.faqs.map(f => f.createdAt), publicHidden.map(f => f.created_at));
    const draft: any = await snapshot(); assert.deepEqual(await caller().createFamily(input), created); assert.deepEqual(await snapshot(), draft);
    const publish = pub(created); await caller().publishFamily(publish);
    const family = await caller().getFamily({ shopProductId: input.shopProductId });
    assert.equal(family.master?.shopVisible, 1); assert(family.master?.publishedAt); assert.equal(family.articles[1].shopVisible, 0);
    assert.deepEqual(family.faqs, hidden.faqs); assert.deepEqual(family.useCases, hidden.useCases);
    assert.deepEqual((await publicFaqs()).rows, publicHidden);
    const published: any = await snapshot();
    assert.deepEqual(published.article_faq.filter((f: any) => f.article_id === 1), old.article_faq);
    assert.deepEqual(published.stock_history, draft.stock_history); assert.equal(published.stock_history.length, 3);
    for (const table of ["articles", "article_seo", "article_merchant", "stock_history", "product_audit_log"])
      assert.deepEqual(published[table].filter((r: any) => r.id === 1), old[table]);
    assert.deepEqual(await caller().createFamily(input), created); await caller().publishFamily(publish);
    assert.deepEqual(await snapshot(), published);
  });
});

test("legacy FAQ audit failures roll back creation and publication including all FAQ, inventory and sentinel rows", async () => {
  await seedSentinelFaqs();
  await withSchemaChange(legacyFaqSchema, async () => {
    const old = await snapshot(), input = payload();
    await failAudit("CREATE_FAMILY", async () => { await assert.rejects(caller().createFamily(input)); });
    assert.deepEqual(await snapshot(), old);
    const created = await caller().createFamily(input), draft = await snapshot();
    const publish = pub(created);
    await failAudit("PUBLISH_FAMILY", async () => { await assert.rejects(caller().publishFamily(publish)); });
    assert.deepEqual(await snapshot(), draft);
    await caller().publishFamily(publish);
    assert.deepEqual(await caller().createFamily(input), created);
  });
});

test("when both FAQ flags exist only new rows set both to one, with current DTO and untouched mismatched sentinels", async () => {
  await seedSentinelFaqs();
  await withSchemaChange("ALTER TABLE article_faq ADD COLUMN active integer DEFAULT 0; UPDATE article_faq SET active=1 WHERE is_visible=0", async () => {
    const old: any = await snapshot(), input = payload(), created = await caller().createFamily(input);
    const hidden = await caller().getFamily({ shopProductId: input.shopProductId });
    assert.equal(hidden.productSchemaStatus.faqLayout, "current"); assert.deepEqual(hidden.productSchemaStatus.missingRequiredFields, []);
    const publicFaqs = (await pool.query("SELECT * FROM article_faq WHERE article_id=ANY($1) AND active=1", [created.articleIds])).rows;
    assert.equal(publicFaqs.length, 6); assert(publicFaqs.every(f => f.is_visible === 1 && f.active === 1 && f.article_id === created.masterArticleId));
    assert(hidden.faqs.every(f => f.isVisible === 1 && f.updatedAt instanceof Date));
    await caller().publishFamily(pub(created));
    assert.deepEqual((await pool.query("SELECT * FROM article_faq WHERE article_id=1 ORDER BY id")).rows, old.article_faq);
    assert.deepEqual((await caller().getFamily({ shopProductId: input.shopProductId })).faqs, hidden.faqs);
  });
});

test("current FAQ without updated_at remains compatible and returns null rather than an invented timestamp", async () => {
  await withSchemaChange("ALTER TABLE article_faq DROP COLUMN updated_at", async () => {
    const input = payload(), created = await caller().createFamily(input);
    const hidden = await caller().getFamily({ shopProductId: input.shopProductId });
    assert.equal(hidden.productSchemaStatus.faqLayout, "current"); assert.deepEqual(hidden.productSchemaStatus.missingRequiredFields, []);
    assert(hidden.faqs.every(f => f.updatedAt === null && f.createdAt instanceof Date));
    await caller().publishFamily(pub(created));
    assert.deepEqual((await caller().getFamily({ shopProductId: input.shopProductId })).faqs, hidden.faqs);
  });
});

test("legacy FAQ alias still requires every other mandatory FAQ field and rejects invisible persisted FAQs", async () => {
  for (const column of ["lang", "question", "answer", "sort_order", "created_at"]) {
    await withSchemaChange(`${legacyFaqSchema}; ALTER TABLE article_faq DROP COLUMN ${column}`, async () => {
      const stable = await snapshot(), sequence = await articleSequence();
      const absent = await caller().getFamily({ shopProductId: "does-not-exist" });
      assert.equal(absent.productSchemaStatus.faqLayout, "unavailable");
      assert.deepEqual(absent.productSchemaStatus.missingRequiredFields, [`article_faq.${column}`]);
      await assert.rejects(caller().createFamily(payload()), (e: any) => conflict(e) && e.message.includes(`article_faq.${column}`));
      assert.deepEqual(await snapshot(), stable); assert.deepEqual(await articleSequence(), sequence);
    });
  }
  await withSchemaChange(legacyFaqSchema, async () => {
    const input = payload(), created = await caller().createFamily(input);
    await pool.query("UPDATE article_faq SET active=0 WHERE article_id=$1 AND sort_order=1", [created.masterArticleId]);
    const stable = await snapshot(), family = await caller().getFamily({ shopProductId: input.shopProductId });
    assert.equal(family.faqs[0].isVisible, 0);
    await assert.rejects(caller().publishFamily(pub(created)), (e: any) => /sichtbare FAQs/.test(e.message));
    assert.deepEqual(await snapshot(), stable);
  });
});

test("compatible optional relations do not swallow permission errors as empty use cases", async () => {
  await pool.query("CREATE ROLE family_schema_probe; GRANT USAGE ON SCHEMA public TO family_schema_probe; GRANT SELECT ON articles TO family_schema_probe");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { readFamily } = await import("./productFamily.js");
  const client = await pool.connect();
  try {
    await client.query("SET ROLE family_schema_probe");
    await client.query("BEGIN READ ONLY");
    await assert.rejects(readFamily(drizzle(client), "does-not-exist"), (e: any) => e.cause?.code === "42501");
    await client.query("ROLLBACK");
  } finally {
    await client.query("RESET ROLE"); client.release();
    await pool.query("RESET ROLE; DROP OWNED BY family_schema_probe; DROP ROLE family_schema_probe");
  }
});

// Additive SOMATIDE coverage: the 29 existing multi-family cases above stay intact.
const composition = () => ({ version: 1 as const, kind: "blend" as const, basis: "single-vial" as const, totalMassMg: 15 as const,
  components: [{ id: "tesamorelin", name: "Tesamorelin", massMg: 10 }, { id: "ipamorelin", name: "Ipamorelin", massMg: 5 }] });
function blendPayload() {
  const p = payload("somatide");
  return { ...p, name: "SOMATIDE", categories: ["Vials"], casNumber: null, molecularWeight: null,
    composition: composition(), badge: "369 Research Blend",
    shortDescription: "10 mg Tesamorelin + 5 mg Ipamorelin. Research Use Only. Nicht für Menschen oder Tiere.",
    description: { kurztext: "SOMATIDE ist ein Blend mit 15 mg Gesamtpeptidgehalt.",
      wirkung: "Literatur zu GHRH- und Ghrelin-Rezeptorwegen der Einzelbestandteile; kein Blend-Synergienachweis.",
      fazit: "10 mg Tesamorelin + 5 mg Ipamorelin pro Vial.",
      risiko: "Research Use Only. Ausschließlich für Forschungszwecke. Nicht für die Anwendung an Menschen oder Tieren. Keine Dosierungs-, Zubereitungs- oder Anwendungsempfehlung. Die Reinheitsgarantie ist eine Betreiberzusage; kein unabhängiger HPLC-/COA-Nachweis.",
      highlights: ["99% garantiert – Betreiberzusage"] },
    variants: [{ label: "15 mg", sku: "SOMATIDE-15MG", price: 70, stock: 19, imageUrl: "https://example.invalid/somatide-15mg.png" }],
    seo: { ...p.seo, seoTitle: "SOMATIDE 15 mg | Tesamorelin + Ipamorelin | 369 Research",
      seoDescription: "SOMATIDE 15 mg: 10 mg Tesamorelin + 5 mg Ipamorelin. Nur für Forschungszwecke.",
      imageAlt: "SOMATIDE Research-Vial 15 mg, 10 mg Tesamorelin + 5 mg Ipamorelin" },
    merchant: { merchantTitle: "369 Research SOMATIDE 15 mg – Tesamorelin + Ipamorelin",
      merchantDescription: "1 Vial SOMATIDE: 10 mg Tesamorelin + 5 mg Ipamorelin. Ausschließlich für Forschungszwecke; nicht für Menschen oder Tiere.",
      brand: "369 Research", googleProductCategory: null, productType: "Forschungsmaterialien > Peptid-Blends > Vials" } };
}
const publicCaller = () => app.createCaller({ req: { headers: {} }, res: {}, user: null } as any).article;
async function failProductInsert(table: string, work: () => Promise<void>, replacement?: string) {
  assert(["articles", "article_faq", "article_seo", "article_merchant", "article_translations", "stock_history"].includes(table));
  const body = replacement ?? "RAISE EXCEPTION 'LOCAL_SINGLE_BLEND_INSERT_FAILURE';";
  await pool.query(`CREATE FUNCTION local_single_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NEW; END $$;
    CREATE TRIGGER local_single_failure BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION local_single_failure()`);
  try { await work(); } finally { await pool.query(`DROP TRIGGER local_single_failure ON ${table}; DROP FUNCTION local_single_failure()`); }
}

test("single blend hidden create has exactly one master/vial, canonical composition, null chemistry, 0->19 once and mandatory audit", async () => {
  const input = blendPayload(), old: any = await snapshot();
  // Proof of stock=0 at the first insert, not merely inferred from its journal.
  await failProductInsert("articles", async () => {
    const created = await caller().createSingleBlend(input as any);
    assert.equal(created.articleIds.length, 1); assert.equal(created.masterArticleId, created.articleIds[0]);
    assert.equal(created.shopVisible, false); assert.deepEqual(created.composition, composition());
    const family = await caller().getFamily({ shopProductId: "somatide" }); assert(family.master);
    assert.equal(family.articles.length, 1); assert.equal(family.variants.length, 1);
    assert.deepEqual(family.composition, composition()); assert.deepEqual((family.master.description as any).composition, composition());
    assert.deepEqual(family.master.description, family.translations[0].description);
    assert.equal(family.master.casNumber, null); assert.equal(family.master.molecularWeight, null); assert.equal(family.master.purity, "99% garantiert");
    assert.equal(family.master.name, "SOMATIDE (15 mg)"); assert.equal(family.master.sku, "SOMATIDE-15MG");
    assert.equal(family.master.sellingPrice, "70.00"); assert.equal(family.master.stock, 19);
    assert.equal(family.master.isActive, 1); assert.equal(family.master.shopVisible, 0); assert.equal(family.master.publishedAt, null);
    assert.deepEqual(created.variants.map(v => [v.label, v.price, v.stock, v.inventoryArticleId, v.imageUrl]),
      [["15 mg", 70, 19, created.masterArticleId, input.variants[0].imageUrl]]);
    assert.equal(family.seo?.canonical, input.seo.canonical); assert.equal(family.merchant?.googleProductCategory, null);
    assert.equal(family.faqs.length, 6); assert(family.faqs.every(f => f.articleId === created.masterArticleId && f.isVisible === 1));
    assert.equal(family.useCases[0].slug, "metabolic-research");
    assert.equal(family.validation?.isValid, true); assert.equal(family.validation?.score, 100);
    assert.deepEqual(family.validation?.issues, []); assert.deepEqual(family.validation?.warnings, []);
    assert.deepEqual(await caller().validateProduct({ shopProductId: "somatide" }), family.validation);
    const logs = (await pool.query("SELECT * FROM stock_history WHERE article_id=$1", [created.masterArticleId])).rows;
    assert.equal(logs.length, 1); assert.deepEqual([logs[0].quantity_before, logs[0].quantity_change, logs[0].quantity_after, logs[0].reason], [0, 19, 19, "Produktanlage"]);
    const audits = (await pool.query("SELECT * FROM product_audit_log WHERE article_id=$1", [created.masterArticleId])).rows;
    assert.equal(audits.length, 1); assert.equal(audits[0].action, "CREATE_SINGLE_BLEND");
    assert.equal(audits[0].field_name, `request:${input.requestKey}`);
    const stored = JSON.parse(audits[0].new_value); assert.match(stored.fingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(stored.response, created); assert.deepEqual(stored.details.composition, composition());
    const now: any = await snapshot(); assert.deepEqual(now.use_cases, old.use_cases);
    for (const table of ["articles", "article_seo", "article_merchant", "stock_history", "product_audit_log"])
      assert.deepEqual(now[table].filter((r: any) => r.id === 1), old[table]);
    assert.equal(await publicCaller().shopArticle({ shopProductId: "somatide" }), null);
    assert(!(await publicCaller().shopProducts()).some(p => p.id === "somatide"));
  }, "IF NEW.shop_product_id='somatide' AND (NEW.stock<>0 OR NEW.shop_visible<>0 OR NEW.variants IS NOT NULL) THEN RAISE EXCEPTION 'NOT_HIDDEN_ZERO_STOCK'; END IF;");
});

test("single blend publish is atomic/idempotent, public DTO uses actual master IDs, stock unchanged and original create replay persists", async () => {
  const input = blendPayload(), created = await caller().createSingleBlend(input as any), request = pub(created), hidden: any = await snapshot();
  assert.deepEqual((await publicCaller().shopAvailability()).filter((row: any) => row.shopProductId === "somatide"), []);
  await assert.rejects(caller().publishSingleBlend({ ...request, masterArticleId: 1 }), conflict);
  await assert.rejects(caller().publishFamily(request));
  const results = await Promise.all([caller().publishSingleBlend(request), caller().publishSingleBlend(request)]);
  assert.deepEqual(results[0], results[1]); assert.equal(results[0].shopVisible, true);
  assert.deepEqual((await publicCaller().shopAvailability()).filter((row: any) => row.shopProductId === "somatide"),
    [{ shopProductId: "somatide", inStock: true, stock: 19, name: "SOMATIDE (15 mg) (15 mg)", inventorySku: "SOMATIDE-15MG" }]);
  const family = await caller().getFamily({ shopProductId: "somatide" }); assert(family.master?.publishedAt);
  for (const product of [(await publicCaller().shopProducts()).find(p => p.id === "somatide"), await publicCaller().shopArticle({ shopProductId: "somatide" })]) {
    assert(product); assert.equal(product.id, "somatide"); assert.equal(product.masterArticleId, created.masterArticleId);
    assert.deepEqual(product.composition, composition()); assert.equal(product.purity, "99% garantiert");
    assert.equal(product.price, 70); assert.equal(product.stock, 19); assert.equal(product.variants.length, 1);
    assert.deepEqual(product.variants.map((v: any) => [v.label, v.sku, v.articleId, v.inventoryArticleId, v.price, v.stock]),
      [["15 mg", "SOMATIDE-15MG", created.masterArticleId, created.masterArticleId, 70, 19]]);
  }
  const published: any = await snapshot(); assert.deepEqual(published.stock_history, hidden.stock_history);
  assert.equal(published.product_audit_log.filter((a: any) => a.action === "PUBLISH_SINGLE_BLEND").length, 1);
  assert.deepEqual(await caller().createSingleBlend(input as any), created); assert.deepEqual(await snapshot(), published);
  await caller().publishSingleBlend(request); assert.deepEqual(await snapshot(), published);
  await caller().publishSingleBlend(pub(created));
  const noop: any = await snapshot(); assert.deepEqual(noop.articles, published.articles); assert.deepEqual(noop.stock_history, published.stock_history);
  assert.equal(noop.product_audit_log.filter((a: any) => a.action === "PUBLISH_SINGLE_BLEND").length, 2);
  await pool.query("UPDATE articles SET description=description-'composition' WHERE id=$1", [created.masterArticleId]);
  assert.deepEqual((await publicCaller().shopAvailability()).filter((row: any) => row.shopProductId === "somatide"), []);
});

test("single blend concurrent create replay and canonical object ordering never duplicate rows, stock or audits; changed payload conflicts", async () => {
  const input = blendPayload(), results = await Promise.all(Array.from({ length: 3 }, () => caller().createSingleBlend(input as any)));
  assert.deepEqual(results[1], results[0]); assert.deepEqual(results[2], results[0]);
  const stable = await snapshot(), reordered: Record<string, unknown> = Object.fromEntries(Object.entries(input).reverse());
  reordered.composition = Object.fromEntries(Object.entries(input.composition).reverse());
  assert.deepEqual(await caller().createSingleBlend(reordered as any), results[0]);
  await assert.rejects(caller().createSingleBlend({ ...input, badge: "changed" } as any), conflict);
  await assert.rejects(caller().createSingleBlend({ ...input, variants: [{ ...input.variants[0], price: 71 }] } as any), conflict);
  await assert.rejects(caller().publishSingleBlend(pub(results[0], input.requestKey)), conflict);
  const multi = payload("another-family"); multi.requestKey = input.requestKey;
  await assert.rejects(caller().createFamily(multi), conflict); assert.deepEqual(await snapshot(), stable);
});

test("single blend create/publish audits roll back everything and same keys succeed after failed transactions in current and legacy layouts", async () => {
  for (const layout of ["current", "legacy"]) {
    const run = async () => {
      const stable = await snapshot(), input = blendPayload();
      await failAudit("CREATE_SINGLE_BLEND", async () => { await assert.rejects(caller().createSingleBlend(input as any)); });
      assert.deepEqual(await snapshot(), stable);
      const created = await caller().createSingleBlend(input as any), hidden = await snapshot(), request = pub(created);
      await failAudit("PUBLISH_SINGLE_BLEND", async () => { await assert.rejects(caller().publishSingleBlend(request)); });
      assert.deepEqual(await snapshot(), hidden); await caller().publishSingleBlend(request);
      const final: any = await snapshot(); assert.deepEqual(final.stock_history, (hidden as any).stock_history);
      const family = await caller().getFamily({ shopProductId: "somatide" }); assert.equal(family.validation?.score, 100);
      assert.equal(family.productSchemaStatus.faqLayout, layout === "current" ? "current" : "legacy-active");
      assert.deepEqual(await caller().createSingleBlend(input as any), created);
    };
    if (layout === "legacy") await withSchemaChange(legacyFaqSchema, run); else { await run(); await seedFixture(); }
  }
});

test("single blend all mandatory metadata, stock-history failures and DB-corrupted SEO/composition roll back exact product snapshot", async () => {
  for (const table of ["article_faq", "article_seo", "article_merchant", "article_translations", "stock_history"]) {
    const stable = await snapshot();
    await failProductInsert(table, async () => { await assert.rejects(caller().createSingleBlend(blendPayload() as any)); });
    assert.deepEqual(await snapshot(), stable);
  }
  for (const [table, replacement] of [["article_seo", "NEW.seo_title=repeat('x',61);"],
    ["articles", "NEW.description=jsonb_set(NEW.description,'{composition,totalMassMg}','16'::jsonb);"],
    ["article_translations", "NEW.description='{}'::jsonb;"], ["article_faq", "NEW.is_visible=0;"]]) {
    const stable = await snapshot();
    await failProductInsert(table, async () => { await assert.rejects(caller().createSingleBlend(blendPayload() as any)); }, replacement);
    assert.deepEqual(await snapshot(), stable);
  }
});

test("single blend strict schema binds exact identity, canonical component order, one vial, null common chemistry and typed price/stock", async () => {
  const input = blendPayload(), stable = await snapshot(), c = composition();
  const bad: any[] = [ { ...input, shopProductId: "other" }, { ...input, name: "SOMATIDE 15 mg" }, { ...input, casNumber: "218949-48-5" },
    { ...input, molecularWeight: "5847.75 g/mol" }, { ...input, purity: "" }, { ...input, purity: null }, { ...input, mystery: true },
    { ...input, variants: [] }, { ...input, variants: [input.variants[0], input.variants[0]] },
    ...[{ sku: "somatide-15mg" }, { label: "15mg" }, { label: "10 mg + 5 mg" }, { price: 0 }, { price: 70.001 }, { price: Infinity },
      { stock: -1 }, { stock: 1.5 }, { stock: 2147483648 }, { imageUrl: "http://example.invalid/a.png" },
      { imageUrl: "https://secret:password@example.invalid/a.png" }].map(change => ({ ...input, variants: [{ ...input.variants[0], ...change }] })),
    ...[{ totalMassMg: 16 }, { version: 2 }, { kind: "peptide" }, { basis: "pack" }, { components: [...c.components].reverse() },
      { components: [c.components[0], c.components[0]] }, { components: [{ ...c.components[0], massMg: 9 }, c.components[1]] },
      { components: [{ ...c.components[0], massMg: Infinity }, c.components[1]] }, { extra: 1 }].map(change => ({ ...input, composition: { ...c, ...change } })),
    { ...input, description: { ...input.description, composition: { ...c, totalMassMg: 16 } } },
    { ...input, merchant: { ...input.merchant, googleProductCategory: "" } },
    { ...input, description: {} }, { ...input, faqs: input.faqs.slice(0, 3) }, { ...input, useCaseSlugs: ["not-existing"] } ];
  for (const p of bad) { await assert.rejects(caller().createSingleBlend(p)); assert.deepEqual(await snapshot(), stable); }
  assert.equal(singleBlendCompositionSchema.safeParse(c).success, true);
  assert.equal(createFamilyInput.safeParse(input).success, false);
  assert.equal(createSingleBlendInput.safeParse({ ...input, merchant: { ...input.merchant, googleProductCategory: undefined } }).success, false);
  const identical = { ...input, description: { ...input.description, composition: c },
    variants: [{ ...input.variants[0], price: 72.35, stock: 0 }] };
  const created = await caller().createSingleBlend(identical as any);
  assert.equal(created.variants[0].price, 72.35); assert.equal(created.variants[0].stock, 0);
  const family = await caller().getFamily({ shopProductId: "somatide" }); assert.equal(family.master?.sellingPrice, "72.35");
  assert.equal(family.merchant?.availability, "out_of_stock");
});

test("cross-family concurrent slug/SKU/request locks and independent SEO conflicts allow at most one committed operation", async () => {
  for (const scope of ["slug", "sku", "request"]) {
    await seedFixture(); const blend = blendPayload(), multi = payload(scope === "slug" ? "somatide" : `multi-${scope}`);
    if (scope === "sku") multi.variants[0].sku = "SOMATIDE-15MG";
    if (scope === "request") multi.requestKey = blend.requestKey;
    const results = await Promise.allSettled([caller().createSingleBlend(blend as any), caller().createFamily(multi)]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(results.filter(r => r.status === "rejected" && conflict(r.reason)).length, 1);
  }
  await seedFixture(); await pool.query("INSERT INTO article_seo(article_id,slug) VALUES(1,'somatide')");
  const stable = await snapshot(); await assert.rejects(caller().createSingleBlend(blendPayload() as any), conflict);
  assert.deepEqual(await snapshot(), stable);
  const source = readFileSync(new URL("./productFamily.ts", import.meta.url), "utf8");
  assert.match(source, /product-family:\$\{canonicalKey\}/); assert(!source.includes("product-single:"));
  assert.match(source, /key\.startsWith\("sku:"\)/);
  assert.match(source, /key\.slice\(4\)\.toLowerCase\(\)/);
});

test("single blend persisted chemistry/composition/metadata/variant corruption fails publish and getFamily/validateProduct agree", async () => {
  const corruptions = [
    "UPDATE articles SET cas_number='218949-48-5' WHERE shop_product_id='somatide'",
    "UPDATE articles SET molecular_weight='5847.75' WHERE shop_product_id='somatide'",
    "UPDATE articles SET description=description-'composition' WHERE shop_product_id='somatide'",
    "UPDATE articles SET description=jsonb_set(description,'{composition,components}',(description->'composition'->'components')-0) WHERE shop_product_id='somatide'",
    "UPDATE articles SET variants=jsonb_set(variants,'{0,inventoryArticleId}','1'::jsonb) WHERE shop_product_id='somatide'",
    "UPDATE articles SET variants=jsonb_set(variants,'{0,sku}','\"BAD\"'::jsonb) WHERE shop_product_id='somatide'",
    "UPDATE articles SET selling_price=71 WHERE shop_product_id='somatide'",
    "UPDATE articles SET purity=NULL WHERE shop_product_id='somatide'",
    "UPDATE articles SET name='Wrong (15 mg)' WHERE shop_product_id='somatide'",
    "UPDATE article_seo SET canonical='https://www.369research.eu.evil.invalid/product/somatide' WHERE slug='somatide'",
    "UPDATE article_faq SET is_visible=0 WHERE article_id=(SELECT id FROM articles WHERE shop_product_id='somatide') AND sort_order=1",
    "UPDATE article_translations SET description='{}'::jsonb WHERE article_id=(SELECT id FROM articles WHERE shop_product_id='somatide')",
  ];
  for (const statement of corruptions) {
    await seedFixture(); const created = await caller().createSingleBlend(blendPayload() as any);
    await pool.query(statement); const stable = await snapshot();
    const family = await caller().getFamily({ shopProductId: "somatide" }); assert.equal(family.validation?.isValid, false);
    assert.deepEqual(await caller().validateProduct({ shopProductId: "somatide" }), family.validation);
    await assert.rejects(caller().publishSingleBlend(pub(created))); assert.deepEqual(await snapshot(), stable);
  }
});

test("public single blend fails closed on missing composition/binding/duplicate rows and never invents purity", async () => {
  const created = await caller().createSingleBlend(blendPayload() as any); await caller().publishSingleBlend(pub(created));
  await pool.query("UPDATE articles SET purity=NULL WHERE shop_product_id='somatide'");
  for (const p of [(await publicCaller().shopProducts()).find(p => p.id === "somatide"), await publicCaller().shopArticle({ shopProductId: "somatide" })]) {
    assert(p); assert.equal(p.purity, null);
  }
  await pool.query("UPDATE articles SET description=description-'composition' WHERE shop_product_id='somatide'");
  let detail = await publicCaller().shopArticle({ shopProductId: "somatide" }); assert(detail);
  assert.equal(detail.composition, null); assert.equal(detail.masterArticleId, null); assert.deepEqual(detail.variants, []);
  await pool.query("UPDATE articles SET description=jsonb_set(description,'{composition}',$1::jsonb) WHERE shop_product_id='somatide'", [JSON.stringify(composition())]);
  await pool.query("INSERT INTO articles(sku,name,shop_product_id,selling_price,stock,is_active,shop_visible) VALUES('NO-SECOND-VARIANT','Wrong duplicate (5 mg)','somatide',1,0,1,0)");
  detail = await publicCaller().shopArticle({ shopProductId: "somatide" }); assert(detail); assert.equal(detail.composition, null); assert.deepEqual(detail.variants, []);
});

test("single blend RUO/affirmative human-use/purity guards remain and ordinary products retain missing CAS/category warnings", async () => {
  const input = blendPayload(), parsed = createSingleBlendInput.parse(input);
  const a: any = { ...parsed, id: 2, sku: "SOMATIDE-15MG", stock: 19, sellingPrice: "70.00", mockupImageUrl: input.variants[0].imageUrl,
    variants: [{ dosage: "15 mg", label: "15 mg", sku: "SOMATIDE-15MG", inventoryArticleId: 2 }] };
  const seo = { ...input.seo, slug: "somatide" }, merchant = { ...input.merchant, availability: "in_stock" };
  assert.equal(validateProductData(a, seo, merchant, input.merchant).score, 100);
  for (const phrase of ["Dosierung täglich", "Therapie", "heilt", "behandelt", "Nehmen Sie", "Einnahme"]) {
    const result = validateProductData({ ...a, shortDescription: `${a.shortDescription} ${phrase}` }, seo, merchant, input.merchant);
    assert(result.warnings.some(w => w.includes("Human-Use")));
    await assert.rejects(caller().createSingleBlend({ ...input, shortDescription: `${input.shortDescription} ${phrase}` } as any));
  }
  const noRuo = { ...input, shortDescription: "Ein Blend.", description: { ...input.description, risiko: "Keine Daten." } };
  await assert.rejects(caller().createSingleBlend(noRuo as any));
  assert(validateProductData({ ...a, purity: null }, seo, merchant, input.merchant).warnings.includes("Reinheitsangabe fehlt"));
  const ordinary = validateProductData({ ...a, shopProductId: "not-somatide" }, seo, merchant, input.merchant);
  assert(ordinary.warnings.includes("CAS-Nummer fehlt (empfohlen für Peptide)")); assert(ordinary.warnings.includes("Google Product Category fehlt"));
  assert(ordinary.warnings.some(w => w.includes("dosierung")));
});

test("single blend current/legacy optional links and missing mandatory schemas use existing safe adapters", async () => {
  await withSchemaChange(`${legacyFaqSchema}; ALTER TABLE use_cases DROP COLUMN visible; ALTER TABLE article_use_cases DROP COLUMN sort_order; ALTER TABLE article_use_cases DROP COLUMN is_primary`, async () => {
    const created = await caller().createSingleBlend(blendPayload() as any); await caller().publishSingleBlend(pub(created));
    const family = await caller().getFamily({ shopProductId: "somatide" });
    assert.equal(family.validation?.score, 100); assert(family.faqs.every(f => f.updatedAt === null)); assert.equal(family.useCases[0].slug, "metabolic-research");
  });
  await withSchemaChange("DROP TABLE article_use_cases; DROP TABLE use_cases CASCADE", async () => {
    const stable = await snapshot(), sequence = await articleSequence();
    await assert.rejects(caller().createSingleBlend(blendPayload() as any)); assert.deepEqual(await snapshot(), stable); assert.deepEqual(await articleSequence(), sequence);
    const input = blendPayload(); input.useCaseSlugs = [];
    const created = await caller().createSingleBlend(input as any); await caller().publishSingleBlend(pub(created));
  });
  for (const table of ["article_faq", "article_seo", "article_merchant", "article_translations", "stock_history", "product_audit_log"]) {
    await withSchemaChange(`DROP TABLE ${table} CASCADE`, async () => {
      const stable = await snapshot(), sequence = await articleSequence();
      await assert.rejects(caller().createSingleBlend(blendPayload() as any), conflict);
      assert.deepEqual(await snapshot(), stable); assert.deepEqual(await articleSequence(), sequence);
    });
  }
});

test("single blend routes preserve productManagerProcedure roles: manager/admin allowed, anonymous/customer/user/packing denied", async () => {
  const input = blendPayload(), stable = await snapshot();
  for (const principal of [null, ...["customer", "user", "packing"].map(role => ({ ...manager, role }))]) {
    await assert.rejects(caller(principal).createSingleBlend(input as any), denied);
    await assert.rejects(caller(principal).publishSingleBlend({ shopProductId: "somatide", masterArticleId: 2, requestKey: randomUUID() }), denied);
  }
  assert.deepEqual(await snapshot(), stable);
  const created = await caller({ ...manager, role: "admin" }).createSingleBlend(input as any);
  await caller().publishSingleBlend(pub(created));
  const source = readFileSync(new URL("./productAdminRouter.ts", import.meta.url), "utf8");
  assert.match(source, /createSingleBlend: productManagerProcedure/); assert.match(source, /publishSingleBlend: productManagerProcedure/);
});

test("single blend create replay after a real local stock movement never restores initial stock or duplicates stock history", async () => {
  const input = blendPayload(), created = await caller().createSingleBlend(input as any);
  const { getDb } = await import("./db.js"), { applyStockMovement } = await import("./stockMovementService.js");
  await (await getDb())!.transaction(tx => applyStockMovement(tx, { articleId: created.masterArticleId, sku: "SOMATIDE-15MG",
    expectedStock: 19, change: -2, type: "korrektur", reason: "local synthetic stock change", actor: "fixture" }));
  const stable = await snapshot(); assert.deepEqual(await caller().createSingleBlend(input as any), created); assert.deepEqual(await snapshot(), stable);
  assert.equal((await pool.query("SELECT stock FROM articles WHERE id=$1", [created.masterArticleId])).rows[0].stock, 17);
  // Existing stock service does not synchronize variants JSON; publish correctly
  // refuses an inconsistent variant rather than restoring its initial stock.
  await assert.rejects(caller().publishSingleBlend(pub(created))); assert.deepEqual(await snapshot(), stable);
  await pool.query("UPDATE articles SET variants=jsonb_set(variants,'{0,stock}','17'::jsonb) WHERE id=$1", [created.masterArticleId]);
  await caller().publishSingleBlend(pub(created));
  assert.deepEqual((await publicCaller().shopAvailability()).filter((row: any) => row.shopProductId === "somatide"),
    [{ shopProductId: "somatide", inStock: true, stock: 17, name: "SOMATIDE (15 mg) (15 mg)", inventorySku: "SOMATIDE-15MG" }]);
  const detail = await publicCaller().shopArticle({ shopProductId: "somatide" }); assert(detail); assert.equal(detail.variants[0].stock, 17);
});


test("multi-family 2..10 contract and scalar metadata requirements remain unchanged alongside narrow blend", async () => {
  const p = payload();
  assert.equal(createFamilyInput.safeParse({ ...p, merchant: { ...p.merchant, googleProductCategory: null } }).success, false);
  assert.equal(createFamilyInput.safeParse({ ...p, casNumber: null }).success, false);
  assert.equal(createFamilyInput.safeParse({ ...p, molecularWeight: null }).success, false);
  assert.equal(createFamilyInput.safeParse({ ...p, variants: [p.variants[0]] }).success, false);
  const ten = Array.from({ length: 10 }, (_, i) => ({ ...p.variants[0], label: `${i + 1} mg`, sku: `TEN-${i + 1}` }));
  assert.equal(createFamilyInput.safeParse({ ...p, variants: ten }).success, true);
  assert.equal(createFamilyInput.safeParse({ ...p, variants: [...ten, { ...ten[0], label: '11 mg', sku: 'TEN-11' }] }).success, false);
  assert.equal(createFamilyInput.safeParse({ ...p, composition: composition() }).success, false);
});

test("single blend cannot avoid RUO/purity validation by selecting cosmetic categories and hidden variants have no public blend DTO", async () => {
  const input = blendPayload(), stable = await snapshot();
  await assert.rejects(caller().createSingleBlend({ ...input, category: "369 BeautyLine", categories: ["369 BeautyLine"],
    shortDescription: "Ein Blend.", description: { ...input.description, risiko: "Keine weiteren Daten." } } as any));
  assert.deepEqual(await snapshot(), stable);
  const created = await caller().createSingleBlend(input as any); await caller().publishSingleBlend(pub(created));
  await pool.query("UPDATE articles SET variants=jsonb_set(variants,'{0,hidden}','true'::jsonb) WHERE id=$1", [created.masterArticleId]);
  const detail = await publicCaller().shopArticle({ shopProductId: "somatide" }); assert(detail);
  assert.equal(detail.composition, null); assert.equal(detail.masterArticleId, null); assert.deepEqual(detail.variants, []);
});
