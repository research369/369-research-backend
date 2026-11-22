import { asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { articles, articleSeo, articleMerchant, articleTranslations, articleUseCases, useCases } from "../drizzle/schema.js";
import { canonicalFor, canonicalJson, fail, assertParsed, inspectProductSchema, requireProductSchema,
  readFamilyFaqs, insertFamilyFaqs, canLinkUseCases, lock, replay, audit,
  type ProductDraftDb, type ProductDb } from "./productFamily.js";

const text = (max: number) => z.string().trim().min(1).max(max);
const slug = text(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).refine(v => v !== "somatide", "SOMATIDE ist kein neuer Entwurf");
const useCaseSlug = text(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const httpsUrl = text(2000).url().refine(v => {
  const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password;
}, "HTTPS URL ohne Zugangsdaten erforderlich");
const mgLabel = text(30).regex(/^(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*) ?mg$/, "Exakte positive mg-Angabe erforderlich")
  .refine(v => Number.isFinite(Number(v.replace(/ ?mg$/, ""))) && Number(v.replace(/ ?mg$/, "")) > 0);
const positive = z.number().finite().positive();

// Exact base-ten arithmetic over the submitted JSON numbers; no rounding tolerance.
type Decimal = { coefficient: bigint; scale: number };
function decimal(value: string | number): Decimal {
  const [mantissa, exponent = "0"] = String(value).toLowerCase().split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  return { coefficient: BigInt(whole + fraction), scale: fraction.length - Number(exponent) };
}
function add(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  return { coefficient: a.coefficient * 10n ** BigInt(scale - a.scale) + b.coefficient * 10n ** BigInt(scale - b.scale), scale };
}
function equalDecimal(a: Decimal, b: Decimal) {
  const scale = Math.max(a.scale, b.scale);
  return a.coefficient * 10n ** BigInt(scale - a.scale) === b.coefficient * 10n ** BigInt(scale - b.scale);
}
const alias = (v: string) => v.normalize("NFKC").trim().toLowerCase();
const compositionSchema = z.object({
  totalMassMg: positive,
  components: z.array(z.object({ name: text(160), massMg: positive }).strict()).min(1).max(20),
  volumeMl: positive.optional(), concentrationMgMl: positive.optional(),
  solvents: z.array(text(160)).min(1).max(20).optional(),
}).strict().superRefine((v, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  // Zod refinements can run on dirty (e.g. non-finite) numeric inputs.
  if (![v.totalMassMg, ...v.components.map(c => c.massMg), ...(v.volumeMl === undefined ? [] : [v.volumeMl]),
    ...(v.concentrationMgMl === undefined ? [] : [v.concentrationMgMl])].every(n => Number.isFinite(n) && n > 0)) return;
  const total = v.components.reduce((sum, c) => add(sum, decimal(c.massMg)), decimal(0));
  if (!equalDecimal(total, decimal(v.totalMassMg))) issue("Komponentenmassen müssen exakt die Gesamtmasse ergeben");
  if (new Set(v.components.map(c => alias(c.name))).size !== v.components.length) issue("Doppelte Komponentenbezeichnung");
  if ((v.volumeMl === undefined) !== (v.concentrationMgMl === undefined)) issue("Volumen und Konzentration müssen gemeinsam angegeben werden");
  if (v.volumeMl !== undefined && v.concentrationMgMl !== undefined) {
    const a = decimal(v.volumeMl), b = decimal(v.concentrationMgMl);
    if (!equalDecimal({ coefficient: a.coefficient * b.coefficient, scale: a.scale + b.scale }, decimal(v.totalMassMg)))
      issue("Volumen mal Konzentration muss exakt die Gesamtmasse ergeben");
  }
  if (v.solvents && new Set(v.solvents.map(alias)).size !== v.solvents.length) issue("Doppeltes Lösungsmittel");
});
export type DraftComposition = z.infer<typeof compositionSchema>;

// Editorial JSON only; all operational metadata is owned by this service.
const reservedKeys = new Set(["__proto__", "prototype", "constructor", "composition", "compositionvariants", "draftmeta",
  "inventoryarticleid", "masterarticleid", "articleid", "articleids", "shopvisible", "publishedat", "sellingprice",
  "saleprice", "pricestatus", "publicationready", "isactive", "requestkey", "sql", "tablename", "credentials", "password", "endpoint",
  "publish", "published", "publication", "hidden", "id", "stock", "price", "saleactive", "table", "masterid",
  "totalmassmg", "massmg", "components", "volumeml", "concentrationmgml"]);
const boundedObject = z.record(z.unknown()).superRefine((value, ctx) => {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++count > 2000 || item.depth > 6) { ctx.addIssue({ code: "custom", message: "JSON zu groß/tief" }); return; }
    const v = item.value;
    if (v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) continue;
    if (typeof v !== "object" || (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype)) {
      ctx.addIssue({ code: "custom", message: "Echtes JSON-Objekt erforderlich" }); return;
    }
    if (!Array.isArray(v) && Object.keys(v).some(k => k.length > 100 || reservedKeys.has(k.toLowerCase()))) {
      ctx.addIssue({ code: "custom", message: "Reserviertes oder zu langes JSON-Feld" }); return;
    }
    pending.push(...Object.values(v).map(child => ({ value: child, depth: item.depth + 1 })));
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 50000) ctx.addIssue({ code: "custom", message: "JSON maximal 50 KB" });
});
function strings(value: unknown): string {
  return typeof value === "string" ? value : Array.isArray(value) ? value.map(strings).join(" ")
    : value && typeof value === "object" ? Object.values(value).map(strings).join(" ") : "";
}
const descriptionSchema = boundedObject.superRefine((value, ctx) => {
  for (const key of ["kurztext", "wirkung", "fazit", "risiko"])
    if (typeof value[key] !== "string" || !(value[key] as string).trim()) ctx.addIssue({ code: "custom", message: `Beschreibung: ${key} fehlt` });
  if (!/research use only|forschungszwecke|not for human use/i.test(strings(value)))
    ctx.addIssue({ code: "custom", message: "Research Use Only Hinweis erforderlich" });
});
const seoSchema = z.object({ seoTitle: text(60), seoDescription: text(155), canonical: httpsUrl, imageAlt: text(200), ogImage: httpsUrl }).strict();
const merchantSchema = z.object({ merchantTitle: text(150), merchantDescription: text(5000), brand: text(100),
  googleProductCategory: text(10).nullable(), productType: text(200) }).strict();
const faqSchema = z.object({ lang: z.literal("de"), question: text(1000), answer: text(5000) }).strict();
const variantSchema = z.object({ label: mgLabel, sku: text(50), imageUrl: httpsUrl, price: z.null(), stock: z.literal(0), composition: compositionSchema }).strict();

export const createProductDraftInput = z.object({
  requestKey: z.string().uuid().transform(v => v.toLowerCase()), shopProductId: slug,
  name: text(160), category: text(100), categories: z.array(text(100)).min(1).max(20), shortDescription: text(2000),
  badge: text(100).default("Entwurf"), casNumber: text(50).nullable().default(null), molecularWeight: text(50).nullable().default(null),
  purity: text(20).nullable().default(null), description: descriptionSchema,
  variants: z.array(variantSchema).min(1).max(10), seo: seoSchema, merchant: merchantSchema,
  faqs: z.array(faqSchema).min(4).max(6), useCaseSlugs: z.array(useCaseSlug).max(20).default([]), social: boundedObject.default({}),
}).strict().superRefine((input, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  if (input.seo.canonical !== canonicalFor(input.shopProductId)) issue("Canonical muss exakt zur Familien-URL passen");
  if (new Set(input.variants.map(v => alias(v.sku))).size !== input.variants.length) issue("Doppelte SKU im Payload");
  const labels: Decimal[] = [];
  for (const v of input.variants) {
    if (!mgLabel.safeParse(v.label).success || !Number.isFinite(v.composition.totalMassMg) || v.composition.totalMassMg <= 0) continue;
    const amount = decimal(v.label.replace(/ ?mg$/, ""));
    if (labels.some(other => equalDecimal(amount, other))) issue("Doppelte mg-Variante");
    labels.push(amount);
    if (!equalDecimal(amount, decimal(v.composition.totalMassMg))) issue("Composition muss exakt zur mg-Variante passen");
    if (`${input.name} (${v.label})`.length > 200) issue("Variantenname maximal 200 Zeichen");
  }
  if (new Set(input.categories.map(alias)).size !== input.categories.length) issue("Doppelte Kategorie");
  if (new Set(input.useCaseSlugs).size !== input.useCaseSlugs.length) issue("Doppelter Use Case");
  if (new Set(input.faqs.map(f => alias(f.question))).size !== input.faqs.length) issue("Doppelte FAQ");
});
export const getProductDraftInput = z.object({ shopProductId: slug }).strict();
export type CreateProductDraftInput = z.infer<typeof createProductDraftInput>;
export const PRODUCT_DRAFT_NOTES = "Unveröffentlichter Produktentwurf. Preis offen. Bestand 0. Keine Verkaufsfreigabe.";

export function isProductDraftArticle(article: { description?: unknown }): boolean {
  const d = article.description;
  if (!d || typeof d !== "object" || Array.isArray(d)) return false;
  const meta = (d as Record<string, unknown>).draftMeta;
  return !!meta && typeof meta === "object" && !Array.isArray(meta) && (meta as Record<string, unknown>).isDraft === true;
}
const draftMetaSchema = z.object({ isDraft: z.literal(true), priceStatus: z.literal("open"), status: z.literal("draft"),
  social: boundedObject, sellingPriceStorage: z.enum(["null", "technical-zero"]) }).strict();
const storedVariantSchema = z.object({ dosage: mgLabel, label: mgLabel, sku: text(50), price: z.null(), priceStatus: z.literal("open"),
  stock: z.literal(0), inventoryArticleId: z.number().int().positive(), image: httpsUrl, imageUrl: httpsUrl,
  images: z.array(httpsUrl).length(1), composition: compositionSchema }).strict();
export type ProductDraftVariant = z.infer<typeof storedVariantSchema>;

async function sellingPriceNullable(db: ProductDb) {
  // Fixed known relation and column, never a caller-provided identifier.
  const result = await db.execute<{ nullable: boolean }>(sql`SELECT NOT a.attnotnull AS nullable FROM pg_attribute a
    WHERE a.attrelid = to_regclass('articles') AND a.attname = 'selling_price' AND a.attnum > 0 AND NOT a.attisdropped`);
  if (result.rows.length !== 1) fail("Produkt-Schema unvollständig: articles.selling_price", "CONFLICT");
  return result.rows[0].nullable;
}

export async function createProductDraft(db: ProductDraftDb, value: CreateProductDraftInput, actor: string) {
  const input = assertParsed(createProductDraftInput, value, "Produktentwurf");
  return db.transaction(async tx => {
    const schema = await inspectProductSchema(tx); requireProductSchema(schema);
    if (input.useCaseSlugs.length && !canLinkUseCases(schema)) fail("Use-Case-Slugs können nicht verknüpft werden: Tabellen oder ID-/Slug-Felder fehlen oder sind inkompatibel");
    await lock(tx, `request:${input.requestKey}`);
    await lock(tx, `family:${input.shopProductId}`);
    // Shared canonical keys and lock order also serialize legacy-route SKU aliases.
    const skuKeys = new Set(input.variants.map(v => v.sku.toLowerCase()));
    for (const sku of [...skuKeys].sort()) await lock(tx, `sku:${sku}`);
    const prior = await replay<CreateProductDraftResponse>(tx, input.requestKey, "CREATE_DRAFT", input);
    if (prior.response) return prior.response;
    if ((await tx.select({ id: articles.id }).from(articles).where(sql`lower(${articles.shopProductId}) = ${input.shopProductId}`)).length)
      fail("Produktfamilie existiert bereits", "CONFLICT");
    if ((await tx.select({ id: articles.id }).from(articles).where(inArray(sql`lower(${articles.sku})`, input.variants.map(v => v.sku.toLowerCase())))).length)
      fail("SKU existiert bereits", "CONFLICT");
    if ((await tx.select({ id: articleSeo.id }).from(articleSeo).where(sql`lower(${articleSeo.slug}) = ${input.shopProductId}`)).length)
      fail("SEO-Slug existiert bereits", "CONFLICT");
    const selectedUseCases = input.useCaseSlugs.length ? await tx.select({ id: useCases.id, slug: useCases.slug })
      .from(useCases).where(inArray(useCases.slug, input.useCaseSlugs)) : [];
    if (selectedUseCases.length !== input.useCaseSlugs.length || new Set(selectedUseCases.map(u => u.slug)).size !== input.useCaseSlugs.length)
      fail("Use-Case-Slug existiert nicht oder ist mehrdeutig");
    const nullable = await sellingPriceNullable(tx);
    const draftMeta = { isDraft: true, priceStatus: "open", status: "draft", social: input.social,
      sellingPriceStorage: nullable ? "null" : "technical-zero" };
    const variants: ProductDraftVariant[] = [];
    const compositionVariants = Object.fromEntries(input.variants.map(v => [v.sku, v.composition]));
    for (const [index, v] of input.variants.entries()) {
      const [a] = await tx.insert(articles).values({ name: `${input.name} (${v.label})`, sku: v.sku, shopProductId: input.shopProductId,
        category: input.category, categories: input.categories, shortDescription: input.shortDescription, badge: input.badge,
        casNumber: input.casNumber, molecularWeight: input.molecularWeight, purity: input.purity,
        description: { ...input.description, composition: v.composition, draftMeta, ...(index === 0 ? { compositionVariants } : {}) },
        notes: PRODUCT_DRAFT_NOTES, sellingPrice: nullable ? null : "0.00", salePrice: null, stock: 0, isActive: 1,
        shopVisible: 0, publishedAt: null, mockupImageUrl: v.imageUrl, labelImageUrl: v.imageUrl,
        galleryImages: [v.imageUrl], variants: null }).returning();
      variants.push({ dosage: v.label, label: v.label, sku: v.sku, price: null, priceStatus: "open", stock: 0,
        inventoryArticleId: a.id, image: v.imageUrl, imageUrl: v.imageUrl, images: [v.imageUrl], composition: v.composition });
    }
    const masterArticleId = variants[0].inventoryArticleId;
    await tx.update(articles).set({ variants, galleryImages: input.variants.map(v => v.imageUrl) }).where(eq(articles.id, masterArticleId));
    await tx.insert(articleSeo).values({ articleId: masterArticleId, slug: input.shopProductId, ...input.seo, faqEnabled: 1, schemaEnabled: 1 });
    await tx.insert(articleMerchant).values({ articleId: masterArticleId, ...input.merchant, availability: "out_of_stock", condition: "new" });
    const masterDescription = { ...input.description, composition: input.variants[0].composition, draftMeta, compositionVariants };
    await tx.insert(articleTranslations).values({ articleId: masterArticleId, lang: "de", name: input.name,
      shortDescription: input.shortDescription, description: masterDescription, seoTitle: input.seo.seoTitle,
      seoDescription: input.seo.seoDescription, imageAlt: input.seo.imageAlt,
      merchantTitle: input.merchant.merchantTitle, merchantDescription: input.merchant.merchantDescription });
    await insertFamilyFaqs(tx, schema, masterArticleId, input.faqs);
    for (const u of selectedUseCases.sort((a, b) => a.slug.localeCompare(b.slug)))
      await tx.execute(sql`INSERT INTO article_use_cases (article_id, use_case_id) VALUES (${masterArticleId}, ${u.id})`);
    const response = await readProductDraftData(tx, input.shopProductId);
    // Reconstruct exact submitted data from persisted rows before committing (detect trigger corruption).
    const expected = { ...input, useCaseSlugs: [...input.useCaseSlugs].sort() };
    if (canonicalJson({ ...response.input, requestKey: input.requestKey }) !== canonicalJson(expected))
      fail("Gespeicherter Entwurf widerspricht Payload", "CONFLICT");
    // JSON-only response guarantees exact audit replay (no Date/string drift).
    const result = { success: true as const, shopProductId: input.shopProductId, masterArticleId,
      articleIds: response.articleIds, variants: response.variants, shopVisible: false as const,
      priceStatus: "open" as const, publicationReady: false as const,
      faqs: response.input.faqs, seo: response.input.seo, merchant: response.input.merchant, notes: PRODUCT_DRAFT_NOTES };
    await audit(tx, masterArticleId, "CREATE_DRAFT", input.requestKey, prior.fingerprint, result, actor,
      { articleIds: result.articleIds, priceStatus: "open", sellingPriceStorage: draftMeta.sellingPriceStorage, stock: 0 });
    return result;
  });
}

async function readProductDraftData(db: ProductDb, shopProductId: string) {
  const schema = await inspectProductSchema(db); requireProductSchema(schema);
  const rows = await db.select().from(articles).where(sql`lower(${articles.shopProductId}) = ${shopProductId}`).orderBy(asc(articles.id));
  if (!rows.length || rows.some(a => !isProductDraftArticle(a))) fail("Unveröffentlichter Produktentwurf nicht gefunden", "NOT_FOUND");
  const masters = rows.filter(a => Array.isArray(a.variants) && a.variants.length);
  if (masters.length !== 1) fail("Entwurf benötigt genau einen Variantenmaster", "CONFLICT");
  const master = masters[0], ids = rows.map(a => a.id);
  const variants = assertParsed(z.array(storedVariantSchema).min(1).max(10), master.variants, "Entwurfsvarianten");
  if (variants.length !== rows.length || variants[0].inventoryArticleId !== master.id) fail("Entwurfszuordnung ungültig", "CONFLICT");
  const nullable = await sellingPriceNullable(db);
  const description = master.description as Record<string, unknown>;
  const meta = assertParsed(draftMetaSchema, description.draftMeta, "Entwurfsmarker");
  if (meta.sellingPriceStorage !== (nullable ? "null" : "technical-zero")) fail("Entwurfspreisspeicher ungültig", "CONFLICT");
  const articleIds: number[] = [];
  for (const v of variants) {
    const row = rows.find(a => a.id === v.inventoryArticleId);
    if (!row || articleIds.includes(row.id) || row.shopProductId !== shopProductId || row.sku !== v.sku
      || row.isActive !== 1 || row.shopVisible !== 0 || row.publishedAt !== null || row.stock !== 0 || row.salePrice !== null
      || (nullable ? row.sellingPrice !== null : row.sellingPrice === null || Number(row.sellingPrice) !== 0)
      || row.notes !== PRODUCT_DRAFT_NOTES || (row.id !== master.id && row.variants !== null)
      || v.dosage !== v.label || v.image !== v.imageUrl || v.images[0] !== v.imageUrl
      || row.mockupImageUrl !== v.imageUrl || row.labelImageUrl !== v.imageUrl
      || canonicalJson(row.galleryImages) !== canonicalJson(row.id === master.id ? variants.map(item => item.imageUrl) : [v.imageUrl]))
      fail("Entwurfsvariante stimmt nicht exakt mit verborgener Lagerzeile überein", "CONFLICT");
    const d = row.description as Record<string, unknown>;
    if (canonicalJson(d.composition) !== canonicalJson(v.composition) || canonicalJson(d.draftMeta) !== canonicalJson(meta)
      || (row.id !== master.id && d.compositionVariants !== undefined)) fail("Variantenzusammensetzung oder Entwurfsmarker widersprüchlich", "CONFLICT");
    const { composition: _composition, compositionVariants: _compositionVariants, draftMeta: _meta, ...editorial } = d;
    const { composition: _masterComposition, compositionVariants: _masterVariants, draftMeta: _masterMeta, ...masterEditorial } = description;
    if (canonicalJson(editorial) !== canonicalJson(masterEditorial) || row.category !== master.category
      || canonicalJson(row.categories) !== canonicalJson(master.categories) || row.shortDescription !== master.shortDescription
      || row.casNumber !== master.casNumber || row.molecularWeight !== master.molecularWeight || row.purity !== master.purity || row.badge !== master.badge)
      fail("Entwurfsmetadaten widersprüchlich", "CONFLICT");
    articleIds.push(row.id);
  }
  if (canonicalJson(description.compositionVariants) !== canonicalJson(Object.fromEntries(variants.map(v => [v.sku, v.composition]))))
    fail("Composition-Varianten fehlen oder widersprechen Lagerzeilen", "CONFLICT");
  const seoRows = await db.select().from(articleSeo).where(inArray(articleSeo.articleId, ids));
  const merchantRows = await db.select().from(articleMerchant).where(inArray(articleMerchant.articleId, ids));
  const translations = await db.select().from(articleTranslations).where(inArray(articleTranslations.articleId, ids));
  const faqs = await readFamilyFaqs(db, schema, ids);
  const links = canLinkUseCases(schema) ? await db.select({ articleId: articleUseCases.articleId, slug: useCases.slug })
    .from(articleUseCases).innerJoin(useCases, eq(articleUseCases.useCaseId, useCases.id))
    .where(inArray(articleUseCases.articleId, ids)).orderBy(asc(useCases.slug)) : [];
  if (seoRows.length !== 1 || merchantRows.length !== 1 || translations.length !== 1
    || [...seoRows, ...merchantRows, ...translations, ...faqs, ...links].some(r => r.articleId !== master.id))
    fail("Entwurfsmetadaten fehlen, sind mehrdeutig oder auf Kindartikel", "CONFLICT");
  const seo = seoRows[0], merchant = merchantRows[0], de = translations[0];
  if (seo.slug !== shopProductId || seo.faqEnabled !== 1 || seo.schemaEnabled !== 1 || merchant.availability !== "out_of_stock"
    || merchant.condition !== "new" || de.lang !== "de" || de.shortDescription !== master.shortDescription
    || canonicalJson(de.description) !== canonicalJson(master.description) || de.seoTitle !== seo.seoTitle
    || de.seoDescription !== seo.seoDescription || de.imageAlt !== seo.imageAlt || de.merchantTitle !== merchant.merchantTitle
    || de.merchantDescription !== merchant.merchantDescription || faqs.some(f => f.isVisible !== 1))
    fail("DE/SEO/Merchant/FAQ-Metadaten widersprüchlich", "CONFLICT");
  const { composition: _composition, compositionVariants: _compositionVariants, draftMeta: _meta, ...editorial } = description;
  const input = assertParsed(createProductDraftInput, { requestKey: "00000000-0000-4000-8000-000000000000", shopProductId,
    name: de.name, category: master.category, categories: master.categories, shortDescription: master.shortDescription,
    badge: master.badge, casNumber: master.casNumber, molecularWeight: master.molecularWeight, purity: master.purity, description: editorial,
    variants: variants.map(v => ({ label: v.label, sku: v.sku, price: null, stock: 0, imageUrl: v.imageUrl, composition: v.composition })),
    seo: { seoTitle: seo.seoTitle, seoDescription: seo.seoDescription, canonical: seo.canonical, imageAlt: seo.imageAlt, ogImage: seo.ogImage },
    merchant: { merchantTitle: merchant.merchantTitle, merchantDescription: merchant.merchantDescription,
      brand: merchant.brand, googleProductCategory: merchant.googleProductCategory, productType: merchant.productType },
    faqs: faqs.map(f => ({ lang: f.lang, question: f.question, answer: f.answer })), useCaseSlugs: links.map(l => l.slug).sort(), social: meta.social }, "Gespeicherter Entwurf");
  if (rows.some((row) => !variants.some(v => v.inventoryArticleId === row.id && row.name === `${input.name} (${v.label})`)))
    fail("Entwurfsname widerspricht Variante", "CONFLICT");
  return { success: true as const, shopProductId, masterArticleId: master.id, articleIds, variants,
    shopVisible: false as const, priceStatus: "open" as const, publicationReady: false as const,
    master, articles: rows, description: master.description, social: meta.social, faqs, seo, merchant, translations,
    useCases: links, notes: PRODUCT_DRAFT_NOTES, productSchemaStatus: schema.status, input };
}
type ProductDraftResponse = Omit<Awaited<ReturnType<typeof readProductDraftData>>, "input">;
export type CreateProductDraftResponse = { success: true; shopProductId: string; masterArticleId: number; articleIds: number[];
  variants: ProductDraftVariant[]; shopVisible: false; priceStatus: "open"; publicationReady: false;
  faqs: CreateProductDraftInput["faqs"]; seo: CreateProductDraftInput["seo"]; merchant: CreateProductDraftInput["merchant"]; notes: string };

export async function readProductDraft(db: ProductDraftDb, shopProductId: string): Promise<ProductDraftResponse> {
  const parsed = assertParsed(getProductDraftInput, { shopProductId }, "Produktentwurf");
  return db.transaction(async tx => {
    const { input: _input, ...result } = await readProductDraftData(tx, parsed.shopProductId);
    return result;
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
