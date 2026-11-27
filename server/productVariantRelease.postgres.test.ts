import assert from "node:assert/strict";
import test, { before, after, beforeEach, mock } from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { Socket } from "node:net";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

const socket = process.env.RELEASE_TEST_PG_SOCKET;
if (!socket || !/^\/tmp\/369-product-release\.[A-Za-z0-9]+\/socket$/.test(socket) || realpathSync(socket) !== socket
  || process.env.DATABASE_URL || process.env.RAILWAY_DB_URL || process.env.DOTENV_CONFIG_PATH !== "/dev/null"
  || process.env.RELEASE_TEST_SANITIZED !== "1") throw Error("DEDICATED_SECRET_FREE_RELEASE_FIXTURE_REQUIRED");
const pgSocket = `${socket}/.s.PGSQL.55465`, ddl = readFileSync(`${socket}/../schema.sql`, "utf8");
const pool = new pg.Pool({ host: socket, port: 55465, user: "family_local", database: "family_local", max: 8 });
const db = drizzle(pool), actor = "local_product_manager";
let service: typeof import("./productVariantRelease.js"), drafts: typeof import("./productDraft.js"), finalizer: typeof import("./productDraftFinalization.js");
let pricing: typeof import("./kwkCheckoutPricing.js"), app: any;
let networkCalls = 0, blockedSockets = 0, forbiddenQueries = 0, observedQueries = 0;
const manager = { id: 2, username: actor, role: "product_manager", name: null, email: null };
const caller = (user: any = manager) => app.createCaller({ req: { headers: {} }, res: {}, user });
const tables = ["articles", "article_seo", "article_merchant", "article_translations", "article_faq", "article_use_cases", "stock_history", "product_audit_log"];
const conflict = (e: any) => e?.code === "CONFLICT";
async function snapshot() {
  const result: Record<string, any[]> = {};
  for (const table of tables) result[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
  return result;
}
function content(slug: string, name = "LOCAL RESEARCH") {
  return {
    name, category: "Vials", categories: ["Vials"], badge: "Research Vial", casNumber: null, molecularWeight: null, purity: null,
    shortDescription: "Explizit deklariertes Forschungsmaterial. Research Use Only. Not for human use.",
    description: { kurztext: "Explizite Einzelmassen für Laborforschung.", wirkung: "Präklinischer Forschungskontext ohne Produktwirknachweis.",
      fazit: "Kontrollierte Laborforschung.", risiko: "Research Use Only. Not for human use.",
      eigenschaften: { form: "Forschungsvial", reinheit: "Chargennachweis ausstehend" }, quellen: ["https://example.invalid/research"] },
    seo: { seoTitle: "Research Vial | 369 Research", seoDescription: "Explizit deklarierte Einzelmassen für nichtklinische Laborforschung. Research Use Only.",
      canonical: `https://www.369research.eu/product/${slug}`, imageAlt: "Research Vial", ogImage: "https://example.invalid/og.webp" },
    merchant: { merchantTitle: "Research Vial", merchantDescription: "Ausschließlich für Forschung. Research Use Only. Not for human use.",
      brand: "369 Research", googleProductCategory: null, productType: "Forschungsmaterial > Vials" },
    faqs: Array.from({ length: 4 }, (_, i) => ({ lang: "de", question: `Forschungsfrage ${i + 1}?`, answer: "Nur für Laborforschung. Research Use Only. Not for human use." })),
  };
}
const composition = (amount: number) => ({ totalMassMg: amount, components: [{ name: "Declared A", massMg: amount / 2 }, { name: "Declared B", massMg: amount / 2 }] });
const variant = (slug: string, amount: number) => ({ sku: `${slug.toUpperCase()}-${amount}MG`, label: `${amount} mg`,
  imageUrl: `https://example.invalid/${slug}-${amount}.webp`, price: null, stock: 0, composition: composition(amount) });
async function prepared(slug = "local-release", amounts = [12.5, 25]) {
  const c = content(slug);
  const input = drafts.createProductDraftInput.parse({ ...c, requestKey: randomUUID(), shopProductId: slug, variants: amounts.map(a => variant(slug, a)),
    social: { launch: "PRIVATE_DRAFT_SOCIAL", instagram: "PRIVATE_DRAFT_INSTAGRAM" } });
  const created = await drafts.createProductDraft(db, input, actor);
  const state = await service.readVariantReleaseSnapshot(db, slug, created.masterArticleId);
  return { created, state, input, request: { shopProductId: slug, masterArticleId: created.masterArticleId, requestKey: randomUUID(),
    expectedSnapshotHash: state.expectedSnapshotHash, selected: { articleId: created.articleIds[0], sku: input.variants[0].sku,
      label: input.variants[0].label, imageUrl: "https://example.invalid/new-image.webp", price: 79, targetStock: 30, composition: input.variants[0].composition }, content: c } };
}
const release = (value: unknown) => Promise.resolve().then(() => service.releaseProductVariant(db, service.releaseProductVariantInput.parse(value), actor));
const catalog = (rows: any[]) => rows.map(a => ({ ...a, shopProductId: a.shop_product_id, sellingPrice: a.selling_price,
  salePrice: a.sale_price, shopVisible: a.shop_visible, isActive: a.is_active }));
async function failInsert(table: string, work: () => Promise<void>) {
  if (!["product_audit_log", "stock_history", "article_seo", "article_faq"].includes(table)) throw Error("KNOWN_TABLE_REQUIRED");
  await pool.query(`CREATE FUNCTION local_release_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'LOCAL_INSERT_FAILURE'; END $$;
    CREATE TRIGGER local_release_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION local_release_fail()`);
  try { await work(); } finally { await pool.query(`DROP TRIGGER local_release_fail ON ${table}; DROP FUNCTION local_release_fail()`); }
}
async function legacy(work: () => Promise<void>) {
  await pool.query("ALTER TABLE article_faq RENAME COLUMN is_visible TO active; ALTER TABLE article_faq DROP COLUMN updated_at; ALTER TABLE articles ALTER COLUMN selling_price SET NOT NULL; ALTER TABLE article_use_cases DROP COLUMN sort_order; ALTER TABLE article_use_cases DROP COLUMN is_primary");
  try { await work(); } finally { await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public"); await pool.query(ddl); }
}

before(async () => {
  mock.method(globalThis, "fetch", async () => { networkCalls++; throw Error("HTTP_FORBIDDEN"); });
  const connect = Socket.prototype.connect;
  mock.method(Socket.prototype, "connect", function (this: Socket, ...args: any[]) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0], path = typeof first === "string" ? first : first?.path;
    if (path !== pgSocket) { blockedSockets++; throw Error("NON_FIXTURE_SOCKET_FORBIDDEN"); }
    return Reflect.apply(connect, this, args);
  } as any);
  const query = pg.Client.prototype.query;
  mock.method(pg.Client.prototype, "query", function (this: pg.Client, ...args: any[]) {
    const statement = typeof args[0] === "string" ? args[0] : args[0]?.text ?? "";
    observedQueries++;
    if (statement !== ddl && /\b(?:orders|order_items|payments|payment_transactions|invoices|customers|users)\b/i.test(statement)) {
      forbiddenQueries++; throw Error("NON_PRODUCT_TABLE_FORBIDDEN");
    }
    return Reflect.apply(query, this, args);
  } as any);
  const { ENV } = await import("./env.js");
  for (const key of Object.keys(ENV)) if (/key|password|secret/i.test(key)) (ENV as any)[key] = "";
  await (await import("./db.js")).closeDb();
  ENV.databaseUrl = `postgresql://family_local@localhost:55465/family_local?host=${encodeURIComponent(socket!)}`;
  service = await import("./productVariantRelease.js"); drafts = await import("./productDraft.js"); finalizer = await import("./productDraftFinalization.js"); pricing = await import("./kwkCheckoutPricing.js");
  const [{ router }, { productAdminRouter }, { articleRouter }] = await Promise.all([import("./trpc.js"), import("./productAdminRouter.js"), import("./articleRouter.js")]);
  app = router({ productAdmin: productAdminRouter, article: articleRouter });
  assert.deepEqual((await pool.query("SELECT current_user,current_database(),inet_server_addr() AS address,current_setting('listen_addresses') AS listening")).rows[0],
    { current_user: "family_local", current_database: "family_local", address: null, listening: "" });
});
beforeEach(async () => {
  await pool.query("TRUNCATE article_seo,article_merchant,article_translations,article_faq,article_use_cases,stock_history,product_audit_log,articles,use_cases RESTART IDENTITY CASCADE");
  await pool.query("INSERT INTO use_cases(slug,visible) VALUES('metabolic-research',0)");
});
after(async () => {
  try {
    assert.equal(networkCalls, 0); assert.equal(blockedSockets, 0); assert.equal(forbiddenQueries, 0);
    console.log(`Release isolation: observedQueries=${observedQueries}; HTTP=${networkCalls}; nonfixture sockets=${blockedSockets}; business-table queries=${forbiddenQueries}; fresh unix-only PostgreSQL.`);
  } finally { await (await import("./db.js")).closeDb(); (await import("./env.js")).ENV.databaseUrl = ""; await pool.end(); mock.restoreAll(); }
});

test("single CBL20 publishes79/30 with honest chemistry, mandatory exact audit and one journal", async () => {
  const { request, created } = await prepared("local-cbl", [20]), before = await snapshot();
  const result = await caller().productAdmin.releaseVariant(request), after = await snapshot();
  assert.equal(result.masterArticleId, created.masterArticleId); assert.equal(result.variants.length, 1); assert.equal(result.shopVisible, true);
  assert.equal(result.validation.score, 100); assert.equal(result.validation.validationProfile, "explicit-composition-draft-v1"); assert.deepEqual(result.validation.warnings, []);
  const row = after.articles[0]; assert.equal(row.selling_price, "79.00"); assert.equal(row.stock, 30); assert.equal(row.shop_visible, 1);
  assert.equal(row.purity, null); assert.equal(row.cas_number, null); assert.equal(row.molecular_weight, null); assert.equal(row.variants[0].publicationStatus, "finalized-draft");
  assert(!JSON.stringify(row).includes("PRIVATE_DRAFT")); assert(!Object.hasOwn(row.description, "draftMeta"));
  assert.equal(after.stock_history.length, 1); assert.equal(after.stock_history[0].quantity_change, 30);
  const log = after.product_audit_log.find(a => a.action === "RELEASE_VARIANT")!;
  assert.deepEqual(JSON.parse(log.new_value).response, result); assert.equal(JSON.parse(log.old_value).master.description.draftMeta.social.launch, "PRIVATE_DRAFT_SOCIAL");
  assert.equal(before.articles.length, after.articles.length);
  const publicProduct = (await caller(null).article.shopProducts())[0]; assert.equal(publicProduct.category, "Vials"); assert.equal(publicProduct.price, 79); assert.equal(publicProduct.stock, 30); assert.equal(publicProduct.purity, null);
  assert.equal(publicProduct.variants[0].image, request.selected.imageUrl);
  assert.equal(pricing.resolveAuthoritativeItemPrice({ shopProductId: request.shopProductId, dosage: "20 mg", price: 999, quantity: 1 }, catalog(after.articles)), 79);
});

test("NEXUS adds new24, promotes it, preserves old12.5/25 hidden unpriced rows and old private metadata audit", async () => {
  const { request, created, input } = await prepared("local-nexus"), before = await snapshot();
  await pool.query("INSERT INTO article_use_cases(article_id,use_case_id) VALUES($1,1)", [created.masterArticleId]);
  request.expectedSnapshotHash = (await service.readVariantReleaseSnapshot(db, request.shopProductId)).expectedSnapshotHash;
  const next = { ...request, selected: { ...request.selected, articleId: null, sku: "LOCAL-NEXUS-24MG", label: "24 mg", price: 145, targetStock: 10,
    composition: { totalMassMg: 24, components: [{ name: "Declared A", massMg: 20 }, { name: "Declared B", massMg: 4 }] } } };
  const result = await release(next), after = await snapshot(); assert(!created.articleIds.includes(result.masterArticleId));
  assert.deepEqual(result.remainingDraftArticleIds, created.articleIds); assert.deepEqual(result.variants.map((v: any) => v.label), ["24 mg"]);
  assert.deepEqual(after.articles[1], before.articles[1]);
  assert.deepEqual(after.articles[0], { ...before.articles[0], variants: null, updated_at: after.articles[0].updated_at });
  assert.equal(after.articles.filter(a => Array.isArray(a.variants) && a.variants.length).length, 1);
  for (const table of ["article_seo", "article_merchant", "article_translations", "article_faq", "article_use_cases"]) assert(after[table].every(a => a.article_id === result.masterArticleId));
  const shop = await caller(null).article.shopArticle({ shopProductId: request.shopProductId });
  assert.deepEqual(shop.variants.map((v: any) => v.dosage), ["24 mg"]); assert.equal(shop.stock, 10); assert(!JSON.stringify(shop).includes(input.variants[1].sku)); assert(!JSON.stringify(shop).includes("PRIVATE_DRAFT"));
  for (const dosage of ["12.5 mg", "25 mg"]) assert.throws(() => pricing.resolveAuthoritativeItemPrice({ shopProductId: request.shopProductId, dosage, price: 1, quantity: 1 }, catalog(after.articles)));
  assert.equal(JSON.parse(after.product_audit_log.find(a => a.action === "RELEASE_VARIANT")!.old_value).variants.length, 2);
});

test("ELONEX existing second25 promotion and MITRO display preserve old stable slugs/SKUs", async () => {
  const { request, created, input } = await prepared("local-elonext");
  const before = await snapshot();
  const second = input.variants[1];
  const result = await release({ ...request, selected: { articleId: created.articleIds[1], sku: second.sku, label: second.label,
    imageUrl: second.imageUrl, composition: second.composition, price: 165, targetStock: 9 },
    content: { ...request.content, name: "ELONEX" } });
  assert.equal(result.masterArticleId, created.articleIds[1]); const after = await snapshot();
  assert.equal(after.articles[1].name, "ELONEX (25 mg)"); assert.equal(after.articles[1].sku, input.variants[1].sku); assert.equal(after.article_seo[0].slug, "local-elonext");
  assert.deepEqual(after.articles[0], { ...before.articles[0], variants: null, updated_at: after.articles[0].updated_at });
  const mitro = await prepared("local-mitoss", [40]);
  await release({ ...mitro.request, selected: { ...mitro.request.selected, price: 105, targetStock: 8 }, content: { ...mitro.request.content, name: "MITRO" } });
  const shop = await caller(null).article.shopArticle({ shopProductId: "local-mitoss" }); assert.equal(shop.name, "MITRO"); assert.equal(shop.variants[0].sku, mitro.input.variants[0].sku);
});

test("CARTENDON finalized first20 stays61 with current sold stock; selected existing48 appends95/9", async () => {
  const { request, input, created } = await prepared("local-cartendon", [20, 48]);
  const draft = await drafts.readProductDraft(db, request.shopProductId);
  await finalizer.finalizeProductDraft(db, { shopProductId: request.shopProductId, masterArticleId: created.masterArticleId, requestKey: randomUUID(),
    expectedSnapshotHash: draft.snapshotHash, variants: [{ sku: input.variants[0].sku, price: 61, stock: 15 }] }, actor);
  await pool.query("UPDATE articles SET stock=12 WHERE id=$1", [created.masterArticleId]);
  const fresh = await service.readVariantReleaseSnapshot(db, request.shopProductId), before = await snapshot();
  const second = input.variants[1];
  const result = await release({ ...request, expectedSnapshotHash: fresh.expectedSnapshotHash, selected: { articleId: created.articleIds[1], sku: second.sku,
    label: second.label, imageUrl: second.imageUrl, composition: second.composition, price: 95, targetStock: 9 } });
  const after = await snapshot(); assert.equal(result.masterArticleId, created.masterArticleId); assert.equal(result.variants.length, 2);
  assert.equal(after.articles[0].selling_price, "61.00"); assert.equal(after.articles[0].stock, 12); assert.equal(after.articles[0].sku, before.articles[0].sku);
  assert.equal(after.articles[1].stock, 9); assert.equal(after.articles[1].selling_price, "95.00"); assert.equal(result.variants[0].stock, 12);
  assert.equal(after.stock_history.filter(a => a.article_id === created.masterArticleId).length, before.stock_history.filter(a => a.article_id === created.masterArticleId).length);
  assert.equal((await caller(null).article.shopArticle({ shopProductId: request.shopProductId })).variants.length, 2);
  assert.equal(pricing.resolveAuthoritativeItemPrice({ shopProductId: request.shopProductId, dosage: "48 mg", price: 999, quantity: 1 }, catalog(after.articles)), 95);
});

async function legacyKpv() {
  await pool.query("INSERT INTO articles(sku,name,shop_product_id,selling_price,stock,shop_visible,is_active,description) VALUES('DEACTIVATED-21','ARCHIVED KPV','local-kpv',0,0,0,0,'{\"private\":true}')");
  await pool.query("INSERT INTO articles(sku,name,shop_product_id,selling_price,stock,shop_visible,is_active,purity,cas_number,molecular_weight,mockup_image_url,variants) VALUES('KPV-10MG','KPV 10 mg','local-kpv',40,10,1,1,'99%','67727-97-3','370 g/mol','https://example.invalid/kpv-old.webp',$1::jsonb)",
    [JSON.stringify([{ label: "10 mg", dosage: "10 mg", sku: "KPV-10MG", price: 40, inventoryArticleId: 2 }])]);
  await pool.query("INSERT INTO article_translations(article_id,lang,name,description) VALUES(1,'de','ARCHIVED','{\"private\":true}'),(2,'en','Legacy KPV','{\"legacy\":true}')");
  const state = await service.readVariantReleaseSnapshot(db, "local-kpv", 2);
  return { shopProductId: "local-kpv", masterArticleId: 2, requestKey: randomUUID(), expectedSnapshotHash: state.expectedSnapshotHash,
    selected: { articleId: null, sku: "KPV-30MG", label: "30 mg", price: 89, targetStock: 9, imageUrl: "https://example.invalid/kpv-30.webp", composition: { totalMassMg: 30, components: [{ name: "KPV", massMg: 30 }] } },
    content: content("local-kpv", "KPV") };
}
test("legacy KPV sole active master with missing metadata appends30 preserving archive and40/10/chemistry", async () => {
  const request = await legacyKpv(), before = await snapshot();
  await assert.rejects(service.readVariantReleaseSnapshot(db, "local-kpv", 1), conflict);
  const result = await caller().productAdmin.releaseVariant(request), after = await snapshot();
  assert.equal(result.masterArticleId, 2); assert.deepEqual(after.articles[0], before.articles[0]);
  assert.equal(after.articles[1].selling_price, "40.00"); assert.equal(after.articles[1].stock, 10); assert.equal(after.articles[1].sku, "KPV-10MG");
  assert.equal(after.articles[1].cas_number, before.articles[1].cas_number); assert.equal(after.articles[1].purity, "99%");
  assert.equal(after.articles[2].selling_price, "89.00"); assert.equal(after.articles[2].stock, 9); assert.equal(after.articles[2].purity, null);
  assert.deepEqual(after.article_translations[0], before.article_translations[0]); assert.equal(after.article_translations.find(a => a.article_id === 2 && a.lang === "de")!.name, "KPV");
  const read = await caller().productAdmin.getVariantReleaseSnapshot({ shopProductId: "local-kpv", masterArticleId: 2 });
  assert.equal(read.articles.length, 3); assert.equal(read.metadata.translations.length, 3); assert(read.seo); assert(read.merchant);
});

test("exact concurrent replay journals once and remains historical after legitimate stock sale", async () => {
  const { request } = await prepared(); const results = await Promise.all([release(request), release(request), release(request)]);
  assert.deepEqual(results[0], results[1]); assert.deepEqual(results[1], results[2]); let stable = await snapshot();
  assert.equal(stable.product_audit_log.filter(a => a.action === "RELEASE_VARIANT").length, 1); assert.equal(stable.stock_history.length, 1);
  await pool.query("UPDATE articles SET stock=stock-1 WHERE id=$1", [results[0].selectedArticleId]); stable = await snapshot();
  assert.deepEqual(await release(request), results[0]); assert.deepEqual(await snapshot(), stable);
  await assert.rejects(release({ ...request, selected: { ...request.selected, price: 80 } }), conflict); assert.deepEqual(await snapshot(), stable);
});

test("stale hashes, concurrent competing keys and locked selected sale never overwrite stock", async () => {
  const { request } = await prepared();
  await pool.query("UPDATE articles SET min_stock=7 WHERE id=$1", [request.selected.articleId]);
  const stale = await snapshot(); await assert.rejects(release(request), conflict); assert.deepEqual(await snapshot(), stale);
  const fresh = await service.readVariantReleaseSnapshot(db, request.shopProductId);
  const next = { ...request, expectedSnapshotHash: fresh.expectedSnapshotHash };
  const results = await Promise.allSettled([release(next), release({ ...next, requestKey: randomUUID() })]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1); assert.equal(results.filter(r => r.status === "rejected").length, 1);
  const updated = await service.readVariantReleaseSnapshot(db, request.shopProductId);
  const sale = await pool.connect(); await sale.query("BEGIN"); await sale.query("UPDATE articles SET stock=stock-1 WHERE id=$1", [request.selected.articleId]);
  const blocked = release({ ...next, requestKey: randomUUID(), expectedSnapshotHash: updated.expectedSnapshotHash, selected: { ...next.selected, targetStock: 35 } });
  await new Promise(resolve => setTimeout(resolve, 100)); await sale.query("COMMIT"); sale.release();
  const sold = await snapshot(); await assert.rejects(blocked, conflict); assert.deepEqual(await snapshot(), sold); assert.equal(sold.articles[0].stock, 29);
});

test("audit, stock-history and FAQ failure rollback complete new/master/metadata transaction", async () => {
  for (const table of ["product_audit_log", "stock_history", "article_faq"]) {
    const { request } = await prepared(`local-fail-${table.replaceAll("_", "-")}`), stable = await snapshot();
    const next = { ...request, selected: { ...request.selected, articleId: null, sku: `${request.shopProductId}-24MG`, label: "24 mg", composition: composition(24) } };
    await failInsert(table, async () => { await assert.rejects(release(next)); }); assert.deepEqual(await snapshot(), stable);
    assert.equal((await release(next)).shopVisible, true);
  }
});

test("trigger sibling mutation and metadata/journal corruption fail exact checks and rollback", async () => {
  for (const target of ["articles", "article_merchant", "stock_history"]) {
    const { request, created } = await prepared(`local-corrupt-${target.replaceAll("_", "-")}`), stable = await snapshot();
    const corrupt = target === "articles" ? `UPDATE articles SET stock=99 WHERE id=${created.articleIds[1]};`
      : target === "article_merchant" ? `UPDATE article_merchant SET mpn='CORRUPT' WHERE article_id=${created.masterArticleId};`
      : `UPDATE stock_history SET quantity_after=99 WHERE article_id=${created.masterArticleId};`;
    await pool.query(`CREATE FUNCTION local_release_corrupt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${corrupt} RETURN NEW; END $$;
      CREATE TRIGGER local_release_corrupt AFTER UPDATE OF variants ON articles FOR EACH ROW EXECUTE FUNCTION local_release_corrupt()`);
    try { await assert.rejects(release(request), conflict); assert.deepEqual(await snapshot(), stable); }
    finally { await pool.query("DROP TRIGGER local_release_corrupt ON articles; DROP FUNCTION local_release_corrupt()"); }
  }
});

test("foreign master, foreign selected row, duplicate SKU alias, strength conversion and missing content fail closed", async () => {
  const { request, created } = await prepared(), other = await prepared("local-other"); let stable = await snapshot();
  for (const next of [{ ...request, masterArticleId: other.created.masterArticleId }, { ...request, selected: { ...request.selected, articleId: other.created.masterArticleId } },
    { ...request, selected: { ...request.selected, label: "24 mg", composition: composition(24) } }, { ...request, content: undefined },
    { ...request, selected: { ...request.selected, composition: { totalMassMg: 12.5, components: [{ name: "Changed", massMg: 12.5 }] } } }]) {
    await assert.rejects(release(next)); assert.deepEqual(await snapshot(), stable);
  }
  await pool.query("INSERT INTO articles(sku,name,shop_product_id,selling_price,stock,shop_visible) VALUES($1,'Alias','local-alias',10,0,0)", [request.selected.sku.toLowerCase()]);
  stable = await snapshot(); await assert.rejects(release(request), conflict); assert.deepEqual(await snapshot(), stable);
  assert.equal(created.masterArticleId, request.masterArticleId);
});

test("read and release router guards deny unauthenticated/basic/packing principals and generic finalized routes stay restricted", async () => {
  const { request } = await prepared(), stable = await snapshot();
  for (const principal of [null, ...["user", "customer", "packing", "ops", "finance"].map(role => ({ ...manager, role }))]) {
    await assert.rejects(caller(principal).productAdmin.getVariantReleaseSnapshot({ shopProductId: request.shopProductId }), (e: any) => ["UNAUTHORIZED", "FORBIDDEN"].includes(e.code));
    await assert.rejects(caller(principal).productAdmin.releaseVariant(request), (e: any) => ["UNAUTHORIZED", "FORBIDDEN"].includes(e.code));
    assert.deepEqual(await snapshot(), stable);
  }
  const result = await caller({ ...manager, role: "admin" }).productAdmin.releaseVariant(request); const after = await snapshot();
  await assert.rejects(caller().productAdmin.updatePricing({ shopProductId: request.shopProductId, sellingPrice: 80 }));
  await assert.rejects(caller().article.update({ id: result.masterArticleId, variants: [{ label: request.selected.label, price: 80 }] }));
  assert.deepEqual(await snapshot(), after);
});

test("strict input type/unknown/HTTPS/cents/integer/total/component matrix rejects before writes", async () => {
  const { request } = await prepared(), stable = await snapshot();
  const candidates = [{ ...request, requestKey: "bad" }, { ...request, expectedSnapshotHash: "bad" }, { ...request, publish: true },
    { ...request, selected: [request.selected] }, { ...request, selected: { ...request.selected, table: "articles" } },
    ...[NaN, Infinity, 0, -1, 79.001, 79.0000000001, 100000000].map(price => ({ ...request, selected: { ...request.selected, price } })),
    ...[-1, 0.5, 2147483648, Infinity, NaN].map(targetStock => ({ ...request, selected: { ...request.selected, targetStock } })),
    ...["http://example.invalid/a.webp", "https://user:pass@example.invalid/a.webp"].map(imageUrl => ({ ...request, selected: { ...request.selected, imageUrl } })),
    { ...request, selected: { ...request.selected, composition: { totalMassMg: 12.5, components: [{ name: "A", massMg: 12 }] } } },
    { ...request, selected: { ...request.selected, composition: { totalMassMg: 13, components: [{ name: "A", massMg: 13 }] } } },
    { ...request, content: { ...request.content, description: { ...request.content.description, stock: 5 } } }];
  for (const next of candidates) { assert.equal(service.releaseProductVariantInput.safeParse(next).success, false); await assert.rejects(release(next)); }
  assert.deepEqual(await snapshot(), stable);
});

test("honest null chemistry permits exact negative disclaimers, affirmative claims remain blocked", async () => {
  const { request } = await prepared(); request.content.description.risiko = "Keine Dosierung, keine Anwendungsempfehlung. Research Use Only. Not for human use.";
  const stable = await snapshot();
  await assert.rejects(release({ ...request, content: { ...request.content, description: { ...request.content.description, risiko: `${request.content.description.risiko} Dosierung 5 mg täglich.` } } }));
  assert.deepEqual(await snapshot(), stable); assert.equal((await release(request)).validation.score, 100);
});

test("legacy active FAQ/technical-zero schema supports second-strength promotion and metadata migration", async () => {
  await legacy(async () => {
    const { request, created, input } = await prepared("local-legacy"); assert.equal((await snapshot()).articles[0].selling_price, "0.00");
    const second = input.variants[1]; const result = await release({ ...request, selected: { articleId: created.articleIds[1], sku: second.sku,
      label: second.label, imageUrl: second.imageUrl, composition: second.composition, price: 165, targetStock: 9 } });
    assert.equal(result.masterArticleId, created.articleIds[1]); const after = await snapshot(); assert(after.article_faq.every(f => f.active === 1 && f.article_id === result.masterArticleId));
    assert.equal(after.articles[0].stock, 0); assert.equal(after.articles[0].selling_price, "0.00"); assert.equal(after.articles[0].shop_visible, 0); assert.equal(after.articles[0].variants, null);
  });
});

test("image-only same-target release books no stock and preserves current stock despite stale JSON mirror", async () => {
  const { request } = await prepared("local-image", [40]); await release(request);
  await pool.query("UPDATE articles SET stock=45 WHERE id=$1", [request.selected.articleId]);
  const state = await service.readVariantReleaseSnapshot(db, request.shopProductId), before = await snapshot();
  const next = { ...request, requestKey: randomUUID(), expectedSnapshotHash: state.expectedSnapshotHash, selected: { ...request.selected, targetStock: 45, imageUrl: "https://example.invalid/final.webp" },
    content: { ...request.content, seo: { ...request.content.seo, ogImage: "https://example.invalid/final.webp" } } };
  const result = await release(next), after = await snapshot(); assert.deepEqual(result.stockMovements, []); assert.deepEqual(after.stock_history, before.stock_history);
  assert.equal(after.articles[0].stock, 45); assert.equal(after.articles[0].variants[0].stock, 45); assert.equal(after.articles[0].variants[0].imageUrl, next.selected.imageUrl); assert.equal(after.article_seo[0].og_image, next.selected.imageUrl);
});
