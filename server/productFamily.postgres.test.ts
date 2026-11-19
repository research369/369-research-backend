import assert from "node:assert/strict";
import test, { before, after, beforeEach, mock } from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { ENV } from "./env.js";
import { closeDb, getPool } from "./db.js";
import { productAdminRouter } from "./productAdminRouter.js";
import { router, adminProcedure } from "./trpc.js";
import { getPublicShopVariants } from "./articleRouter.js";

// Never skips; must run under our secret-free disposable PostgreSQL wrapper.
const socket = process.env.FAMILY_TEST_PG_SOCKET;
if (!socket?.startsWith("/tmp/369-product-family.") || !socket.endsWith("/socket")
  || process.env.DATABASE_URL || process.env.RAILWAY_DB_URL
  || process.env.DOTENV_CONFIG_PATH !== "/dev/null" || process.env.FAMILY_TEST_SANITIZED !== "1")
  throw Error("DEDICATED_LOCAL_SECRET_FREE_FIXTURE_REQUIRED");
const app = router({ productAdmin: productAdminRouter });
const manager = { id: 2, username: "local_product_manager", role: "product_manager", name: null, email: null };
const caller = (user: any = manager) => app.createCaller({ req: { headers: {} }, res: {}, user } as any).productAdmin;
let pool: NonNullable<Awaited<ReturnType<typeof getPool>>>;
let networkCalls = 0;
const productTables = ["articles", "article_seo", "article_merchant", "article_translations", "article_faq", "article_use_cases", "stock_history", "product_audit_log", "use_cases"];
async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const table of productTables) result[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
  return result;
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
const pub = (created: { shopProductId: string; masterArticleId: number }, requestKey = randomUUID()) =>
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
beforeEach(async () => {
  await pool.query("TRUNCATE article_seo,article_merchant,article_translations,article_faq,article_use_cases,stock_history,product_audit_log,articles,use_cases RESTART IDENTITY CASCADE");
  await pool.query("INSERT INTO use_cases(slug,visible) VALUES('metabolic-research',0),('fat-loss',1)");
  await pool.query("INSERT INTO articles(sku,name,shop_product_id,selling_price,stock,shop_visible,is_active,purity) VALUES('EXISTING-SKU','Unrelated sentinel (20 mg)','unrelated-existing',123.45,7,1,1,'99%')");
  await pool.query("INSERT INTO article_seo(article_id,slug,seo_title) VALUES(1,'unrelated-existing','Untouched SEO'); INSERT INTO article_merchant(article_id,brand) VALUES(1,'Untouched brand'); INSERT INTO stock_history(article_id,change_type,quantity_before,quantity_change,quantity_after,reason) VALUES(1,'wareneingang',0,7,7,'sentinel'); INSERT INTO product_audit_log(article_id,action,changed_by,new_value) VALUES(1,'SENTINEL','fixture','untouched')");
});
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
