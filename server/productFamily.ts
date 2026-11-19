import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { articles, articleSeo, articleMerchant, articleTranslations, articleFaq,
  articleUseCases, useCases, productAuditLog } from "../drizzle/schema.js";
import { getDb } from "./db.js";
import { applyStockMovement } from "./stockMovementService.js";
import { validateProductData } from "./productValidation.js";
import { requiresResearchOnlyValidation } from "./productValidationPolicy.js";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type ProductDb = Db | Tx;
const text = (max: number) => z.string().trim().min(1).max(max);
const slug = text(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const lang = text(5).regex(/^[a-z]{2}(?:-[a-z]{2})?$/);
const httpsUrl = text(2000).url().refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password;
}, "HTTPS URL ohne Zugangsdaten erforderlich");
const mgLabel = text(30).regex(/^(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*) ?mg$/, "Exakte positive mg-Angabe erforderlich");
const money = z.number().finite().positive().max(99999999.99).refine(
  value => Math.abs(value * 100 - Math.round(value * 100)) < 0.000001,
  "Preis darf höchstens zwei Nachkommastellen haben");
const stock = z.number().int().min(0).max(2147483647);

// Bounded, real JSON object: no arbitrary nested write keys or non-JSON values.
const description = z.record(z.unknown()).superRefine((value, ctx) => {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const entry = pending.pop()!;
    if (++count > 2000 || entry.depth > 6) {
      ctx.addIssue({ code: "custom", message: "Beschreibung zu groß/tief" }); return;
    }
    const v = entry.value;
    if (v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) continue;
    if (typeof v !== "object" || (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype)) {
      ctx.addIssue({ code: "custom", message: "Beschreibung muss JSON enthalten" }); return;
    }
    pending.push(...Object.values(v).map(child => ({ value: child, depth: entry.depth + 1 })));
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 50000)
    ctx.addIssue({ code: "custom", message: "Beschreibung maximal 50 KB" });
  for (const key of ["kurztext", "wirkung", "fazit", "risiko"]) {
    if (typeof value[key] !== "string" || !(value[key] as string).trim())
      ctx.addIssue({ code: "custom", message: `Beschreibung: ${key} fehlt` });
  }
});
const seoSchema = z.object({ seoTitle: text(60), seoDescription: text(155),
  canonical: httpsUrl, imageAlt: text(200), ogImage: httpsUrl }).strict();
const merchantSchema = z.object({ merchantTitle: text(150), merchantDescription: text(5000),
  brand: text(100), googleProductCategory: text(10), productType: text(200) }).strict();
const faqSchema = z.object({ lang, question: text(1000), answer: text(5000) }).strict();
const translationSchema = z.object({ lang, name: text(200), shortDescription: text(2000),
  description, merchantTitle: text(150), merchantDescription: text(5000) }).strict();
const variantSchema = z.object({ label: mgLabel, sku: text(50), price: money, stock, imageUrl: httpsUrl }).strict();

export const createFamilyInput = z.object({
  requestKey: z.string().uuid().transform(value => value.toLowerCase()),
  shopProductId: slug, name: text(160), category: text(100),
  categories: z.array(text(100)).min(1).max(20), shortDescription: text(2000),
  badge: text(100), casNumber: text(50), molecularWeight: text(50), purity: text(20), description,
  variants: z.array(variantSchema).min(2).max(10), seo: seoSchema, merchant: merchantSchema,
  faqs: z.array(faqSchema).min(4).max(6), useCaseSlugs: z.array(slug).max(20).default([]),
  translations: z.array(translationSchema).max(10).default([]),
}).strict().superRefine((input, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  if (input.seo.canonical !== canonicalFor(input.shopProductId)) issue("Canonical muss exakt zur Familien-URL passen");
  if (new Set(input.variants.map(v => v.sku)).size !== input.variants.length) issue("Doppelte SKU im Payload");
  // 5mg and 5 mg (or 5.0 mg) must not represent two inventory variants.
  if (new Set(input.variants.map(v => Number(v.label.replace(/ ?mg$/, "")))).size !== input.variants.length) issue("Doppelte mg-Variante");
  if (input.variants.some(v => `${input.name} (${v.label})`.length > 200)) issue("Variantenname maximal 200 Zeichen");
  if (new Set(input.categories).size !== input.categories.length) issue("Doppelte Kategorie");
  if (new Set(input.useCaseSlugs).size !== input.useCaseSlugs.length) issue("Doppelter Use Case");
  if (new Set(input.translations.map(t => t.lang)).size !== input.translations.length) issue("Doppelte Übersetzungssprache");
  if (input.faqs.filter(f => f.lang === "de").length < 4) issue("Mindestens vier deutsche FAQs erforderlich");
  if (new Set(input.faqs.map(f => `${f.lang}:${f.question}`)).size !== input.faqs.length) issue("Doppelte FAQ");
  const de = input.translations.find(t => t.lang === "de");
  if (de && canonicalJson(de) !== canonicalJson(defaultDe(input))) issue("Optionale DE-Übersetzung muss den Basistexten entsprechen");
});
export const getFamilyInput = z.object({ shopProductId: slug }).strict();
export const publishFamilyInput = z.object({ shopProductId: slug, masterArticleId: z.number().int().positive(),
  requestKey: z.string().uuid().transform(value => value.toLowerCase()) }).strict();
export type CreateFamilyInput = z.infer<typeof createFamilyInput>;
export type PublishFamilyInput = z.infer<typeof publishFamilyInput>;

function canonicalFor(shopProductId: string) { return `https://www.369research.eu/product/${shopProductId}`; }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function defaultDe(input: CreateFamilyInput) {
  return { lang: "de", name: input.name, shortDescription: input.shortDescription, description: input.description,
    merchantTitle: input.merchant.merchantTitle, merchantDescription: input.merchant.merchantDescription };
}
function fail(message: string, code: "BAD_REQUEST" | "CONFLICT" | "NOT_FOUND" = "BAD_REQUEST"): never {
  throw new TRPCError({ code, message });
}
function assertParsed<T>(schema: z.ZodType<T, any, any>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail(`${label}: ${parsed.error.issues.map(i => i.message).join("; ")}`);
  return parsed.data;
}
async function lock(tx: Tx, key: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`product-family:${key}`}, 0))`);
}
async function replay<T>(tx: Tx, requestKey: string, action: string, input: unknown): Promise<{ fingerprint: string; response?: T }> {
  const fingerprint = createHash("sha256").update(canonicalJson({ action, input })).digest("hex");
  const prior = await tx.select().from(productAuditLog).where(eq(productAuditLog.fieldName, `request:${requestKey}`)).orderBy(asc(productAuditLog.id));
  if (!prior.length) return { fingerprint };
  if (prior.length !== 1) fail("Request-Audit mehrdeutig", "CONFLICT");
  let stored: { fingerprint?: string; response?: T };
  try { stored = JSON.parse(prior[0].newValue ?? "null"); } catch { fail("Request-Audit ungültig", "CONFLICT"); }
  if (!stored || prior[0].action !== action || stored.fingerprint !== fingerprint || !stored.response)
    fail("requestKey bereits mit anderem Payload verwendet", "CONFLICT");
  return { fingerprint, response: stored.response };
}
async function audit(tx: Tx, articleId: number, action: string, requestKey: string, fingerprint: string,
  response: unknown, actor: string, details: unknown, oldValue?: unknown) {
  // Mandatory audit INSIDE the same transaction. Never use the legacy swallowing helper.
  await tx.insert(productAuditLog).values({ articleId, action, fieldName: `request:${requestKey}`,
    changedBy: actor.slice(0, 100), oldValue: oldValue === undefined ? null : JSON.stringify(oldValue),
    newValue: JSON.stringify({ fingerprint, response, details }) });
}

export async function readFamily(db: ProductDb, shopProductId: string, forUpdate = false) {
  const query = db.select().from(articles).where(eq(articles.shopProductId, shopProductId)).orderBy(asc(articles.id));
  const family = await (forUpdate ? query.for("update") : query);
  const availableUseCases = await db.select({ id: useCases.id, slug: useCases.slug, visible: useCases.visible })
    .from(useCases).orderBy(asc(useCases.slug));
  if (!family.length) return { shopProductId, masterArticleId: null, master: null, articles: [], variants: [],
    seo: null, merchant: null, translations: [], faqs: [], useCases: [], availableUseCases, validation: null };
  const masters = family.filter(a => Array.isArray(a.variants) && a.variants.length > 0);
  if (masters.length !== 1) fail("Familie benötigt genau einen eindeutigen Master mit Varianten", "CONFLICT");
  const master = masters[0];
  const ids = family.map(a => a.id);
  const seo = await db.select().from(articleSeo).where(inArray(articleSeo.articleId, ids)).orderBy(asc(articleSeo.id));
  const merchant = await db.select().from(articleMerchant).where(inArray(articleMerchant.articleId, ids)).orderBy(asc(articleMerchant.id));
  const translations = await db.select().from(articleTranslations).where(inArray(articleTranslations.articleId, ids)).orderBy(asc(articleTranslations.lang), asc(articleTranslations.id));
  const faqs = await db.select().from(articleFaq).where(inArray(articleFaq.articleId, ids)).orderBy(asc(articleFaq.sortOrder), asc(articleFaq.id));
  const links = await db.select({ id: articleUseCases.id, articleId: articleUseCases.articleId,
    useCaseId: articleUseCases.useCaseId, slug: useCases.slug, sortOrder: articleUseCases.sortOrder, isPrimary: articleUseCases.isPrimary })
    .from(articleUseCases).innerJoin(useCases, eq(articleUseCases.useCaseId, useCases.id))
    .where(inArray(articleUseCases.articleId, ids)).orderBy(asc(useCases.slug), asc(articleUseCases.id));
  if (seo.length !== 1 || merchant.length !== 1 || [...seo, ...merchant, ...translations, ...faqs, ...links].some(r => r.articleId !== master.id)
    || new Set(translations.map(t => t.lang)).size !== translations.length)
    fail("Familien-Metadaten fehlen, sind mehrdeutig oder liegen auf einem Kindartikel", "CONFLICT");
  const de = translations.find(t => t.lang === "de");
  return { shopProductId, masterArticleId: master.id, master, articles: family,
    variants: master.variants as unknown[], seo: seo[0], merchant: merchant[0], translations, faqs,
    useCases: links, availableUseCases, validation: validateProductData(master, seo[0], merchant[0], de) };
}

// Shared exact-master validation for creation and publication; no LIMIT 1 or fallback.
function validateFamily(family: Awaited<ReturnType<typeof readFamily>>) {
  const master = family.master;
  if (!master || !family.seo || !family.merchant || !family.validation) fail("Familie nicht gefunden", "NOT_FOUND");
  const rows = family.articles;
  if (rows.length < 2 || rows.length > 10 || family.variants.length !== rows.length) fail("Variantenanzahl oder Lagerzuordnung ungültig");
  if (master.shopVisible !== 0 && master.shopVisible !== 1) fail("Master-Sichtbarkeit ungültig");
  if (rows.some(a => a.isActive !== 1 || (a.id !== master.id && (a.shopVisible !== 0 || a.variants !== null))))
    fail("Kindartikel müssen aktiv, verborgen und ohne variants JSON sein");
  const ids = new Set<number>(), labels = new Set<number>();
  for (const raw of family.variants) {
    const v = assertParsed(z.object({ dosage: mgLabel, label: mgLabel, sku: text(50), price: money, stock,
      inventoryArticleId: z.number().int().positive(), image: httpsUrl, imageUrl: httpsUrl,
      images: z.array(httpsUrl).min(1).max(10) }).strict(), raw, "Variante");
    const row = rows.find(a => a.id === v.inventoryArticleId);
    const amount = Number(v.label.replace(/ ?mg$/, ""));
    if (!row || ids.has(row.id) || labels.has(amount) || row.shopProductId !== family.shopProductId
      || row.sku !== v.sku || Number(row.sellingPrice) !== v.price || row.stock !== v.stock || v.dosage !== v.label
      || !row.name.endsWith(` (${v.label})`) || row.mockupImageUrl !== v.image || v.imageUrl !== v.image
      || v.images[0] !== v.image || row.salePrice !== null) fail("Variante stimmt nicht exakt mit ihrer Lagerzeile überein");
    ids.add(row.id); labels.add(amount);
  }
  const first = family.variants[0] as { inventoryArticleId: number };
  if (first.inventoryArticleId !== master.id) fail("Erste Variante ist nicht der exakte Master");
  const seo = assertParsed(seoSchema, { seoTitle: family.seo.seoTitle, seoDescription: family.seo.seoDescription,
    canonical: family.seo.canonical, imageAlt: family.seo.imageAlt, ogImage: family.seo.ogImage }, "SEO");
  if (family.seo.slug !== family.shopProductId || seo.canonical !== canonicalFor(family.shopProductId)
    || family.seo.faqEnabled !== 1 || family.seo.schemaEnabled !== 1) fail("SEO-Slug/Canonical/FAQ-Konfiguration ungültig");
  const merchant = assertParsed(merchantSchema, { merchantTitle: family.merchant.merchantTitle,
    merchantDescription: family.merchant.merchantDescription, brand: family.merchant.brand,
    googleProductCategory: family.merchant.googleProductCategory, productType: family.merchant.productType }, "Merchant");
  const de = family.translations.find(t => t.lang === "de");
  if (!de || de.merchantTitle !== merchant.merchantTitle || de.merchantDescription !== merchant.merchantDescription
    || !de.name || de.shortDescription !== master.shortDescription || canonicalJson(de.description) !== canonicalJson(master.description)
    || de.seoTitle !== seo.seoTitle || de.seoDescription !== seo.seoDescription || de.imageAlt !== seo.imageAlt)
    fail("Deutsche Übersetzung fehlt oder widerspricht Master/SEO/Merchant");
  assertParsed(description, master.description, "Beschreibung");
  assertParsed(text(2000), master.shortDescription, "Kurzbeschreibung");
  assertParsed(text(20), master.purity, "Reinheit");
  assertParsed(text(50), master.casNumber, "CAS");
  assertParsed(text(50), master.molecularWeight, "Molekulargewicht");
  assertParsed(z.array(text(100)).min(1).max(20), master.categories, "Kategorien");
  assertParsed(text(100), master.category, "Kategorie");
  const faq = family.faqs.map(f => assertParsed(faqSchema, { lang: f.lang, question: f.question, answer: f.answer }, "FAQ"));
  if (faq.length < 4 || faq.length > 6 || faq.filter(f => f.lang === "de").length < 4
    || family.faqs.some(f => f.isVisible !== 1) || new Set(faq.map(f => `${f.lang}:${f.question}`)).size !== faq.length)
    fail("Vier bis sechs eindeutige sichtbare FAQs erforderlich (mindestens vier DE)");
  if (new Set(family.useCases.map(u => u.useCaseId)).size !== family.useCases.length) fail("Doppelte Use-Case-Verknüpfung");
  if (!family.validation.isValid || family.validation.warnings.length > 0)
    fail(`Produktvalidierung fehlgeschlagen: ${[...family.validation.issues, ...family.validation.warnings].join("; ")}`);
  if (requiresResearchOnlyValidation(master) && !family.validation.hasResearchNote) fail("Research Use Only Hinweis erforderlich");
  return family.validation;
}

export async function createProductFamily(db: Db, input: CreateFamilyInput, actor: string) {
  // First variant owns the canonical source; its stock is never a family sum.
  return db.transaction(async tx => {
    await lock(tx, `request:${input.requestKey}`);
    await lock(tx, `family:${input.shopProductId}`);
    for (const sku of input.variants.map(v => v.sku).sort()) await lock(tx, `sku:${sku}`);
    const prior = await replay<CreateResponse>(tx, input.requestKey, "CREATE_FAMILY", input);
    if (prior.response) return prior.response;
    if ((await tx.select({ id: articles.id }).from(articles).where(eq(articles.shopProductId, input.shopProductId))).length)
      fail("Produktfamilie existiert bereits", "CONFLICT");
    if ((await tx.select({ id: articles.id }).from(articles).where(inArray(articles.sku, input.variants.map(v => v.sku)))).length)
      fail("SKU existiert bereits", "CONFLICT");
    if ((await tx.select({ id: articleSeo.id }).from(articleSeo).where(eq(articleSeo.slug, input.shopProductId))).length)
      fail("SEO-Slug existiert bereits", "CONFLICT");
    const selectedUseCases = input.useCaseSlugs.length ? await tx.select().from(useCases).where(inArray(useCases.slug, input.useCaseSlugs)) : [];
    if (selectedUseCases.length !== input.useCaseSlugs.length) fail("Use-Case-Slug existiert nicht");
    const articleIds: number[] = [];
    const variants: FamilyVariant[] = [];
    for (const v of input.variants) {
      const [a] = await tx.insert(articles).values({ name: `${input.name} (${v.label})`, sku: v.sku,
        shopProductId: input.shopProductId, category: input.category, categories: input.categories,
        shortDescription: input.shortDescription, badge: input.badge, casNumber: input.casNumber,
        molecularWeight: input.molecularWeight, purity: input.purity, description: input.description,
        sellingPrice: v.price.toFixed(2), salePrice: null, stock: 0, isActive: 1, shopVisible: 0,
        mockupImageUrl: v.imageUrl, labelImageUrl: v.imageUrl, galleryImages: [v.imageUrl], variants: null,
      }).returning();
      const movement = await applyStockMovement(tx, { articleId: a.id, sku: a.sku, expectedStock: 0,
        change: v.stock, type: "wareneingang", reason: "Produktanlage", actor: actor.slice(0, 100) });
      articleIds.push(a.id);
      variants.push({ dosage: v.label, label: v.label, sku: a.sku, price: Number(a.sellingPrice), stock: movement.after,
        inventoryArticleId: a.id, image: v.imageUrl, imageUrl: v.imageUrl, images: [v.imageUrl] });
    }
    const masterArticleId = articleIds[0];
    await tx.update(articles).set({ variants, galleryImages: input.variants.map(v => v.imageUrl) }).where(eq(articles.id, masterArticleId));
    await tx.insert(articleSeo).values({ articleId: masterArticleId, slug: input.shopProductId,
      ...input.seo, faqEnabled: 1, schemaEnabled: 1 });
    await tx.insert(articleMerchant).values({ articleId: masterArticleId, ...input.merchant,
      availability: variants.some(v => v.stock > 0) ? "in_stock" : "out_of_stock", condition: "new" });
    await tx.insert(articleTranslations).values({ articleId: masterArticleId, ...defaultDe(input),
      seoTitle: input.seo.seoTitle, seoDescription: input.seo.seoDescription, imageAlt: input.seo.imageAlt });
    for (const t of input.translations.filter(t => t.lang !== "de"))
      await tx.insert(articleTranslations).values({ articleId: masterArticleId, ...t });
    await tx.insert(articleFaq).values(input.faqs.map((f, index) => ({ articleId: masterArticleId, ...f, sortOrder: index + 1, isVisible: 1 })));
    for (const u of selectedUseCases.sort((a, b) => a.slug.localeCompare(b.slug)))
      await tx.insert(articleUseCases).values({ articleId: masterArticleId, useCaseId: u.id });
    const created = await readFamily(tx, input.shopProductId);
    if (created.articles.some(a => a.shopVisible !== 0 || a.publishedAt !== null)) fail("Neuanlage muss vollständig verborgen sein");
    const validation = validateFamily(created);
    const response: CreateResponse = { success: true, shopProductId: input.shopProductId, masterArticleId, articleIds, variants, shopVisible: false };
    await audit(tx, masterArticleId, "CREATE_FAMILY", input.requestKey, prior.fingerprint, response, actor,
      { articleIds, validation, initialStock: variants.map(v => ({ articleId: v.inventoryArticleId, stock: v.stock, reason: "Produktanlage" })) });
    return response;
  });
}

type FamilyVariant = { dosage: string; label: string; sku: string; price: number; stock: number;
  inventoryArticleId: number; image: string; imageUrl: string; images: string[] };
type CreateResponse = { success: true; shopProductId: string; masterArticleId: number; articleIds: number[];
  variants: FamilyVariant[]; shopVisible: false };
type PublishResponse = { success: true; shopProductId: string; masterArticleId: number; shopVisible: true };

export async function publishProductFamily(db: Db, input: PublishFamilyInput, actor: string) {
  return db.transaction(async tx => {
    await lock(tx, `request:${input.requestKey}`);
    await lock(tx, `family:${input.shopProductId}`);
    const prior = await replay<PublishResponse>(tx, input.requestKey, "PUBLISH_FAMILY", input);
    const family = await readFamily(tx, input.shopProductId, true);
    if (!family.master) fail("Produktfamilie nicht gefunden", "NOT_FOUND");
    if (family.masterArticleId !== input.masterArticleId) fail("masterArticleId gehört nicht zum exakten Familienmaster", "CONFLICT");
    const validation = validateFamily(family);
    if (prior.response) {
      if (family.master.shopVisible !== 1) fail("Veröffentlichter Replay-Zustand wurde verändert", "CONFLICT");
      return prior.response;
    }
    const response: PublishResponse = { success: true, shopProductId: input.shopProductId, masterArticleId: input.masterArticleId, shopVisible: true };
    if (family.master.shopVisible !== 0 && family.master.shopVisible !== 1) fail("Master-Sichtbarkeit ungültig");
    if (family.master.shopVisible === 0) {
      await tx.update(articles).set({ shopVisible: 1, publishedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(articles.id, input.masterArticleId), eq(articles.shopProductId, input.shopProductId)));
    }
    // A new request UUID is recorded even for a no-op; exact replays add no audit.
    await audit(tx, input.masterArticleId, "PUBLISH_FAMILY", input.requestKey, prior.fingerprint, response, actor,
      { validation, articleIds: family.articles.map(a => a.id) }, { shopVisible: family.master.shopVisible, publishedAt: family.master.publishedAt });
    return response;
  });
}
