import { createHash } from "node:crypto";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { articles, articleSeo, articleMerchant, articleTranslations, stockHistory, productAuditLog } from "../drizzle/schema.js";
import { assertParsed, canonicalFor, canonicalJson, fail, inspectProductSchema, requireProductSchema,
  readFamilyFaqs, insertFamilyFaqs, canLinkUseCases, lock, replay, audit, type ProductDraftDb, type ProductDb } from "./productFamily.js";
import { createProductDraftInput, getProductDraftInput, isProductDraftArticle } from "./productDraft.js";
import { applyStockMovement } from "./stockMovementService.js";
import { validateProductData } from "./productValidation.js";

// Reuse the existing bounded editorial JSON, exact decimal composition and HTTPS contracts.
const base = createProductDraftInput.innerType();
const draftVariant = base.shape.variants.element;
const contentSchema = base.pick({ name: true, category: true, categories: true, shortDescription: true,
  badge: true, casNumber: true, molecularWeight: true, purity: true, description: true, seo: true, merchant: true, faqs: true }).extend({
    description: z.record(z.unknown()).superRefine((v, ctx) => {
      const { composition, ...editorial } = v;
      const parsed = base.shape.description.safeParse(editorial);
      if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue(issue);
      if (composition !== undefined) {
        const parsedComposition = draftVariant.shape.composition.safeParse(composition);
        if (!parsedComposition.success) for (const issue of parsedComposition.error.issues) ctx.addIssue(issue);
      }
    }),
  }).strict();
const cents = (v: number) => {
  const [mantissa, exponent = "0"] = String(v).toLowerCase().split("e");
  return (mantissa.split(".")[1] ?? "").length - Number(exponent) <= 2;
};
export const getVariantReleaseInput = getProductDraftInput.extend({ masterArticleId: z.number().int().positive().optional() }).strict();
export const releaseProductVariantInput = z.object({
  shopProductId: getProductDraftInput.shape.shopProductId,
  masterArticleId: z.number().int().positive(), requestKey: z.string().uuid().transform(v => v.toLowerCase()),
  expectedSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  selected: draftVariant.omit({ price: true, stock: true }).extend({
    articleId: z.number().int().positive().nullable(),
    price: z.number().finite().positive().max(99999999.99).refine(cents, "Preis darf höchstens zwei Nachkommastellen haben"),
    targetStock: z.number().int().min(0).max(2147483647),
  }).strict(),
  content: contentSchema.optional(),
}).strict().superRefine((input, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  if (Number(input.selected.label.replace(/ ?mg$/, "")) !== input.selected.composition.totalMassMg)
    issue("Composition muss exakt zur mg-Variante passen");
  if (input.content) {
    if (input.content.description.composition !== undefined && canonicalJson(input.content.description.composition) !== canonicalJson(input.selected.composition))
      issue("Beschreibung widerspricht ausgewählter Composition");
    if (input.content.seo.canonical !== canonicalFor(input.shopProductId)) issue("Canonical muss exakt zur Familien-URL passen");
    if (input.content.category !== "Vials" || !input.content.categories.includes("Vials")) issue("Freigabe nur für Vials");
    if (new Set(input.content.categories.map(v => v.toLowerCase())).size !== input.content.categories.length) issue("Doppelte Kategorie");
    if (new Set(input.content.faqs.map(f => f.question.toLowerCase())).size !== input.content.faqs.length) issue("Doppelte FAQ");
    if (`${input.content.name} (${input.selected.label})`.length > 200) issue("Variantenname maximal 200 Zeichen");
  }
});
export type ReleaseProductVariantInput = z.infer<typeof releaseProductVariantInput>;
type Article = typeof articles.$inferSelect;
const json = (v: unknown) => JSON.parse(JSON.stringify(v));
const equal = (a: unknown, b: unknown) => canonicalJson(json(a)) === canonicalJson(json(b));
const object = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
const labelOf = (a: Article) => a.name.match(/\((\d+(?:\.\d+)? ?mg)\)$/)?.[1]
  ?? a.name.match(/(\d+(?:\.\d+)? ?mg)\s*$/i)?.[1]
  ?? a.sku.match(/(\d+(?:\.\d+)?)MG$/i)?.[1]?.concat(" mg");
const mass = (label: unknown) => typeof label === "string" ? Number(label.replace(/ ?mg$/, "")) : NaN;

async function releaseData(db: ProductDb, shopProductId: string, expectedMasterId?: number) {
  const schema = await inspectProductSchema(db); requireProductSchema(schema);
  const rows = await db.select().from(articles).where(eq(articles.shopProductId, shopProductId)).orderBy(asc(articles.id));
  if (!rows.length) fail("Produktfamilie nicht gefunden", "NOT_FOUND");
  const ids = rows.map(a => a.id);
  const seoRows = await db.select().from(articleSeo).where(inArray(articleSeo.articleId, ids)).orderBy(asc(articleSeo.id));
  const merchantRows = await db.select().from(articleMerchant).where(inArray(articleMerchant.articleId, ids)).orderBy(asc(articleMerchant.id));
  const translations = await db.select().from(articleTranslations).where(inArray(articleTranslations.articleId, ids)).orderBy(asc(articleTranslations.id));
  const faqs = await readFamilyFaqs(db, schema, ids);
  const links = canLinkUseCases(schema) ? (await db.execute<Record<string, unknown>>(sql`SELECT * FROM article_use_cases
    WHERE article_id IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)}) ORDER BY id`)).rows : [];
  const history = await db.select().from(stockHistory).where(inArray(stockHistory.articleId, ids)).orderBy(asc(stockHistory.id));
  const active = rows.filter(a => a.isActive === 1);
  const owners = active.filter(a => Array.isArray(a.variants) && a.variants.length);
  const master = owners.length === 1 ? owners[0] : owners.length === 0 && active.length === 1 ? active[0] : null;
  if (!master) fail("Familie benötigt einen eindeutigen Variantenmaster", "CONFLICT");
  if (expectedMasterId !== undefined && master.id !== expectedMasterId) fail("masterArticleId gehört nicht zum exakten Familienmaster", "CONFLICT");
  const ownSeo = seoRows.filter(r => r.articleId === master.id), ownMerchant = merchantRows.filter(r => r.articleId === master.id);
  if (ownSeo.length > 1 || ownMerchant.length > 1 || new Set(translations.filter(t => t.articleId === master.id).map(t => t.lang)).size !== translations.filter(t => t.articleId === master.id).length)
    fail("Master-Metadaten mehrdeutig", "CONFLICT");
  if (ownSeo[0] && ownSeo[0].slug !== shopProductId) fail("Stabiler SEO-Slug widerspricht Familie", "CONFLICT");
  return json({ shopProductId, masterArticleId: master.id, master, articles: rows,
    variants: Array.isArray(master.variants) ? master.variants : [], seo: ownSeo[0] ?? null, merchant: ownMerchant[0] ?? null,
    metadata: { seo: seoRows, merchant: merchantRows, translations, faqs, useCases: links },
    translations, faqs, useCases: links, stockHistory: history, productSchemaStatus: schema.status }) as {
      shopProductId: string; masterArticleId: number; master: Article; articles: Article[]; variants: any[];
      seo: typeof articleSeo.$inferSelect | null; merchant: typeof articleMerchant.$inferSelect | null;
      metadata: { seo: Array<typeof articleSeo.$inferSelect>; merchant: Array<typeof articleMerchant.$inferSelect>; translations: Array<typeof articleTranslations.$inferSelect>; faqs: Awaited<ReturnType<typeof readFamilyFaqs>>; useCases: Record<string, unknown>[] };
      translations: Array<typeof articleTranslations.$inferSelect>; faqs: Awaited<ReturnType<typeof readFamilyFaqs>>;
      useCases: Record<string, unknown>[]; stockHistory: Array<typeof stockHistory.$inferSelect>; productSchemaStatus: typeof schema.status;
    };
}
type Snapshot = Awaited<ReturnType<typeof releaseData>>;
function snapshotHash(data: Snapshot) { return createHash("sha256").update(canonicalJson(data)).digest("hex"); }
export async function readVariantReleaseSnapshot(db: ProductDraftDb, shopProductId: string, masterArticleId?: number) {
  const input = assertParsed(getVariantReleaseInput, { shopProductId, masterArticleId }, "Variantenfreigabe");
  return db.transaction(async tx => {
    const data = await releaseData(tx, input.shopProductId, input.masterArticleId);
    const auditLog = await tx.select().from(productAuditLog).where(inArray(productAuditLog.articleId, data.articles.map(a => a.id))).orderBy(asc(productAuditLog.id));
    return { ...data, rawDrafts: data.articles.filter(isProductDraftArticle), expectedSnapshotHash: snapshotHash(data), auditLog };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
function editorial(description: unknown) {
  const { composition: _c, compositionVariants: _cv, draftMeta: _dm, operatorNotes: _private, ...rest } = object(description);
  return rest;
}
function existingContent(before: Snapshot) {
  const m = before.master, s = before.seo, me = before.merchant;
  const de = before.translations.find(t => t.articleId === m.id && t.lang === "de");
  if (!s || !me || !de) fail("Vollständige freigegebene Familieninhalte erforderlich");
  return assertParsed(contentSchema, { name: de.name || m.name.replace(/\s*\([\d.]+ ?mg\)$/, ""), category: m.category, categories: m.categories,
    shortDescription: m.shortDescription, badge: m.badge || "Research Vial", casNumber: m.casNumber, molecularWeight: m.molecularWeight,
    purity: m.purity, description: editorial(m.description),
    seo: { seoTitle: s.seoTitle, seoDescription: s.seoDescription, canonical: s.canonical, imageAlt: s.imageAlt, ogImage: s.ogImage },
    merchant: { merchantTitle: me.merchantTitle, merchantDescription: me.merchantDescription, brand: me.brand,
      googleProductCategory: me.googleProductCategory, productType: me.productType },
    faqs: before.faqs.filter(f => f.articleId === m.id && f.isVisible === 1).map(f => ({ lang: f.lang, question: f.question, answer: f.answer })) }, "Vollständige Familieninhalte erforderlich");
}
// Exact disclaimers from the existing explicit-composition finalization profile.
const negativeDisclaimers = [
  "Es werden keine Aussagen zur Injektion, zur Anwendung an Menschen oder Tieren, zu Dosierungen oder zu medizinischen Ergebnissen gemacht.",
  "Keine Human- oder Tieranwendung, keine Dosierung, keine Injektion und keine medizinischen Versprechen.",
  "Es werden keine Human- oder Tieranwendung, keine Injektion und keine Dosierung empfohlen.",
  "Es werden keine Human- oder Tieranwendung, keine Injektionseignung und keine Dosierungs- oder Rekonstitutionsanweisung angegeben.",
  "Keine Dosierung, keine Anwendungsempfehlung.",
];
function complianceProjection(v: unknown): unknown {
  if (typeof v === "string") return negativeDisclaimers.reduce((s, phrase) => s.split(phrase).join(""), v);
  if (Array.isArray(v)) return v.map(complianceProjection);
  return v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, value]) => [k, complianceProjection(value)])) : v;
}
function validateRelease(master: Article, content: z.infer<typeof contentSchema>) {
  if (master.purity === null && object(content.description.eigenschaften).reinheit !== "Chargennachweis ausstehend")
    fail("Nullable Reinheit benötigt Chargennachweis ausstehend");
  const validation = validateProductData({ ...master, description: complianceProjection({ description: master.description,
    seo: content.seo, merchant: content.merchant, faqs: content.faqs }), shortDescription: complianceProjection(master.shortDescription) },
    { ...content.seo, slug: master.shopProductId }, { ...content.merchant, availability: "in_stock" }, content.merchant);
  const nullable = new Set([...(master.casNumber === null ? ["CAS-Nummer fehlt (empfohlen für Peptide)"] : []),
    ...(master.purity === null ? ["Reinheitsangabe fehlt"] : []), ...(content.merchant.googleProductCategory === null ? ["Google Product Category fehlt"] : [])]);
  const warnings = validation.warnings.filter(w => !nullable.has(w));
  if (!validation.isValid || warnings.length || !validation.hasResearchNote)
    fail(`Variantenfreigabe nicht valide: ${[...validation.issues, ...warnings].join("; ")}`);
  return { ...validation, warnings, score: 100, validationProfile: "explicit-composition-draft-v1" as const };
}

export async function releaseProductVariant(db: ProductDraftDb, value: ReleaseProductVariantInput, actor: string) {
  const input = assertParsed(releaseProductVariantInput, value, "Variantenfreigabe");
  return db.transaction(async tx => {
    const schema = await inspectProductSchema(tx); requireProductSchema(schema);
    await lock(tx, `request:${input.requestKey}`); await lock(tx, `family:${input.shopProductId}`);
    const prior = await replay<Record<string, any>>(tx, input.requestKey, "RELEASE_VARIANT", input);
    // Historical replay precedes current stock/hash checks; never restock a later sale.
    if (prior.response) return prior.response;
    const discovered = await tx.select({ id: articles.id, sku: articles.sku }).from(articles).where(eq(articles.shopProductId, input.shopProductId)).orderBy(asc(articles.id));
    if (!discovered.length) fail("Produktfamilie nicht gefunden", "NOT_FOUND");
    const skus = [...new Set([...discovered.map(a => a.sku.toLowerCase()), input.selected.sku.toLowerCase()])].sort();
    for (const sku of skus) await lock(tx, `sku:${sku}`);
    await tx.select({ id: articles.id }).from(articles).where(inArray(sql`lower(${articles.sku})`, skus)).orderBy(asc(articles.id)).for("update");
    const ids = discovered.map(a => a.id);
    for (const table of [articleSeo, articleMerchant, articleTranslations])
      await tx.select({ id: table.id }).from(table).where(inArray(table.articleId, ids)).orderBy(asc(table.id)).for("update");
    await tx.execute(sql`SELECT id FROM article_faq WHERE article_id IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)}) ORDER BY id FOR UPDATE`);
    if (canLinkUseCases(schema)) await tx.execute(sql`SELECT id FROM article_use_cases WHERE article_id IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)}) ORDER BY id FOR UPDATE`);
    await tx.select({ id: stockHistory.id }).from(stockHistory).where(inArray(stockHistory.articleId, ids)).orderBy(asc(stockHistory.id)).for("update");
    const before = await releaseData(tx, input.shopProductId), beforeSnapshotHash = snapshotHash(before);
    if (input.masterArticleId !== before.masterArticleId) fail("masterArticleId gehört nicht zum exakten Familienmaster", "CONFLICT");
    if (input.expectedSnapshotHash !== beforeSnapshotHash) fail("Freigabe-Snapshot veraltet; getVariantReleaseSnapshot erneut lesen", "CONFLICT");
    const activeIds = new Set(before.articles.filter(a => a.isActive === 1).map(a => a.id));
    if ([...before.metadata.seo, ...before.metadata.merchant, ...before.translations, ...before.faqs].some(r => activeIds.has(r.articleId) && r.articleId !== before.masterArticleId)
      || before.useCases.some(r => activeIds.has(Number(r.article_id)) && r.article_id !== before.masterArticleId))
      fail("Aktive Familienmetadaten liegen auf einem Kindartikel", "CONFLICT");
    if (before.metadata.seo.some(r => r.articleId !== before.masterArticleId && r.slug === input.shopProductId)
      || (await tx.select({ id: articleSeo.id }).from(articleSeo).where(eq(articleSeo.slug, input.shopProductId))).some(r => r.id !== before.seo?.id))
      fail("SEO-Slug gehört einem anderen Artikel", "CONFLICT");
    const selected = input.selected;
    let selectedRow = selected.articleId === null ? undefined : before.articles.find(a => a.id === selected.articleId);
    if (selected.articleId !== null && !selectedRow) fail("Auswahl gehört nicht zur Familie", "CONFLICT");
    if (selectedRow && selectedRow.isActive !== 1) fail("Archivierte Artikel sind nicht freigabefähig", "CONFLICT");
    const aliases = await tx.select({ id: articles.id }).from(articles).where(sql`lower(${articles.sku}) = ${selected.sku.toLowerCase()}`);
    if (selectedRow ? aliases.length !== 1 || aliases[0].id !== selectedRow.id || selectedRow.sku !== selected.sku : aliases.length !== 0)
      fail("SKU fehlt, existiert bereits oder ist mehrdeutig", "CONFLICT");
    if (selectedRow && mass(labelOf(selectedRow)) !== mass(selected.label)) fail("Bestehende Stärke darf nicht umgewandelt werden", "CONFLICT");
    if (selected.articleId === null && before.articles.some(a => a.isActive === 1 && mass(labelOf(a)) === mass(selected.label)))
      fail("Stärke existiert bereits; bestehenden Artikel auswählen", "CONFLICT");
    if (selectedRow && isProductDraftArticle(selectedRow) && !equal(object(selectedRow.description).composition, selected.composition))
      fail("Bestehende Entwurfscomposition darf nicht umgewandelt werden", "CONFLICT");
    const drafts = before.articles.filter(isProductDraftArticle);
    if (drafts.some(a => a.stock !== 0 || (a.sellingPrice !== null && Number(a.sellingPrice) !== 0) || a.salePrice !== null || a.shopVisible !== 0 || a.publishedAt !== null)
      || before.stockHistory.some(h => drafts.some(a => a.id === h.articleId))) fail("Verborgener Nullpreis-Entwurf widersprüchlich", "CONFLICT");
    const hiddenDraftFamily = isProductDraftArticle(before.master);
    if (hiddenDraftFamily && before.articles.some(a => a.isActive === 1 && !isProductDraftArticle(a))) fail("Mehrdeutiger Entwurfs-/Masterzustand", "CONFLICT");
    if (hiddenDraftFamily && !input.content) fail("Vollständige freigegebene Familieninhalte erforderlich");
    const content = input.content ?? existingContent(before);
    if (content.category !== "Vials" || !content.categories.includes("Vials")) fail("Freigabe nur für Vials");
    const approvedRows = hiddenDraftFamily ? [] : before.articles.filter(a => a.isActive === 1 && !isProductDraftArticle(a));
    if (approvedRows.some(a => a.isActive !== 1 || (a.id !== before.masterArticleId && (a.shopVisible !== 0 || a.variants !== null)))
      || (!hiddenDraftFamily && before.master.shopVisible !== 1)) fail("Öffentliche Familienstruktur widersprüchlich", "CONFLICT");
    if (approvedRows.some(a => a.id !== selected.articleId && mass(labelOf(a)) === mass(selected.label))) fail("Doppelte freigegebene Stärke", "CONFLICT");
    const now = new Date();
    const selectedDescription = { ...content.description, composition: selected.composition };
    const selectedPatch = { name: `${content.name} (${selected.label})`, category: content.category, categories: content.categories,
      shortDescription: content.shortDescription, badge: /^(?:Entwurf|Unveröffentlichter Entwurf)$/i.test(content.badge) ? null : content.badge,
      casNumber: content.casNumber, molecularWeight: content.molecularWeight, purity: content.purity,
      description: selectedDescription, notes: null, sellingPrice: selected.price.toFixed(2), salePrice: null,
      mockupImageUrl: selected.imageUrl, labelImageUrl: selected.imageUrl, galleryImages: [selected.imageUrl], isActive: 1, updatedAt: now };
    if (!selectedRow) {
      [selectedRow] = await tx.insert(articles).values({ ...selectedPatch, sku: selected.sku, shopProductId: input.shopProductId,
        stock: 0, shopVisible: 0, variants: null, publishedAt: null }).returning();
    }
    const masterId = hiddenDraftFamily ? selectedRow.id : before.masterArticleId;
    const publicRows = [...approvedRows.filter(a => a.id !== selectedRow!.id), { ...selectedRow, ...selectedPatch, stock: selected.targetStock }];
    publicRows.sort((a, b) => Number(b.id === masterId) - Number(a.id === masterId) || a.id - b.id);
    const variants = publicRows.map(a => {
      const old = before.variants.find(v => v.inventoryArticleId === a.id || v.sku === a.sku);
      const label = a.id === selectedRow!.id ? selected.label : old?.label ?? old?.dosage ?? labelOf(a);
      const composition = a.id === selectedRow!.id ? selected.composition : old?.composition ?? object(a.description).composition;
      const parsed = assertParsed(draftVariant.shape.label, label, "Bestehende mg-Stärke");
      if (!Number.isFinite(Number(a.sellingPrice)) || Number(a.sellingPrice) <= 0 || !cents(Number(a.sellingPrice)) || a.salePrice !== null || !a.mockupImageUrl
        || (a.id !== selectedRow!.id && old && (Number(old.price) !== Number(a.sellingPrice) || old.sku !== a.sku
          || (old.inventoryArticleId !== undefined && old.inventoryArticleId !== a.id))))
        fail("Bestehende freigegebene Lagerzeile widersprüchlich", "CONFLICT");
      assertParsed(draftVariant.shape.imageUrl, a.mockupImageUrl, "Bestehendes HTTPS-Bild");
      if (composition) {
        assertParsed(draftVariant.shape.composition, composition, "Bestehende Composition");
        if (composition.totalMassMg !== mass(parsed)) fail("Bestehende Composition widerspricht mg-Stärke", "CONFLICT");
      }
      return { dosage: parsed, label: parsed, sku: a.sku, price: Number(a.sellingPrice), stock: a.stock,
        inventoryArticleId: a.id, image: a.mockupImageUrl, imageUrl: a.mockupImageUrl, images: [a.mockupImageUrl],
        ...(composition ? { composition } : {}), publicationStatus: "finalized-draft" };
    });
    if (variants.length > 10 || new Set(variants.map(v => mass(v.label))).size !== variants.length) fail("Variantenanzahl/Stärken ungültig");
    const masterRow = publicRows.find(a => a.id === masterId)!;
    const compositionVariants = Object.fromEntries(variants.filter(v => v.composition).map(v => [v.sku, v.composition]));
    const description = { ...editorial(content.description), ...(object(masterRow.description).composition ? { composition: object(masterRow.description).composition } : {}), compositionVariants };
    const masterPatch = { ...(input.content || hiddenDraftFamily ? { name: `${content.name} (${variants[0].label})`, category: content.category,
      categories: content.categories, shortDescription: content.shortDescription, badge: selectedPatch.badge,
      ...(masterId === selectedRow.id ? { casNumber: content.casNumber, molecularWeight: content.molecularWeight, purity: content.purity } : {}) } : {}),
      description, variants, galleryImages: variants.map(v => v.imageUrl), shopVisible: 1,
      publishedAt: masterRow.publishedAt ? new Date(masterRow.publishedAt) : now, updatedAt: now };
    const validation = validateRelease({ ...masterRow, ...masterPatch }, content);
    const movement = selected.targetStock === selectedRow.stock ? null : await applyStockMovement(tx, { articleId: selectedRow.id, sku: selected.sku, expectedStock: selectedRow.stock,
      change: selected.targetStock - selectedRow.stock, type: isProductDraftArticle(selectedRow) || selected.articleId === null ? "wareneingang" : "korrektur",
      reason: "Produktvariante freigegeben", actor: actor.slice(0, 100) });
    await tx.update(articles).set({ ...selectedPatch, ...(selectedRow.id === masterId ? masterPatch : { variants: null, shopVisible: 0, publishedAt: null }) }).where(eq(articles.id, selectedRow.id));
    if (selectedRow.id !== masterId) await tx.update(articles).set(masterPatch).where(eq(articles.id, masterId));
    if (masterId !== before.masterArticleId) await tx.update(articles).set({ variants: null, updatedAt: now }).where(eq(articles.id, before.masterArticleId));
    const availability = variants.some(v => v.stock > 0) ? "in_stock" : "out_of_stock";
    const seoPatch = { articleId: masterId, ...(input.content ? content.seo : {}), faqEnabled: 1, schemaEnabled: 1, updatedAt: now };
    const merchantPatch = { articleId: masterId, ...(input.content ? content.merchant : {}), availability, updatedAt: now };
    let expectedSeo, expectedMerchant;
    if (before.seo) {
      await tx.update(articleSeo).set(seoPatch).where(eq(articleSeo.id, before.seo.id)); expectedSeo = { ...before.seo, ...seoPatch };
    } else { [expectedSeo] = await tx.insert(articleSeo).values({ ...seoPatch, ...content.seo, slug: input.shopProductId }).returning(); }
    if (before.merchant) {
      await tx.update(articleMerchant).set(merchantPatch).where(eq(articleMerchant.id, before.merchant.id)); expectedMerchant = { ...before.merchant, ...merchantPatch };
    } else { [expectedMerchant] = await tx.insert(articleMerchant).values({ ...merchantPatch, ...content.merchant }).returning(); }
    const de = before.translations.find(t => t.articleId === before.masterArticleId && t.lang === "de");
    const dePatch = { articleId: masterId, name: content.name, description, shortDescription: content.shortDescription,
      seoTitle: content.seo.seoTitle, seoDescription: content.seo.seoDescription, imageAlt: content.seo.imageAlt,
      merchantTitle: content.merchant.merchantTitle, merchantDescription: content.merchant.merchantDescription, updatedAt: now };
    let insertedDe;
    if (de) await tx.update(articleTranslations).set(dePatch).where(eq(articleTranslations.id, de.id));
    else [insertedDe] = await tx.insert(articleTranslations).values({ ...dePatch, lang: "de" }).returning();
    for (const t of before.translations.filter(t => t.articleId === before.masterArticleId && t.lang !== "de"))
      await tx.update(articleTranslations).set({ articleId: masterId }).where(eq(articleTranslations.id, t.id));
    if (input.content) {
      await tx.execute(sql`DELETE FROM article_faq WHERE article_id = ${before.masterArticleId}`);
      await insertFamilyFaqs(tx, schema, masterId, content.faqs);
    } else if (masterId !== before.masterArticleId) await tx.execute(sql`UPDATE article_faq SET article_id = ${masterId} WHERE article_id = ${before.masterArticleId}`);
    if (masterId !== before.masterArticleId && canLinkUseCases(schema))
      await tx.execute(sql`UPDATE article_use_cases SET article_id = ${masterId} WHERE article_id = ${before.masterArticleId}`);
    // Exact comparison detects trigger corruption of selected/unselected articles and metadata.
    const after = await releaseData(tx, input.shopProductId);
    const expectedRows = before.articles.map(a => a.id === selectedRow!.id ? { ...a, ...selectedPatch, stock: selected.targetStock,
      ...(a.id === masterId ? masterPatch : { variants: null, shopVisible: 0, publishedAt: null }) }
      : a.id === masterId ? { ...a, ...masterPatch } : a.id === before.masterArticleId && masterId !== before.masterArticleId ? { ...a, variants: null, updatedAt: now } : a);
    if (selected.articleId === null) expectedRows.push({ ...selectedRow, ...selectedPatch, stock: selected.targetStock,
      ...(selectedRow.id === masterId ? masterPatch : { variants: null, shopVisible: 0, publishedAt: null }) });
    expectedRows.sort((a, b) => a.id - b.id);
    const expectedTranslations = before.translations.map(t => t.id === de?.id ? { ...t, ...dePatch } : t.articleId === before.masterArticleId ? { ...t, articleId: masterId } : t);
    if (insertedDe) expectedTranslations.push(insertedDe);
    expectedTranslations.sort((a, b) => a.id - b.id);
    const expectedLinks = before.useCases.map(l => l.article_id === before.masterArticleId ? { ...l, article_id: masterId } : l);
    const unchangedFaqs = before.faqs.filter(f => f.articleId !== before.masterArticleId);
    if (!equal(after.articles, expectedRows) || !equal(after.seo, expectedSeo) || !equal(after.merchant, expectedMerchant)
      || !equal(after.metadata.seo.filter(r => r.articleId !== masterId), before.metadata.seo.filter(r => r.articleId !== before.masterArticleId))
      || !equal(after.metadata.merchant.filter(r => r.articleId !== masterId), before.metadata.merchant.filter(r => r.articleId !== before.masterArticleId))
      || !equal(after.translations, expectedTranslations) || !equal(after.useCases, expectedLinks)
      || !equal(after.faqs.filter(f => f.articleId !== masterId), unchangedFaqs)) fail("Freigabe widerspricht exaktem Snapshot", "CONFLICT");
    if (input.content ? !equal(after.faqs.filter(f => f.articleId === masterId).map(f => ({ lang: f.lang, question: f.question, answer: f.answer, sortOrder: f.sortOrder, isVisible: f.isVisible })),
      content.faqs.map((f, i) => ({ ...f, sortOrder: i + 1, isVisible: 1 }))) : !equal(after.faqs, before.faqs.map(f => f.articleId === before.masterArticleId ? { ...f, articleId: masterId } : f)))
      fail("Freigabe-FAQs widersprüchlich", "CONFLICT");
    const addedHistory = after.stockHistory.filter(h => !before.stockHistory.some(old => old.id === h.id));
    if (!equal(after.stockHistory.filter(h => before.stockHistory.some(old => old.id === h.id)), before.stockHistory)
      || addedHistory.length !== (movement ? 1 : 0) || (movement && (addedHistory[0].id !== movement.movementId
        || addedHistory[0].articleId !== selectedRow.id || addedHistory[0].quantityBefore !== selectedRow.stock
        || addedHistory[0].quantityAfter !== selected.targetStock || addedHistory[0].quantityChange !== selected.targetStock - selectedRow.stock)))
      fail("Freigabe-Lagerjournal widersprüchlich", "CONFLICT");
    const response = { success: true, shopProductId: input.shopProductId, masterArticleId: masterId, selectedArticleId: selectedRow.id,
      articleIds: publicRows.map(a => a.id), remainingDraftArticleIds: after.articles.filter(isProductDraftArticle).map(a => a.id),
      variants, shopVisible: true, beforeSnapshotHash, expectedSnapshotHash: snapshotHash(after), validation,
      stockMovements: movement ? [{ articleId: selectedRow.id, sku: selected.sku, ...movement }] : [] };
    await audit(tx, masterId, "RELEASE_VARIANT", input.requestKey, prior.fingerprint, response, actor,
      { validation, selectedSku: selected.sku, stockMovements: response.stockMovements, beforeSnapshotHash }, before);
    return response;
  });
}
