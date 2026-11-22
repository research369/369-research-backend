import nodeAssert from "node:assert/strict";
import test, { before, after, beforeEach, afterEach, mock } from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { Socket } from "node:net";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

// No skip/fallback and no database URL: only our fresh, secret-free unix socket.
const socket = process.env.DRAFT_TEST_PG_SOCKET;
if (!socket || !/^\/tmp\/369-product-draft\.[A-Za-z0-9]+\/socket$/.test(socket)
  || realpathSync(socket) !== socket || process.env.DATABASE_URL || process.env.RAILWAY_DB_URL
  || process.env.DOTENV_CONFIG_PATH !== "/dev/null" || process.env.DRAFT_TEST_SANITIZED !== "1")
  throw Error("DEDICATED_LOCAL_SECRET_FREE_DRAFT_FIXTURE_REQUIRED");
const pgSocket = `${socket}/.s.PGSQL.55462`;
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
const pool = new pg.Pool({ host: socket, port: 55462, user: "family_local", database: "family_local", max: 6 });
const db = drizzle(pool);
let service: typeof import("./productDraft.js");
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
      properties: { form: "Lyophilisiertes Research-Vial", storage: "Gemäß Laborprotokoll" },
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
  return Object.fromEntries(productTables.map(table => [table, table === "use_cases" || table === "stock_history"
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
  ENV.databaseUrl = `postgresql://family_local@localhost:55462/family_local?host=${encodeURIComponent(socket!)}`;
  service = await import("./productDraft.js");
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
    console.log(`Draft isolation evidence: assertions=${assertionCalls}; observed SQL queries=${observedQueries}; HTTP calls=${networkCalls}; non-fixture sockets=${blockedSocketCalls}; forbidden business-table queries=${forbiddenTableCalls}; unix-only family_local fixture.`);
  } finally {
    await (await import("./db.js")).closeDb();
    (await import("./env.js")).ENV.databaseUrl = "";
    await pool.end(); mock.restoreAll();
  }
});

test("missing and legacy non-draft read fails closed without side effects", async () => {
  const old = await snapshot(), priorSequence = await sequence();
  await assert.rejects(read("does-not-exist"), (e: any) => e.code === "NOT_FOUND");
  await assert.rejects(read("nexus-iv"), (e: any) => e.code === "NOT_FOUND");
  assert.deepEqual(await snapshot(), old); assert.deepEqual(await sequence(), priorSequence);
});

test("complete hidden draft persists open null values, exact strength composition/images and coherent master inventory IDs", async () => {
  const input = payload(), old = await snapshot(), created = await create(input), result = await read(input.shopProductId);
  assert.equal(created.success, true); assert.equal(created.shopVisible, false); assert.equal(created.articleIds.length, 2);
  assert.equal(created.masterArticleId, created.articleIds[0]); assert.equal(result.masterArticleId, created.masterArticleId);
  assert(result.master); assert.equal(result.articles.length, 2);
  assert.equal(result.priceStatus, "open"); assert.equal(result.publicationReady, false);
  assert.deepEqual((result.master.description as any).draftMeta, { isDraft: true, priceStatus: "open", status: "draft", social: input.social, sellingPriceStorage: "null" });
  assert.deepEqual((result.master.description as any).compositionVariants, Object.fromEntries(input.variants.map(v => [v.sku, v.composition])));
  assert.equal(result.master.casNumber, null); assert.equal(result.master.molecularWeight, null); assert.equal(result.master.purity, null);
  assert.equal(result.master.shortDescription, input.shortDescription); assert.equal(result.master.badge, input.badge);
  assert.deepEqual(result.master.categories, input.categories); assert.deepEqual(result.master.galleryImages, input.variants.map(v => v.imageUrl));
  for (const [index, expected] of input.variants.entries()) {
    const row = result.articles[index], variant: any = result.variants[index];
    assert.equal(row.id, created.articleIds[index]); assert.equal(row.sku, expected.sku);
    assert.equal(row.name, `${input.name} (${expected.label})`); assert.equal(row.sellingPrice, null); assert.equal(row.salePrice, null);
    assert.equal(row.stock, 0); assert.equal(row.shopVisible, 0); assert.equal(row.publishedAt, null);
    assert.equal(row.mockupImageUrl, expected.imageUrl); assert.equal(row.labelImageUrl, expected.imageUrl);
    assert.equal(row.casNumber, null); assert.equal(row.molecularWeight, null); assert.equal(row.purity, null);
    assert.equal(variant.inventoryArticleId, row.id); assert.equal(variant.label, expected.label); assert.equal(variant.sku, row.sku);
    assert.equal(variant.price, null); assert.equal(variant.stock, 0); assert.equal(variant.imageUrl, expected.imageUrl);
    assert.deepEqual(variant.composition, expected.composition);
    assert.deepEqual((row.description as any).composition, expected.composition);
    assert.equal((row.description as any).draftMeta.isDraft, true); assert.equal(variant.priceStatus, "open");
    assert.equal(variant.composition.components.reduce((sum: number, c: any) => sum + c.massMg, 0), variant.composition.totalMassMg);
    assert.deepEqual(created.variants[index], variant);
    if (index > 0) assert.equal(row.variants, null);
  }
  assert.deepEqual(result.master.variants, result.variants);
  for (const [key, value] of Object.entries(input.description)) assert.deepEqual((result.master.description as any)[key], value);
  for (const [key, value] of Object.entries(input.seo)) assert.deepEqual((result.seo as any)[key], value);
  for (const [key, value] of Object.entries(input.merchant)) assert.deepEqual((result.merchant as any)[key], value);
  assert.equal(result.seo?.slug, input.shopProductId); assert.equal(result.merchant?.availability, "out_of_stock");
  assert.deepEqual(result.faqs.map((f: any) => ({ lang: f.lang, question: f.question, answer: f.answer })), input.faqs);
  assert(result.faqs.every((f: any) => f.articleId === created.masterArticleId && f.isVisible === 1));
  assert.equal(result.translations.length, 1); assert.equal(result.translations[0].lang, "de");
  assert.deepEqual(result.translations[0].description, result.master.description);
  assert.equal(result.translations[0].merchantDescription, input.merchant.merchantDescription);
  assert.deepEqual(result.useCases.map((u: any) => [u.articleId, u.slug]), [[created.masterArticleId, "metabolic-research"]]);
  assert.deepEqual(result.social, input.social);
  assert.deepEqual((await snapshot()).stock_history, old.stock_history);
  const audit = (await pool.query("SELECT * FROM product_audit_log WHERE article_id=$1", [created.masterArticleId])).rows;
  assert.equal(audit.length, 1); assert.equal(audit[0].action, "CREATE_DRAFT"); assert.equal(audit[0].changed_by, actor);
  assert.equal(audit[0].field_name, `request:${input.requestKey}`); assert.match(JSON.parse(audit[0].new_value).fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(audit[0].new_value).response, created);
  assert.equal(result.auditLog.length, 1); assert.equal(result.auditLog[0].id, audit[0].id);
  assert.equal(result.auditLog[0].articleId, created.masterArticleId);
  assert.equal(result.auditLog[0].fieldName, `request:${input.requestKey}`);
});

test("single-SKU draft supports one master, four FAQs, zero stock and no stock journal entry", async () => {
  const input = payload("local-single-draft"); input.variants = input.variants.slice(0, 1); input.faqs = input.faqs.slice(0, 4);
  const old = await snapshot(), created = await create(input), result = await read(input.shopProductId);
  assert.equal(created.articleIds.length, 1); assert.equal(created.masterArticleId, created.articleIds[0]); assert.equal(result.articles.length, 1);
  assert.equal(result.variants.length, 1); assert.equal(result.variants[0].inventoryArticleId, result.masterArticleId);
  assert.deepEqual(result.variants[0].composition, input.variants[0].composition); assert.equal(result.faqs.length, 4);
  assert.deepEqual((await snapshot()).stock_history, old.stock_history);
});

test("ten independent strengths are linked without aggregating inventory or composition", async () => {
  const input = payload("local-ten-draft");
  input.variants = Array.from({ length: 10 }, (_, index) => ({ ...input.variants[0], label: `${(index + 1) * 12.5} mg`, sku: `TEN-DRAFT-${index + 1}`,
    imageUrl: `https://example.invalid/ten-${index + 1}.png`, composition: { totalMassMg: (index + 1) * 12.5,
      components: [{ name: "3G - TRIPLE G", massMg: (index + 1) * 10 }, { name: "Cagrilintide", massMg: (index + 1) * 2.5 }] } }));
  const created = await create(input), result = await read(input.shopProductId);
  assert.equal(created.articleIds.length, 10); assert.equal(new Set(created.articleIds).size, 10);
  assert.equal(result.master?.stock, 0); assert(result.articles.every((a: any) => a.stock === 0 && a.shopVisible === 0 && a.publishedAt === null));
  assert.deepEqual(result.variants.map((v: any) => v.composition), input.variants.map(v => v.composition));
  assert.deepEqual(result.variants.map((v: any) => v.imageUrl), input.variants.map(v => v.imageUrl));
});

test("same UUID exact and canonical-key-order replay returns identical IDs without any added or changed row", async () => {
  const input = payload(), created = await create(input), stable = await snapshot();
  assert.deepEqual(await create(input), created); assert.deepEqual(await snapshot(), stable);
  const reordered: Record<string, unknown> = Object.fromEntries(Object.entries(input).reverse());
  reordered.description = Object.fromEntries(Object.entries(input.description).reverse());
  assert.deepEqual(await create(reordered), created); assert.deepEqual(await snapshot(), stable);
});

test("three concurrent identical UUID requests commit one draft and one audit only", async () => {
  const input = payload(), results = await Promise.all([create(input), create(input), create(input)]);
  assert.deepEqual(results[1], results[0]); assert.deepEqual(results[2], results[0]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM articles WHERE shop_product_id=$1", [input.shopProductId])).rows[0].n, 2);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM product_audit_log WHERE field_name=$1", [`request:${input.requestKey}`])).rows[0].n, 1);
});

test("same UUID changed social, composition or identity conflicts without mutation", async () => {
  const input = payload(); await create(input); const stable = await snapshot();
  const changedComposition = clone(input); changedComposition.variants[0].composition.components[0].name = "Different compound";
  for (const changed of [{ ...input, badge: "changed" }, { ...input, social: { ...input.social, launch: "changed" } }, changedComposition,
    { ...payload("different-draft"), requestKey: input.requestKey }]) {
    await assert.rejects(create(changed), conflict); assert.deepEqual(await snapshot(), stable);
  }
});

test("existing slug, SKU and independent SEO collisions reject without overwriting protected products", async () => {
  const stable = await snapshot();
  await assert.rejects(create(payload("nexus-iv")), conflict);
  const sku = payload("local-sku-collision"); sku.variants[1].sku = "SOMATIDE-15MG";
  await assert.rejects(create(sku), conflict); assert.deepEqual(await snapshot(), stable);
  await pool.query("INSERT INTO article_seo(article_id,slug,seo_title) VALUES(1,'local-seo-only','Protected extra SEO')");
  const withSeo = await snapshot(); await assert.rejects(create(payload("local-seo-only")), conflict); assert.deepEqual(await snapshot(), withSeo);
  await pool.query("DELETE FROM article_seo WHERE slug='local-seo-only'");
});

test("case-insensitive stored SKU, article slug and SEO slug collisions are rejected", async () => {
  for (const scope of ["sku", "article", "seo"]) {
    await pool.query("INSERT INTO articles(sku,name,shop_product_id,stock,shop_visible) VALUES($1,'Case sentinel',$2,0,0)",
      [scope === "sku" ? "CaSe-CoLlIsIoN" : `CASE-${scope}`, scope === "article" ? "LoCaL-CaSe-Draft" : `case-${scope}`]);
    if (scope === "seo") await pool.query("INSERT INTO article_seo(article_id,slug) VALUES(4,'LoCaL-CaSe-Draft')");
    const input = payload("local-case-draft"); if (scope === "sku") input.variants[0].sku = "case-collision";
    const stable = await snapshot(); await assert.rejects(create(input), conflict); assert.deepEqual(await snapshot(), stable);
    await seedFixture();
  }
});

test("new UUID duplicate draft slug conflicts without added rows", async () => {
  const input = payload(); await create(input); const stable = await snapshot();
  await assert.rejects(create({ ...input, requestKey: randomUUID() }), conflict); assert.deepEqual(await snapshot(), stable);
});

test("concurrent same slug and overlapping case-insensitive SKUs permit one success and one conflict", async () => {
  const first = payload(), sameSlug = { ...clone(first), requestKey: randomUUID() };
  const same = await Promise.allSettled([create(first), create(sameSlug)]);
  assert.equal(same.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(same.filter(r => r.status === "rejected" && conflict(r.reason)).length, 1);
  const x = payload("local-concurrent-a"), y = payload("local-concurrent-b");
  x.variants[0].sku = "SHARED-DRAFT-A"; x.variants[1].sku = "SHARED-DRAFT-B";
  y.variants[0].sku = "shared-draft-b"; y.variants[1].sku = "shared-draft-a";
  const overlap = await Promise.allSettled([create(x), create(y)]);
  assert.equal(overlap.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(overlap.filter(r => r.status === "rejected" && conflict(r.reason)).length, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM articles")).rows[0].n, 7);
});

test("audit failure rolls back all article and metadata rows; same UUID then succeeds", async () => {
  const stable = await snapshot(), input = payload();
  await failInsert("product_audit_log", async () => { await assert.rejects(create(input)); });
  assert.deepEqual(await snapshot(), stable); assert.equal((await create(input)).articleIds.length, 2);
});

test("each metadata/FAQ/link insertion failure atomically rolls back the complete draft", async () => {
  for (const table of ["articles", "article_seo", "article_merchant", "article_translations", "article_faq", "article_use_cases"]) {
    const stable = await snapshot();
    await failInsert(table, async () => { await assert.rejects(create(payload())); });
    assert.deepEqual(await snapshot(), stable);
  }
});

test("zero-stock draft succeeds even when every stock-history insert would fail", async () => {
  const old = await snapshot();
  await failInsert("stock_history", async () => { assert.equal((await create(payload())).articleIds.length, 2); });
  assert.deepEqual((await snapshot()).stock_history, old.stock_history);
});

test("legacy active FAQ without updated_at and minimal optional use-case columns preserve exact metadata and sentinels", async () => {
  await withSchemaChange("ALTER TABLE article_faq RENAME COLUMN is_visible TO active; ALTER TABLE article_faq DROP COLUMN updated_at; ALTER TABLE use_cases DROP COLUMN visible; ALTER TABLE use_cases DROP COLUMN image_url; ALTER TABLE article_use_cases DROP COLUMN sort_order; ALTER TABLE article_use_cases DROP COLUMN is_primary", async () => {
    const input = payload(); input.faqs[0].question = "Forschungsfrage 'active; DROP TABLE article_faq' ?";
    const old = await snapshot(), created = await create(input), result = await read(input.shopProductId);
    assert.equal(result.productSchemaStatus.faqLayout, "legacy-active"); assert.deepEqual(result.productSchemaStatus.missingRequiredFields, []);
    assert.deepEqual(result.faqs.map((f: any) => ({ lang: f.lang, question: f.question, answer: f.answer })), input.faqs);
    assert(result.faqs.every((f: any) => f.articleId === created.masterArticleId && f.isVisible === 1 && f.updatedAt === null && f.createdAt instanceof Date));
    assert.deepEqual(result.useCases.map((u: any) => [u.articleId, u.slug]), [[created.masterArticleId, "metabolic-research"]]);
    assert(!Object.hasOwn(result.useCases[0], "sortOrder")); assert(!Object.hasOwn(result.useCases[0], "isPrimary"));
    const rawFaq = (await pool.query("SELECT * FROM article_faq WHERE article_id=$1 AND active=1 ORDER BY sort_order,id", [created.masterArticleId])).rows;
    assert.equal(rawFaq.length, 6); assert.deepEqual(rawFaq.map(f => [f.question, f.answer]), input.faqs.map(f => [f.question, f.answer]));
    assert.deepEqual(result.social, input.social); assert.deepEqual(protectedRows(await snapshot()), protectedRows(old));
    const stable = await snapshot(); assert.deepEqual(await create(input), created); assert.deepEqual(await snapshot(), stable);
  });
});

test("legacy FAQ audit failure rolls back exact fixture and leaves no idempotency tombstone", async () => {
  await withSchemaChange("ALTER TABLE article_faq RENAME COLUMN is_visible TO active; ALTER TABLE article_faq DROP COLUMN updated_at", async () => {
    const stable = await snapshot(), input = payload();
    await failInsert("product_audit_log", async () => { await assert.rejects(create(input)); });
    assert.deepEqual(await snapshot(), stable); assert.equal((await create(input)).articleIds.length, 2);
  });
});

test("strict unsafe/published/nonzero/composition and bounded input matrix rejects before any insert", async () => {
  const input = payload(), stable = await snapshot(), priorSequence = await sequence();
  const bad: unknown[] = [
    { ...input, requestKey: "not-a-uuid" }, { ...input, shopProductId: "somatide", seo: { ...input.seo, canonical: "https://www.369research.eu/product/somatide" } },
    { ...input, shopProductId: "../escape" }, { ...input, shopProductId: "UPPERCASE" }, { ...input, mystery: true },
    { ...input, publish: true }, { ...input, shopVisible: 1 }, { ...input, publishedAt: new Date() }, { ...input, saleActive: true },
    { ...input, casNumber: 123 }, { ...input, molecularWeight: 123 }, { ...input, purity: false },
    { ...input, variants: [] }, { ...input, variants: Array.from({ length: 11 }, () => input.variants[0]) },
    { ...input, variants: input.variants.map(v => ({ ...v, sku: "DUPLICATE" })) },
    { ...input, variants: [{ ...input.variants[0], sku: "DuPlicate" }, { ...input.variants[1], sku: "duplicate" }] },
    { ...input, variants: [{ ...input.variants[0], label: "25.0 mg" }, input.variants[1]] },
    ...[{ price: 0 }, { price: 65 }, { stock: 1 }, { stock: -1 }, { stock: 0.5 }, { imageUrl: "http://example.invalid/a.png" },
      { imageUrl: "https://secret:password@example.invalid/a.png" }, { publish: true }].map(change => ({ ...input, variants: [{ ...input.variants[0], ...change }, input.variants[1]] })),
    ...[{ totalMassMg: 13 }, { totalMassMg: Infinity }, { totalMassMg: -1 }, { unknown: true },
      { components: [] },
      { components: [{ name: "duplicate", massMg: 10 }, { name: "duplicate", massMg: 2.5 }] },
      { components: [{ name: "3G - TRIPLE G", massMg: 0 }, { name: "Cagrilintide", massMg: 12.5 }] }].map(change => ({ ...input,
      variants: [{ ...input.variants[0], composition: { ...input.variants[0].composition, ...change } }, input.variants[1]] })),
    { ...input, description: {} }, { ...input, description: { ...input.description, risiko: "Kein Research-Hinweis" } },
    { ...input, description: { ...input.description, kurztext: "x".repeat(50001) } },
    { ...input, description: { ...input.description, properties: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } } } },
    { ...input, seo: { ...input.seo, seoTitle: "x".repeat(61) } }, { ...input, seo: { ...input.seo, seoDescription: "x".repeat(156) } },
    { ...input, seo: { ...input.seo, canonical: "https://www.369research.eu.evil.invalid/product/local-nexus-v" } },
    { ...input, seo: { ...input.seo, canonical: "https://www.369research.eu/product/wrong-slug" } },
    { ...input, merchant: { ...input.merchant, brand: "" } }, { ...input, merchant: { ...input.merchant, googleProductCategory: 491 } },
    { ...input, faqs: input.faqs.slice(0, 3) }, { ...input, faqs: [...input.faqs, input.faqs[0]] },
    { ...input, faqs: input.faqs.map(f => ({ ...f, lang: "en" })) }, { ...input, social: { ...input.social, draftMeta: { isDraft: false } } },
  ];
  for (const [index, candidate] of bad.entries()) {
    assert.equal(service.createProductDraftInput.safeParse(candidate).success, false, `invalid matrix entry ${index}`);
    await assert.rejects(create(candidate)); assert.deepEqual(await snapshot(), stable); assert.deepEqual(await sequence(), priorSequence);
  }
});

test("unknown use case fails without creating global records or any article", async () => {
  const input = payload(); input.useCaseSlugs = ["not-existing"];
  const stable = await snapshot(), priorSequence = await sequence();
  await assert.rejects(create(input)); assert.deepEqual(await snapshot(), stable); assert.deepEqual(await sequence(), priorSequence);
});

test("draft service exposes no publication operation and all created articles remain hidden after reads/replays", async () => {
  assert(!Object.keys(service).some(key => /publish/i.test(key)), "draft-only module must not expose a publish operation");
  const input = payload(), created = await create(input), stable = await snapshot();
  await read(input.shopProductId); assert.deepEqual(await create(input), created); assert.deepEqual(await snapshot(), stable);
  assert((await pool.query("SELECT shop_visible,published_at,stock FROM articles WHERE id=ANY($1::int[])", [created.articleIds])).rows.every(row => row.shop_visible === 0 && row.published_at === null && row.stock === 0));
});

test("real createDraft/getDraft endpoints deny missing/basic principals and accept product_manager", async () => {
  const input = payload(), stable = await snapshot();
  for (const principal of [null, undefined, ...["user", "customer", "packing"].map(role => ({ ...manager, role }))]) {
    // undefined intentionally creates a context without a user field.
    const c = principal === undefined ? app.createCaller({ req: { headers: {} }, res: {} }) : caller(principal);
    await assert.rejects(c.productAdmin.createDraft(input), (e: any) => ["UNAUTHORIZED", "FORBIDDEN"].includes(e.code));
    await assert.rejects(c.productAdmin.getDraft({ shopProductId: input.shopProductId }), (e: any) => ["UNAUTHORIZED", "FORBIDDEN"].includes(e.code));
    assert.deepEqual(await snapshot(), stable);
  }
  const created = await caller().productAdmin.createDraft(input);
  assert.equal(created.success, true); assert.equal(created.shopVisible, false);
  const result = await caller().productAdmin.getDraft({ shopProductId: input.shopProductId });
  assert.deepEqual(result.articleIds, created.articleIds); assert.deepEqual(result.social, input.social);
  assert(result.articles.every((a: any) => a.shopVisible === 0 && a.stock === 0 && a.publishedAt === null));
});

test("active WaWi list retains each marked draft master while shop list excludes all draft SKUs", async () => {
  const priorList = await caller().article.list({ onlyActive: true });
  const multi = payload("local-visible-wawi-multi"), single = payload("local-visible-wawi-single");
  single.variants = single.variants.slice(0, 1);
  const a = await caller().productAdmin.createDraft(multi), b = await caller().productAdmin.createDraft(single);
  const stable = await snapshot();
  const activeList = await caller().article.list({ onlyActive: true });
  assert(activeList.some((row: any) => row.id === a.masterArticleId));
  assert(activeList.some((row: any) => row.id === b.masterArticleId));
  assert(!activeList.some((row: any) => row.id === a.articleIds[1]));
  assert.deepEqual(activeList.filter((row: any) => ![...a.articleIds, ...b.articleIds].includes(row.id)), priorList);
  const shop = JSON.stringify(await caller(null).article.shopProducts());
  for (const v of [...multi.variants, ...single.variants]) assert(!shop.includes(v.sku));
  assert.deepEqual(await snapshot(), stable);
});

test("both real visibility toggles block every marked draft and permit hide-only without stock changes", async () => {
  const input = payload(), created = await caller().productAdmin.createDraft(input);
  const stable = await snapshot();
  for (const id of created.articleIds) {
    await assert.rejects(caller().article.toggleShopVisible({ id, visible: true }), (e: any) => /Produktentwurf|Preis.*Freigabe/i.test(e.message));
    assert.deepEqual(await snapshot(), stable);
  }
  await assert.rejects(caller().productAdmin.toggleShopVisible({ shopProductId: input.shopProductId, visible: true }), (e: any) => /Produktentwurf|Preis.*Freigabe/i.test(e.message));
  assert.deepEqual(await snapshot(), stable);
  for (const id of created.articleIds) assert.equal((await caller().article.toggleShopVisible({ id, visible: false })).success, true);
  assert.equal((await caller().productAdmin.toggleShopVisible({ shopProductId: input.shopProductId, visible: false })).success, true);
  const hidden = await snapshot();
  assert.deepEqual(hidden.articles, stable.articles); assert.deepEqual(hidden.stock_history, stable.stock_history);
  assert(hidden.articles.filter(a => created.articleIds.includes(a.id)).every(a => a.shop_visible === 0 && a.published_at === null));
});

test("legacy unmarked published products retain ordinary hide/show toggle behavior", async () => {
  // This test explicitly exercises legacy mutability, then restores its OWN
  // fixture before afterEach's protected-sentinel assertion; no real catalog.
  const stable = await snapshot();
  try {
    assert.equal((await caller().article.toggleShopVisible({ id: 1, visible: false })).success, true);
    assert.equal((await pool.query("SELECT shop_visible FROM articles WHERE id=1")).rows[0].shop_visible, 0);
    assert.equal((await caller().article.toggleShopVisible({ id: 1, visible: true })).success, true);
    assert.equal((await pool.query("SELECT shop_visible FROM articles WHERE id=1")).rows[0].shop_visible, 1);
    assert.equal((await caller().article.toggleShopVisible({ id: 2, visible: false })).success, true);
    assert.equal((await pool.query("SELECT shop_visible FROM articles WHERE id=2")).rows[0].shop_visible, 0);
    assert.equal((await caller().article.toggleShopVisible({ id: 2, visible: true })).success, true);
    assert.equal((await pool.query("SELECT shop_visible FROM articles WHERE id=2")).rows[0].shop_visible, 1);
    assert.equal((await caller().productAdmin.toggleShopVisible({ shopProductId: "somatide", visible: false })).success, true);
    assert.equal((await pool.query("SELECT shop_visible FROM articles WHERE id=1")).rows[0].shop_visible, 0);
    assert.equal((await caller().productAdmin.toggleShopVisible({ shopProductId: "somatide", visible: true })).success, true);
    assert.equal((await pool.query("SELECT shop_visible FROM articles WHERE id=1")).rows[0].shop_visible, 1);
    const toggled = await snapshot(); assert.deepEqual(toggled.articles, stable.articles); assert.deepEqual(toggled.stock_history, stable.stock_history);
  } finally { await seedFixture(); }
});

test("readProductDraft opens a repeatable-read database-enforced read-only transaction", async () => {
  const input = payload(); await create(input); const stable = await snapshot(), start = observedStatements.length;
  await read(input.shopProductId);
  const statements = observedStatements.slice(start);
  assert(statements.some(sql => /^begin\b/i.test(sql) && /repeatable read/i.test(sql) && /read only/i.test(sql)));
  assert(statements.some(sql => /^commit\b/i.test(sql)));
  assert(!statements.some(sql => /^\s*(?:insert|update|delete|alter|create|drop|truncate)\b/i.test(sql)));
  assert.deepEqual(await snapshot(), stable);
});

test("legacy NOT NULL price storage uses documented technical zero but API remains open/null and unpublished", async () => {
  await withSchemaChange("ALTER TABLE articles ALTER COLUMN selling_price SET NOT NULL", async () => {
    const input = payload(), old = await snapshot(), created = await create(input), result = await read(input.shopProductId);
    assert.equal(created.priceStatus, "open"); assert.equal(created.publicationReady, false);
    assert(result.articles.every(a => a.sellingPrice === "0.00" && a.shopVisible === 0 && a.publishedAt === null && a.stock === 0));
    assert(result.variants.every(v => v.price === null && v.priceStatus === "open"));
    assert.equal((result.master.description as any).draftMeta.sellingPriceStorage, "technical-zero");
    assert.equal((result.master.description as any).draftMeta.isDraft, true);
    assert.deepEqual((await snapshot()).stock_history, old.stock_history);
    const stable = await snapshot(); assert.deepEqual(await create(input), created); assert.deepEqual(await snapshot(), stable);
    await assert.rejects(caller().article.toggleShopVisible({ id: created.masterArticleId, visible: true }));
    await assert.rejects(caller().productAdmin.toggleShopVisible({ shopProductId: input.shopProductId, visible: true }));
    assert.deepEqual(await snapshot(), stable);
  });
});

test("draft and positive legacy createFamily serialize arbitrary mixed-case SKU aliases with one winner", async () => {
  const { createProductFamily, createFamilyInput } = await import("./productFamily.js");
  const draft = payload("local-race-draft"); draft.variants[0].sku = "ShArEd-CrOsS-RoUtE";
  const p = payload("local-race-family");
  const legacy = createFamilyInput.parse({
    requestKey: p.requestKey, shopProductId: p.shopProductId, name: "Eloralintide", category: "Vials",
    categories: ["Metabolisch & Körperkomposition"], shortDescription: "99 % Reinheit garantiert. Research Use Only. Not for human use.",
    badge: "Amylinrezeptor-Forschung", casNumber: "2883634-40-8", molecularWeight: "ca. 4526,1 g/mol (Referenzwert)", purity: "99% garantiert",
    description: { kurztext: "Modifiziertes Amylinanalogon für Laborforschung.", wirkung: "AMY1-Rezeptor und cAMP-Signalwege in Zellassays.",
      highlights: ["99 % Reinheit garantiert", "5 mg oder 10 mg"], eigenschaften: { reinheit: "99 % Reinheit garantiert" },
      fazit: "Gezielter Forschungsbaustein.", risiko: "Research Use Only. Not for human use.", quellen: ["https://example.invalid/research"] },
    variants: [{ label: "5 mg", sku: "sHaReD-cRoSs-rOuTe", price: 64, stock: 9, imageUrl: "https://example.invalid/legacy-5.png" },
      { label: "10 mg", sku: "LEGACY-RACE-10MG", price: 115, stock: 9, imageUrl: "https://example.invalid/legacy-10.png" }],
    seo: { ...p.seo, seoTitle: "Eloralintide 5 mg & 10 mg | 369 Research", seoDescription: "Amylinrezeptor-Forschung. 99 % Reinheit garantiert. Research Use Only.",
      imageAlt: "Eloralintide Research-Vials 5 mg und 10 mg" },
    merchant: { ...p.merchant, merchantTitle: "Eloralintide Research-Vial", merchantDescription: "99 % Reinheit garantiert. Research Use Only. Not for human use.", googleProductCategory: "491" },
    faqs: p.faqs, useCaseSlugs: ["metabolic-research"], translations: [],
  });
  const old = await snapshot();
  try {
    const results = await Promise.allSettled([create(draft), createProductFamily(db, legacy, actor)]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(results.filter(r => r.status === "rejected" && conflict(r.reason)).length, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM articles WHERE lower(sku)='shared-cross-route'")).rows[0].n, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM articles")).rows[0].n, 5);
    const now = await snapshot();
    for (const table of productTables) {
      const existing = (rows: any[]) => table === "use_cases" ? rows : rows.filter(row => table === "articles" ? row.id <= 3 : row.article_id <= 3);
      assert.deepEqual(existing(now[table]), existing(old[table]));
    }
  } finally { await seedFixture(); }
});
