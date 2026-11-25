import nodeAssert from "node:assert/strict";
import test, { before, after, beforeEach, afterEach, mock } from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { Socket } from "node:net";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

// No skip/fallback and no database URL: only our fresh, secret-free unix socket.
const socket = process.env.FINALIZE_TEST_PG_SOCKET;
if (!socket || !/^\/tmp\/369-product-finalize\.[A-Za-z0-9]+\/socket$/.test(socket)
  || realpathSync(socket) !== socket || process.env.DATABASE_URL || process.env.RAILWAY_DB_URL
  || process.env.DOTENV_CONFIG_PATH !== "/dev/null" || process.env.FINALIZE_TEST_SANITIZED !== "1")
  throw Error("DEDICATED_LOCAL_SECRET_FREE_DRAFT_FIXTURE_REQUIRED");
const pgSocket = `${socket}/.s.PGSQL.55465`;
const fixtureDdl = readFileSync(`${socket}/../schema.sql`, "utf8");
let assertionCalls = 0;
// Count executed assertions (including repeated matrix checks), not source lines.
const assert: typeof nodeAssert = new Proxy(nodeAssert, {
  apply(target, receiver, args) { assertionCalls++; return Reflect.apply(target, receiver, args); },
  get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver);
    return typeof value === "function" ? (...args: unknown[]) => {
      assertionCalls++; return Reflect.apply(value, target, args);
    } : value;
  },
}) as typeof nodeAssert;
const actor = "local_draft_product_manager";
const pool = new pg.Pool({ host: socket, port: 55465, user: "family_local", database: "family_local", max: 6 });
const db = drizzle(pool);
let service: typeof import("./productDraft.js");
let finalization: typeof import("./productDraftFinalization.js");
let pricing: typeof import("./kwkCheckoutPricing.js");
let networkCalls = 0, blockedSocketCalls = 0, forbiddenTableCalls = 0, observedQueries = 0;
const observedStatements: string[] = [];
let app: any;
const manager = { id: 2, username: actor, role: "product_manager", name: null, email: null };
const caller = (user: any = manager) => app.createCaller({ req: { headers: {} }, res: {}, user });
let originalSentinels: unknown;
const productTables = ["articles", "article_seo", "article_merchant", "article_translations", "article_faq",
  "article_use_cases", "stock_history", "product_audit_log", "use_cases"];
const conflict = (error: any) => error?.code === "CONFLICT";
const clone = <T>(value: T): T => structuredClone(value);

function payload(shopProductId = "local-nexus-v") {
  return {
    requestKey: randomUUID(), shopProductId, name: "NEXUS V", category: "Vials",
    categories: ["Vials", "Metabolisch & Körperkomposition"],
    shortDescription: "Definierte Komponenten für Laborforschung. Research Use Only. Not for human use.",
    badge: "Research Blend", casNumber: null, molecularWeight: null, purity: null,
    description: { kurztext: "Blend mit expliziter Composition je Stärke.",
      wirkung: "Präklinischer Forschungskontext der Einzelkomponenten, kein Synergienachweis.",
      fazit: "Forschungsmaterial mit noch offenen Produktdaten.", risiko: "Research Use Only. Not for human use.",
      highlights: ["Composition je Stärke", "Preis und Reinheit offen"],
      eigenschaften: { reinheit: "Chargennachweis ausstehend", form: "Lyophilisiertes Research-Vial", storage: "Gemäß Laborprotokoll" },
      sources: ["https://example.invalid/research"] },
    variants: [
      { label: "12.5 mg", sku: `${shopProductId}-12-5MG`, imageUrl: "https://example.invalid/nexus-v-12-5.png", price: null, stock: 0,
        composition: { totalMassMg: 12.5, components: [{ name: "3G - TRIPLE G", massMg: 10 }, { name: "Cagrilintide", massMg: 2.5 }] } },
      { label: "25 mg", sku: `${shopProductId}-25MG`, imageUrl: "https://example.invalid/nexus-v-25.png", price: null, stock: 0,
        composition: { totalMassMg: 25, components: [{ name: "3G - TRIPLE G", massMg: 20 }, { name: "Cagrilintide", massMg: 5 }] } },
    ],
    seo: { seoTitle: "NEXUS V Research Blend | 369 Research", seoDescription: "Research Blend mit transparenter Composition je Stärke. Ausschließlich Laborforschung.",
      canonical: `https://www.369research.eu/product/${shopProductId}`, imageAlt: "NEXUS V Research-Vials 12.5 mg und 25 mg", ogImage: "https://example.invalid/nexus-v-og.png" },
    merchant: { merchantTitle: "NEXUS V Research-Vial", merchantDescription: "Composition je Stärke. Research Use Only. Not for human use.",
      brand: "369 Research", googleProductCategory: null, productType: "Forschungsmaterialien > Peptid-Blends > Vials" },
    faqs: Array.from({ length: 6 }, (_, index) => ({ lang: "de", question: `Forschungsfrage ${index + 1}?`, answer: "Nur für Laborforschung. Research Use Only. Not for human use." })),
    useCaseSlugs: ["metabolic-research"],
    social: { whatsapp: "Research-Draft für WhatsApp, nicht senden.", tiktok: "Research-Draft für TikTok, nicht veröffentlichen.",
      instagram: "Research-Draft für Instagram, nicht veröffentlichen.", launch: "Launch bleibt gesperrt bis zur ausdrücklichen Freigabe." },
  };
}
const create = (input: unknown) => Promise.resolve().then(() => service.createProductDraft(db, service.createProductDraftInput.parse(input), actor));
const read = (slug: string) => service.readProductDraft(db, slug);
async function snapshot() {
  const rows: Record<string, any[]> = {};
  for (const table of productTables) rows[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
  return rows;
}
function protectedRows(rows: Awaited<ReturnType<typeof snapshot>>) {
  return Object.fromEntries(productTables.map(table => [table, table === "use_cases"
    ? rows[table] : rows[table].filter(row => table === "articles" ? row.id <= 3 : row.article_id <= 3)]));
}
async function sequence() { return (await pool.query("SELECT last_value,is_called FROM articles_id_seq")).rows[0]; }
async function withSchemaChange(statement: string, work: () => Promise<void>) {
  await pool.query(statement);
  try { await work(); } finally {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await pool.query(fixtureDdl);
    await seedFixture();
  }
}
async function failInsert(table: string, work: () => Promise<void>) {
  if (!["articles", "article_seo", "article_merchant", "article_translations", "article_faq", "article_use_cases", "product_audit_log", "stock_history"].includes(table)) throw Error("FIXED_TABLE_REQUIRED");
  await pool.query(`CREATE FUNCTION local_draft_fail_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'LOCAL_DRAFT_INSERT_FAILURE'; END $$;
    CREATE TRIGGER local_draft_insert_failure BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION local_draft_fail_insert()`);
  try { await work(); } finally { await pool.query(`DROP TRIGGER local_draft_insert_failure ON ${table}; DROP FUNCTION local_draft_fail_insert()`); }
}
async function seedFixture() {
  await pool.query("TRUNCATE article_seo,article_merchant,article_translations,article_faq,article_use_cases,stock_history,product_audit_log,articles,use_cases RESTART IDENTITY CASCADE");
  await pool.query("INSERT INTO use_cases(slug,visible,created_at,updated_at) VALUES('metabolic-research',0,'2020-01-02','2021-02-03'),('fat-loss',1,'2020-01-02','2021-02-03')");
  // Independently seeded former SOMATIDE and published old NEXUS; no suite side effects.
  const oldProducts = [
    { sku: "SOMATIDE-15MG", name: "SOMATIDE (15 mg)", slug: "somatide", label: "15 mg", price: "70.00", stock: 19, visible: 1,
      composition: { totalMassMg: 15, components: [{ name: "Tesamorelin", massMg: 10 }, { name: "Ipamorelin", massMg: 5 }] } },
    { sku: "NEXUS-IV-12-5MG", name: "NEXUS IV (12.5 mg)", slug: "nexus-iv", label: "12.5 mg", price: "88.00", stock: 8, visible: 1,
      composition: { totalMassMg: 12.5, components: [{ name: "Former component A", massMg: 10 }, { name: "Former component B", massMg: 2.5 }] } },
    { sku: "NEXUS-IV-25MG", name: "NEXUS IV (25 mg)", slug: "nexus-iv", label: "25 mg", price: "144.00", stock: 4, visible: 0,
      composition: { totalMassMg: 25, components: [{ name: "Former component A", massMg: 20 }, { name: "Former component B", massMg: 5 }] } },
  ];
  for (const [index, p] of oldProducts.entries()) {
    await pool.query(`INSERT INTO articles(sku,name,shop_product_id,selling_price,stock,shop_visible,is_active,purity,description,mockup_image_url,gallery_images,published_at,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,1,'99%',$7::jsonb,$8,$9::jsonb,CASE WHEN $6=1 THEN '2025-01-02'::timestamp ELSE NULL END,'2020-01-02','2021-02-03')`,
    [p.sku, p.name, p.slug, p.price, p.stock, p.visible, JSON.stringify({ kurztext: "PROTECTED sentinel", composition: p.composition, untouched: true }),
      `https://example.invalid/protected-${index}.png`, JSON.stringify([`https://example.invalid/protected-${index}.png`])]);
    await pool.query("INSERT INTO stock_history(article_id,change_type,quantity_before,quantity_change,quantity_after,reason,created_at) VALUES($1,'wareneingang',0,$2,$2,'protected sentinel','2020-01-02')", [index + 1, p.stock]);
  }
  await pool.query("UPDATE articles SET variants=$2::jsonb WHERE id=$1", [1, JSON.stringify([{ label: "15 mg", sku: oldProducts[0].sku, inventoryArticleId: 1, price: 70, stock: 19 }])]);
  await pool.query("UPDATE articles SET variants=$2::jsonb WHERE id=$1", [2, JSON.stringify(oldProducts.slice(1).map((p, i) => ({ label: p.label, sku: p.sku, inventoryArticleId: i + 2, price: Number(p.price), stock: p.stock })))]);
  for (const id of [1, 2]) {
    const p = oldProducts[id - 1];
    await pool.query("INSERT INTO article_seo(article_id,slug,seo_title,canonical,created_at,updated_at) VALUES($1,$2,'Protected SEO',$3,'2020-01-02','2021-02-03')", [id, p.slug, `https://www.369research.eu/product/${p.slug}`]);
    await pool.query("INSERT INTO article_merchant(article_id,brand,merchant_title,created_at,updated_at) VALUES($1,'Protected brand','Protected Merchant','2020-01-02','2021-02-03')", [id]);
    await pool.query("INSERT INTO article_translations(article_id,lang,name,description,created_at,updated_at) VALUES($1,'de','Protected translation','{\"untouched\":true}'::jsonb,'2020-01-02','2021-02-03')", [id]);
    await pool.query("INSERT INTO article_faq(article_id,lang,question,answer,sort_order,is_visible,created_at,updated_at) VALUES($1,'de','Protected visible?','Never change',1,1,'2020-01-02','2021-02-03'),($1,'de','Protected hidden?','Keep hidden',2,0,'2020-01-02','2021-02-03')", [id]);
    await pool.query("INSERT INTO article_use_cases(article_id,use_case_id,sort_order,is_primary,created_at) VALUES($1,2,8,1,'2020-01-02')", [id]);
    await pool.query("INSERT INTO product_audit_log(article_id,action,changed_by,new_value,changed_at) VALUES($1,'SENTINEL','fixture','untouched','2020-01-02')", [id]);
  }
}

before(async () => {
  mock.method(globalThis, "fetch", async () => { networkCalls++; throw Error("NETWORK_FORBIDDEN"); });
  const connect = Socket.prototype.connect;
  mock.method(Socket.prototype, "connect", function (this: Socket, ...args: any[]) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const path = typeof first === "string" ? first : first?.path;
    if (path !== pgSocket) { blockedSocketCalls++; throw Error("NON_FIXTURE_SOCKET_FORBIDDEN"); }
    return Reflect.apply(connect, this, args);
  } as any);
  const query = pg.Client.prototype.query;
  mock.method(pg.Client.prototype, "query", function (this: pg.Client, ...args: any[]) {
    const statement = typeof args[0] === "string" ? args[0] : args[0]?.text ?? "";
    observedQueries++;
    observedStatements.push(statement);
    // Runtime enforcement, including reads: unrelated business tables never accessed.
    // The exact generated fixture DDL is the sole exception, only for teardown
    // restoration after schema-compatibility tests; application SQL has no bypass.
    if (statement !== fixtureDdl && /\b(?:orders|order_items|payments|payment_transactions|invoices|customers|users)\b/i.test(statement)) {
      forbiddenTableCalls++; throw Error("NON_PRODUCT_TABLE_FORBIDDEN");
    }
    return Reflect.apply(query, this, args);
  } as any);
  const { ENV } = await import("./env.js");
  for (const key of Object.keys(ENV)) if (/key|password|secret/i.test(key)) (ENV as any)[key] = "";
  const { closeDb } = await import("./db.js");
  await closeDb();
  ENV.databaseUrl = `postgresql://family_local@localhost:55465/family_local?host=${encodeURIComponent(socket!)}`;
  service = await import("./productDraft.js");
  finalization = await import("./productDraftFinalization.js");
  pricing = await import("./kwkCheckoutPricing.js");
  const [{ router }, { productAdminRouter }, { articleRouter }] = await Promise.all([
    import("./trpc.js"), import("./productAdminRouter.js"), import("./articleRouter.js"),
  ]);
  app = router({ productAdmin: productAdminRouter, article: articleRouter });
  assert.deepEqual((await pool.query("SELECT current_user,current_database(),inet_server_addr() AS address,current_setting('listen_addresses') AS listening")).rows[0],
    { current_user: "family_local", current_database: "family_local", address: null, listening: "" });
});
beforeEach(async () => { await seedFixture(); originalSentinels = protectedRows(await snapshot()); });
afterEach(async () => { assert.deepEqual(protectedRows(await snapshot()), originalSentinels, "SOMATIDE, old NEXUS and all existing stock/use-case rows remain byte-for-byte unchanged"); });
after(async () => {
  try {
    assert.equal(networkCalls, 0); assert.equal(blockedSocketCalls, 0); assert.equal(forbiddenTableCalls, 0);
    console.log(`Finalization isolation evidence: assertions=${assertionCalls}; observed SQL queries=${observedQueries}; HTTP calls=${networkCalls}; non-fixture sockets=${blockedSocketCalls}; forbidden business-table queries=${forbiddenTableCalls}; unix-only family_local fixture.`);
  } finally {
    await (await import("./db.js")).closeDb();
    (await import("./env.js")).ENV.databaseUrl = "";
    await pool.end(); mock.restoreAll();
  }
});


const finalize = (input: unknown) => Promise.resolve().then(() => finalization.finalizeProductDraft(db, finalization.finalizeProductDraftInput.parse(input), actor));
async function prepared(slug = "local-cartendon", single = false) {
  const input = payload(slug);
  if (single) input.variants = input.variants.slice(0, 1);
  const created = await create(input), draft = await read(slug);
  return { input, created, draft, request: { shopProductId: slug, masterArticleId: created.masterArticleId, requestKey: randomUUID(),
    expectedSnapshotHash: draft.snapshotHash, variants: [{ sku: input.variants[0].sku, price: single ? 69 : 61, stock: 15 }] } };
}
const priceItem = (shopProductId: string, dosage = "12.5 mg") => ({ shopProductId, dosage, price: 999, quantity: 1 });
function catalog(rows: any[]) { return rows.map(a => ({ ...a, shopProductId: a.shop_product_id, sellingPrice: a.selling_price, salePrice: a.sale_price, shopVisible: a.shop_visible, isActive: a.is_active })); }

test("exact article-bound audit read resolves the promoted master without sibling fallback", async () => {
  const { input, created, request } = await prepared("local-audit-exact");
  assert(Array.isArray(await caller().productAdmin.getAuditLog({ shopProductId: input.shopProductId })));
  assert.equal((await caller().productAdmin.getAuditLog({ shopProductId: input.shopProductId, articleId: created.masterArticleId })).length, 1);
  await finalize(request);
  const stable = await snapshot();
  const logs = await caller().productAdmin.getAuditLog({ shopProductId: input.shopProductId, articleId: created.masterArticleId });
  assert.equal(logs.filter((entry: any) => entry.action === "FINALIZE_DRAFT" && entry.fieldName === `request:${request.requestKey}`).length, 1);
  assert(logs.every((entry: any) => entry.articleId === created.masterArticleId));
  assert.deepEqual(await caller().productAdmin.getAuditLog({ shopProductId: input.shopProductId, articleId: created.articleIds[1] }), []);
  await assert.rejects(caller().productAdmin.getAuditLog({ shopProductId: input.shopProductId, articleId: 1 }));
  await assert.rejects(caller(null).productAdmin.getAuditLog({ shopProductId: input.shopProductId, articleId: created.masterArticleId }));
  assert.deepEqual(await snapshot(), stable);
});

test("fresh journal-only corruption and timestamp-only stale snapshots reject without writes", async () => {
  const { request, created } = await prepared();
  await pool.query("INSERT INTO stock_history(article_id,change_type,quantity_before,quantity_change,quantity_after,reason) VALUES($1,'korrektur',0,0,0,'local corrupt')", [created.masterArticleId]);
  const stable = await snapshot(); await assert.rejects(finalize(request), conflict); assert.deepEqual(await snapshot(), stable);
  await pool.query("DELETE FROM stock_history WHERE article_id=$1", [created.masterArticleId]);
  await pool.query("UPDATE articles SET updated_at=updated_at+interval '1 second' WHERE id=$1", [created.masterArticleId]);
  const dated = await snapshot(); await assert.rejects(finalize(request), conflict); assert.deepEqual(await snapshot(), dated);
});

test("composition volume/concentration/solvent values stay typed and legacy variant rewrites fail closed", async () => {
  const input = payload("local-volume"); input.variants = input.variants.slice(0, 1);
  (input.variants[0].composition as any).volumeMl = 2.5;
  (input.variants[0].composition as any).concentrationMgMl = 5;
  (input.variants[0].composition as any).solvents = ["Declared laboratory solvent"];
  const created = await create(input), draft = await read(input.shopProductId);
  const result = await finalize({ shopProductId: input.shopProductId, masterArticleId: created.masterArticleId, requestKey: randomUUID(),
    expectedSnapshotHash: draft.snapshotHash, variants: [{ sku: input.variants[0].sku, price: 69, stock: 15 }] });
  assert.deepEqual(result.variants[0].composition, input.variants[0].composition);
  const stable = await snapshot();
  await assert.rejects(caller().productAdmin.updatePricing({ shopProductId: input.shopProductId, sellingPrice: 70 }));
  await assert.rejects(caller().article.update({ id: created.masterArticleId, variants: [{ label: "12.5 mg", price: 70 }] }));
  assert.deepEqual(await snapshot(), stable);
  assert.equal(pricing.resolveAuthoritativeItemPrice({ ...priceItem(input.shopProductId), isFreeGift: true }, []), 0);
});

test("single MITOBOLIC-shaped 120 mg finalizes 69/15 preserving all types, images and honest unknown chemistry", async () => {
  const input = payload("local-mitobolic"); input.name = "MITOBOLIC";
  input.variants = [{ ...input.variants[0], label: "120 mg", sku: "LOCAL-MITOBOLIC-120MG",
    composition: { totalMassMg: 120, components: [{ name: "MOTS-c", massMg: 10 }, { name: "NAD+", massMg: 100 }, { name: "5-AMINO-1-MQ", massMg: 10 }] } }];
  input.badge = "Unveröffentlichter Entwurf";
  input.description.risiko = "Es werden keine Aussagen zur Injektion, zur Anwendung an Menschen oder Tieren, zu Dosierungen oder zu medizinischen Ergebnissen gemacht. Research Use Only. Not for human use.";
  (input.description as any).operatorNotes = ["PRIVATE_OPERATOR_NOTE", "Keine Human- oder Tieranwendung, keine Dosierung, keine Injektion und keine medizinischen Versprechen."];
  (input.description as any).typed = { string: "keep", number: 2.5, boolean: true, absent: null, list: [1, false, null, "keep"] };
  const created = await create(input), draft = await read(input.shopProductId), old = await snapshot();
  const request = { shopProductId: input.shopProductId, masterArticleId: created.masterArticleId, requestKey: randomUUID(),
    expectedSnapshotHash: draft.snapshotHash, variants: [{ sku: input.variants[0].sku, price: 69, stock: 15 }] };
  const result = await caller().productAdmin.finalizeDraft(request), after = await snapshot(), row = after.articles.find(a => a.id === created.masterArticleId)!;
  assert.equal(result.shopVisible, true); assert.equal(result.validation.score, 100);
  assert.equal(result.validation.validationProfile, "explicit-composition-draft-v1"); assert.deepEqual(result.validation.warnings, []);
  assert.equal(result.stockMovements.length, 1); assert.deepEqual(result.remainingDraftArticleIds, []);
  assert.equal(after.articles.length, old.articles.length); assert.equal(row.selling_price, "69.00"); assert.equal(row.stock, 15);
  assert.equal(row.shop_visible, 1); assert(row.published_at); assert.equal(row.notes, null); assert.equal(row.badge, null);
  assert.equal(row.purity, null); assert.equal(row.cas_number, null); assert.equal(row.molecular_weight, null);
  assert(!Object.hasOwn(row.description, "draftMeta")); assert(!Object.hasOwn(row.description, "operatorNotes"));
  assert.deepEqual(row.description.typed, (input.description as any).typed); assert.deepEqual(row.description.composition, input.variants[0].composition);
  assert.deepEqual(after.article_translations.find(a => a.article_id === row.id)!.description, row.description);
  assert.equal(after.article_merchant.find(a => a.article_id === row.id)!.availability, "in_stock");
  const history = after.stock_history.filter(a => a.article_id === row.id);
  assert.equal(history.length, 1); assert.equal(history[0].quantity_before, 0); assert.equal(history[0].quantity_change, 15);
  assert.equal(history[0].quantity_after, 15); assert.equal(history[0].change_type, "wareneingang");
  const receipt = after.product_audit_log.find(a => a.action === "FINALIZE_DRAFT")!;
  assert.equal(receipt.field_name, `request:${request.requestKey}`); assert.equal(receipt.changed_by, actor);
  assert.deepEqual(JSON.parse(receipt.new_value).response, result);
  assert.equal(JSON.parse(receipt.old_value).master.description.draftMeta.social.launch, input.social.launch);
  assert.equal(JSON.parse(receipt.old_value).master.description.operatorNotes[0], "PRIVATE_OPERATOR_NOTE");
  for (const table of ["article_seo", "article_faq", "article_use_cases"]) assert.deepEqual(after[table], old[table]);
  const product = (await caller(null).article.shopProducts()).find((p: any) => p.id === input.shopProductId);
  assert.equal(product.purity, null); assert.equal(product.price, 69); assert.equal(product.stock, 15); assert.equal(product.variants.length, 1);
  assert.equal(product.variants[0].sku, input.variants[0].sku); assert.equal(product.variants[0].image, input.variants[0].imageUrl); assert.equal(product.variants[0].stock, 15);
  assert(!JSON.stringify(product).includes("PRIVATE_OPERATOR_NOTE")); assert(!JSON.stringify(product).includes("social"));
  assert.equal(pricing.resolveAuthoritativeItemPrice(priceItem(input.shopProductId, "120 mg"), catalog(after.articles)), 69);
});

test("partial CARTENDON-shaped 20 mg at61/15 leaves 48 mg row EXACTLY unchanged and unavailable publicly", async () => {
  const input = payload("local-cartendon"); input.name = "CARTENDON";
  input.variants = [20, 48].map((mass, i) => ({ ...input.variants[i], label: `${mass} mg`, sku: `LOCAL-CARTENDON-${mass}MG`,
    composition: { totalMassMg: mass, components: [{ name: "Cartalax", massMg: mass / 2 }, { name: "BPC-157", massMg: mass / 4 }, { name: "TB-500", massMg: mass / 4 }] } }));
  const created = await create(input), draft = await read(input.shopProductId), before = await snapshot();
  const result = await finalize({ shopProductId: input.shopProductId, masterArticleId: created.masterArticleId, requestKey: randomUUID(),
    expectedSnapshotHash: draft.snapshotHash, variants: [{ sku: input.variants[0].sku, price: 61, stock: 15 }] }), after = await snapshot();
  assert.deepEqual(after.articles.find(a => a.id === created.articleIds[1]), before.articles.find(a => a.id === created.articleIds[1]));
  assert.deepEqual(result.remainingDraftArticleIds, [created.articleIds[1]]); assert.equal(result.variants.length, 1);
  assert.equal(after.stock_history.filter(a => a.article_id === created.articleIds[1]).length, 0);
  const family = await caller().productAdmin.getFamily({ shopProductId: input.shopProductId });
  assert.equal(family.variants.length, 1); assert.equal(family.articles.length, 2); assert.equal(family.masterArticleId, created.masterArticleId);
  await assert.rejects(read(input.shopProductId), (e: any) => e.code === "NOT_FOUND");
  const shop = await caller(null).article.shopArticle({ shopProductId: input.shopProductId });
  assert.equal(shop.variants.length, 1); assert.equal(shop.variants[0].sku, input.variants[0].sku); assert.equal(shop.variants[0].price, 61);
  assert.equal(shop.variants[0].stock, 15); assert.equal(shop.variants[0].image, input.variants[0].imageUrl); assert.equal(shop.purity, null);
  assert(!JSON.stringify(shop).includes(input.variants[1].sku)); assert(!JSON.stringify(shop).includes(input.variants[1].imageUrl));
  assert.deepEqual(Object.keys(shop.description.compositionVariants), [input.variants[0].sku]);
  assert.equal(pricing.resolveAuthoritativeItemPrice(priceItem(input.shopProductId, "20 mg"), family.articles), 61);
  for (const item of [priceItem(input.shopProductId, "48 mg"), priceItem(input.shopProductId, "99 mg"), priceItem(input.variants[1].sku, "48 mg")])
    assert.throws(() => pricing.resolveAuthoritativeItemPrice(item, family.articles));
  assert.equal((await caller(null).article.shopAvailability()).filter((p: any) => p.shopProductId === input.shopProductId).length, 1);
  const stable = await snapshot(); await assert.rejects(caller().productAdmin.publishFamily({ shopProductId: input.shopProductId, masterArticleId: created.masterArticleId, requestKey: randomUUID() })); assert.deepEqual(await snapshot(), stable);
});

test("exact concurrent replay books stock once; historical receipt survives later local sale without reset", async () => {
  const { request, created } = await prepared(); const results = await Promise.all([finalize(request), finalize(request), finalize(request)]);
  assert.deepEqual(results[0], results[1]); assert.deepEqual(results[0], results[2]);
  const stable = await snapshot(); assert.deepEqual(await finalize(request), results[0]); assert.deepEqual(await snapshot(), stable);
  assert.equal(stable.product_audit_log.filter(a => a.action === "FINALIZE_DRAFT").length, 1);
  assert.equal(stable.stock_history.filter(a => a.article_id === created.masterArticleId).length, 1);
  await pool.query("UPDATE articles SET stock=14 WHERE id=$1", [created.masterArticleId]);
  const sold = await snapshot(); assert.deepEqual(await finalize(request), results[0]); assert.deepEqual(await snapshot(), sold);
});

test("same key changed payload rejects; competing new keys finalize exactly once", async () => {
  const { request } = await prepared(); await finalize(request); const stable = await snapshot();
  for (const candidate of [{ ...request, variants: [{ ...request.variants[0], price: 62 }] }, { ...request, variants: [{ ...request.variants[0], stock: 16 }] },
    { ...request, expectedSnapshotHash: "f".repeat(64) }, { ...request, masterArticleId: 999 }, { ...request, shopProductId: "different" }]) {
    await assert.rejects(finalize(candidate), conflict); assert.deepEqual(await snapshot(), stable);
  }
  const competing = await prepared("local-competing");
  const results = await Promise.allSettled([finalize(competing.request), finalize({ ...competing.request, requestKey: randomUUID() })]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1); assert.equal(results.filter(r => r.status === "rejected").length, 1);
  assert.equal((await snapshot()).stock_history.filter(a => a.article_id === competing.created.masterArticleId).length, 1);
});

test("mandatory audit/history insert failure rolls back price, publication, JSON, metadata and stock", async () => {
  for (const table of ["product_audit_log", "stock_history"]) {
    const { request } = await prepared(`local-fail-${table.replace(/_/g, "-")}`), stable = await snapshot();
    await failInsert(table, async () => { await assert.rejects(finalize(request)); });
    assert.deepEqual(await snapshot(), stable); assert.equal((await finalize(request)).shopVisible, true);
  }
});

test("trigger mutation of unselected sibling is detected and fully rolled back", async () => {
  const { request, created } = await prepared(), stable = await snapshot();
  await pool.query(`CREATE FUNCTION local_finalize_corrupt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    UPDATE articles SET description='{"corrupted":true}'::jsonb WHERE id=${created.articleIds[1]}; RETURN NEW; END $$;
    CREATE TRIGGER local_finalize_corruption AFTER UPDATE OF variants ON articles FOR EACH ROW EXECUTE FUNCTION local_finalize_corrupt()`);
  try { await assert.rejects(finalize(request), conflict); assert.deepEqual(await snapshot(), stable); }
  finally { await pool.query("DROP TRIGGER local_finalize_corruption ON articles; DROP FUNCTION local_finalize_corrupt()"); }
});

test("stale complete snapshot and invalid sibling before-state fail without writes", async () => {
  const { request, created } = await prepared(); await pool.query("UPDATE articles SET min_stock=7 WHERE id=$1", [created.articleIds[1]]);
  const stale = await snapshot(); await assert.rejects(finalize(request), conflict); assert.deepEqual(await snapshot(), stale);
  const updated = await read(request.shopProductId); assert.notEqual(updated.snapshotHash, request.expectedSnapshotHash);
  await pool.query("UPDATE articles SET stock=1 WHERE id=$1", [created.articleIds[1]]);
  const invalid = await snapshot(); await assert.rejects(finalize({ ...request, expectedSnapshotHash: updated.snapshotHash })); assert.deepEqual(await snapshot(), invalid);
});

test("strict price/stock/type/bounds/unknown scope matrix rejects without allocating articles", async () => {
  const { request } = await prepared(), stable = await snapshot(), seq = await sequence();
  const bad = [{ ...request, requestKey: "bad" }, { ...request, expectedSnapshotHash: "bad" }, { ...request, publish: true }, { ...request, shopProductId: "somatide" },
    { ...request, masterArticleId: 0 }, { ...request, description: {} }, { ...request, variants: [] }, { ...request, variants: [request.variants[0], request.variants[0]] },
    ...[0, -1, NaN, Infinity, 9999.01, 61.001, 61.000000001].map(price => ({ ...request, variants: [{ ...request.variants[0], price }] })),
    ...[-1, 0.5, 2147483648, Infinity, NaN].map(stock => ({ ...request, variants: [{ ...request.variants[0], stock }] })),
    ...[{ imageUrl: "https://example.invalid/new.png" }, { composition: {} }, { salePrice: 1 }, { mystery: true }].map(change => ({ ...request, variants: [{ ...request.variants[0], ...change }] }))];
  for (const candidate of bad) { assert.equal(finalization.finalizeProductDraftInput.safeParse(candidate).success, false); await assert.rejects(finalize(candidate)); assert.deepEqual(await snapshot(), stable); }
  assert.deepEqual(await sequence(), seq);
  for (const sku of ["FAKE", "SOMATIDE-15MG", request.variants[0].sku.toUpperCase(), ` ${request.variants[0].sku}`]) {
    await assert.rejects(finalize({ ...request, variants: [{ ...request.variants[0], sku }] })); assert.deepEqual(await snapshot(), stable);
  }
});

test("wrong master/nonfirst selection/published product/ambiguous SKU fail closed", async () => {
  const { request, draft, created } = await prepared(); let stable = await snapshot();
  for (const candidate of [{ ...request, masterArticleId: created.articleIds[1] }, { ...request, variants: [{ ...request.variants[0], sku: draft.variants[1].sku }] },
    { ...request, shopProductId: "nexus-iv", masterArticleId: 2 }]) { await assert.rejects(finalize(candidate)); assert.deepEqual(await snapshot(), stable); }
  await pool.query("INSERT INTO articles(sku,name,shop_product_id,selling_price,stock,shop_visible) VALUES($1,'Alias','local-alias',10,0,0)", [request.variants[0].sku.toUpperCase()]);
  stable = await snapshot(); await assert.rejects(finalize(request), conflict); assert.deepEqual(await snapshot(), stable);
});

test("real endpoint denies missing/basic/packing actors, accepts admin and product_manager", async () => {
  const { request } = await prepared(), stable = await snapshot();
  for (const principal of [null, undefined, ...["user", "customer", "packing", "ops", "finance"].map(role => ({ ...manager, role }))]) {
    const c = principal === undefined ? app.createCaller({ req: { headers: {} }, res: {} }) : caller(principal);
    await assert.rejects(c.productAdmin.finalizeDraft(request), (e: any) => ["UNAUTHORIZED", "FORBIDDEN"].includes(e.code)); assert.deepEqual(await snapshot(), stable);
  }
  assert.equal((await caller({ ...manager, role: "admin" }).productAdmin.finalizeDraft(request)).shopVisible, true);
  assert.deepEqual(await caller().productAdmin.finalizeDraft(request), await caller({ ...manager, role: "admin" }).productAdmin.finalizeDraft(request));
});

test("zero/max stock and exact cents are bounded; one journal and derived merchant availability", async () => {
  for (const stock of [0, 2147483647]) {
    const { request } = await prepared(`local-stock-${stock}`, true);
    const result = await finalize({ ...request, variants: [{ ...request.variants[0], price: 0.01, stock }] });
    assert.equal(result.variants[0].price, 0.01); assert.equal(result.stockMovements[0].after, stock);
    const after = await snapshot(); assert.equal(after.article_merchant.find(a => a.article_id === result.masterArticleId)!.availability, stock ? "in_stock" : "out_of_stock");
    assert.equal(after.stock_history.filter(a => a.article_id === result.masterArticleId).length, 1);
  }
});

test("affirmative human-use remains blocked after exact negative disclaimer; unknown-purity text mandatory", async () => {
  for (const change of ["Research Use Only. Dosierung 5 mg täglich.", "Keine Dosierung, keine Anwendungsempfehlung. Research Use Only. Dosierung 5 mg täglich.", "Research Use Only. Es behandelt Krankheiten."]) {
    const input = payload(`local-compliance-${randomUUID().slice(0, 8)}`); input.description.risiko = change;
    const created = await create(input), draft = await read(input.shopProductId), stable = await snapshot();
    await assert.rejects(finalize({ shopProductId: input.shopProductId, masterArticleId: created.masterArticleId, requestKey: randomUUID(),
      expectedSnapshotHash: draft.snapshotHash, variants: [{ sku: input.variants[0].sku, price: 61, stock: 15 }] })); assert.deepEqual(await snapshot(), stable);
  }
  const input = payload("local-unknown-purity"); delete (input.description.eigenschaften as any).reinheit;
  const created = await create(input), draft = await read(input.shopProductId), stable = await snapshot();
  await assert.rejects(finalize({ shopProductId: input.shopProductId, masterArticleId: created.masterArticleId, requestKey: randomUUID(),
    expectedSnapshotHash: draft.snapshotHash, variants: [{ sku: input.variants[0].sku, price: 61, stock: 15 }] })); assert.deepEqual(await snapshot(), stable);
});

test("legacy-active FAQ/minimal optional schema and technical-zero storage finalize with sibling unchanged", async () => {
  await withSchemaChange("ALTER TABLE article_faq RENAME COLUMN is_visible TO active; ALTER TABLE article_faq DROP COLUMN updated_at; ALTER TABLE articles ALTER COLUMN selling_price SET NOT NULL; ALTER TABLE article_use_cases DROP COLUMN sort_order; ALTER TABLE article_use_cases DROP COLUMN is_primary", async () => {
    const { request, created, draft } = await prepared(), old = await snapshot();
    assert.equal(draft.productSchemaStatus.faqLayout, "legacy-active"); assert.equal(draft.master.sellingPrice, "0.00");
    assert.equal((await finalize(request)).variants[0].price, 61); const after = await snapshot();
    assert.deepEqual(after.articles.find(a => a.id === created.articleIds[1]), old.articles.find(a => a.id === created.articleIds[1]));
    assert.deepEqual(after.article_faq, old.article_faq); assert.deepEqual(after.article_use_cases, old.article_use_cases);
    assert.throws(() => pricing.resolveAuthoritativeItemPrice(priceItem(draft.variants[1].sku, "25 mg"), catalog(after.articles)));
  });
});
