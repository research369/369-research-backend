import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { articles, articleSeo, articleMerchant, articleTranslations, stockHistory } from "../drizzle/schema.js";
import { assertParsed, canonicalJson, fail, inspectProductSchema, requireProductSchema, lock, replay, audit,
  type ProductDraftDb } from "./productFamily.js";
import { getProductDraftInput, readProductDraftData, draftSnapshot, draftSnapshotHash,
  type CreateProductDraftInput, type ProductDraftVariant } from "./productDraft.js";
import { applyStockMovement } from "./stockMovementService.js";
import { validateProductData } from "./productValidation.js";

// Decimal string check, not a rounding tolerance (including JSON exponent notation).
const cents = (value: number) => {
  const [mantissa, exponent = "0"] = String(value).toLowerCase().split("e");
  const fraction = mantissa.split(".")[1] ?? "";
  return fraction.length - Number(exponent) <= 2;
};
export const finalizeProductDraftInput = z.object({
  shopProductId: getProductDraftInput.shape.shopProductId,
  masterArticleId: z.number().int().positive(),
  requestKey: z.string().uuid().transform(v => v.toLowerCase()),
  expectedSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  variants: z.tuple([z.object({ sku: z.string().min(1).max(50),
    price: z.number().finite().positive().max(9999).refine(cents, "Preis darf höchstens zwei Nachkommastellen haben"),
    stock: z.number().int().min(0).max(2147483647),
  }).strict()]),
}).strict();
export type FinalizeProductDraftInput = z.infer<typeof finalizeProductDraftInput>;
export type FinalizedDraftVariant = Omit<ProductDraftVariant, "price" | "priceStatus" | "stock"> & {
  price: number; stock: number; publicationStatus: "finalized-draft";
};
export const DRAFT_FINALIZATION_STOCK_REASON = "Produktentwurf finalisiert";

// Exact negative disclaimers only. No general negation/sentence stripping: an
// affirmative claim appended to a disclaimer must still trip the legacy guard.
const negativeDisclaimers = [
  "Es werden keine Aussagen zur Injektion, zur Anwendung an Menschen oder Tieren, zu Dosierungen oder zu medizinischen Ergebnissen gemacht.",
  "Keine Human- oder Tieranwendung, keine Dosierung, keine Injektion und keine medizinischen Versprechen.",
  "Es werden keine Human- oder Tieranwendung, keine Injektion und keine Dosierung empfohlen.",
  "Es werden keine Human- oder Tieranwendung, keine Injektionseignung und keine Dosierungs- oder Rekonstitutionsanweisung angegeben.",
  "Keine Dosierung, keine Anwendungsempfehlung.",
];
function complianceProjection(value: unknown): unknown {
  if (typeof value === "string") return negativeDisclaimers.reduce((v, phrase) => v.split(phrase).join(""), value);
  if (Array.isArray(value)) return value.map(complianceProjection);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, complianceProjection(v)]));
  return value;
}

/** Only invoked after complete strict draft reconstruction, never as a generic
 * public validator override. Unknown chemistry/purity remains explicitly null. */
function validateDraftPublication(data: Awaited<ReturnType<typeof readProductDraftData>>, master: typeof articles.$inferSelect) {
  const properties = data.input.description.eigenschaften as Record<string, unknown> | undefined;
  if (data.input.purity === null && properties?.reinheit !== "Chargennachweis ausstehend")
    fail("Nullable Reinheit benötigt den vorhandenen ehrlichen Status Chargennachweis ausstehend");
  const publicationText = { description: master.description, seo: data.input.seo, merchant: data.input.merchant, faqs: data.input.faqs };
  const validation = validateProductData({ ...master, description: complianceProjection(publicationText),
    shortDescription: complianceProjection(master.shortDescription) }, data.seo, data.merchant, data.translations[0]);
  const nullableRecommendations = new Set([
    ...(data.input.casNumber === null ? ["CAS-Nummer fehlt (empfohlen für Peptide)"] : []),
    ...(data.input.purity === null ? ["Reinheitsangabe fehlt"] : []),
    ...(data.input.merchant.googleProductCategory === null ? ["Google Product Category fehlt"] : []),
  ]);
  const warnings = validation.warnings.filter(w => !nullableRecommendations.has(w));
  if (!validation.isValid || warnings.length || !validation.hasResearchNote)
    fail(`Entwurfsveröffentlichung nicht valide: ${[...validation.issues, ...warnings].join("; ")}`);
  return { ...validation, warnings, score: 100, validationProfile: "explicit-composition-draft-v1" as const,
    nullableMetadata: { casNumber: data.input.casNumber === null, molecularWeight: data.input.molecularWeight === null,
      purity: data.input.purity === null, googleProductCategory: data.input.merchant.googleProductCategory === null } };
}

function publicDescription(input: CreateProductDraftInput, variant: ProductDraftVariant) {
  const { operatorNotes: _privateOperatorNotes, ...editorial } = input.description;
  // Original social/all sibling compositions remain private in the audit before
  // snapshot; public compositionVariants is exactly the selected existing SKU.
  return { ...editorial, composition: variant.composition, compositionVariants: { [variant.sku]: variant.composition } };
}
type FinalizeResponse = {
  success: true; shopProductId: string; masterArticleId: number; articleIds: number[];
  remainingDraftArticleIds: number[]; variants: FinalizedDraftVariant[]; shopVisible: true;
  priceStatus: "finalized"; beforeSnapshotHash: string;
  validation: ReturnType<typeof validateDraftPublication>;
  stockMovements: Array<{ articleId: number; sku: string; before: number; after: number; movementId: number }>;
};

export async function finalizeProductDraft(db: ProductDraftDb, value: FinalizeProductDraftInput, actor: string): Promise<FinalizeResponse> {
  const input = assertParsed(finalizeProductDraftInput, value, "Entwurfsfinalisierung");
  return db.transaction(async tx => {
    const schema = await inspectProductSchema(tx); requireProductSchema(schema);
    await lock(tx, `request:${input.requestKey}`);
    await lock(tx, `family:${input.shopProductId}`);
    const prior = await replay<FinalizeResponse>(tx, input.requestKey, "FINALIZE_DRAFT", input);
    // Receipt replay is historical: later legitimate sales must not restock or
    // invalidate the original receipt. Permission/input validation precede it.
    if (prior.response) return prior.response;
    const discovered = await tx.select({ id: articles.id, sku: articles.sku }).from(articles)
      .where(sql`lower(${articles.shopProductId}) = ${input.shopProductId}`).orderBy(asc(articles.id));
    for (const sku of [...new Set([...discovered.map(a => a.sku.toLowerCase()), input.variants[0].sku.toLowerCase()])].sort()) await lock(tx, `sku:${sku}`);
    // Deterministic global SKU/article lock order, including collision aliases.
    await tx.select({ id: articles.id }).from(articles).where(inArray(sql`lower(${articles.sku})`,
      [...new Set([...discovered.map(a => a.sku.toLowerCase()), input.variants[0].sku.toLowerCase()])])).orderBy(asc(articles.id)).for("update");
    if (!discovered.length) fail("Unveröffentlichter Produktentwurf nicht gefunden", "NOT_FOUND");
    const ids = discovered.map(a => a.id);
    // Lock every fixed metadata row before complete reconstruction/hash. No
    // table lock/schema change and no unrelated business relation touched.
    await tx.select({ id: articleSeo.id }).from(articleSeo).where(inArray(articleSeo.articleId, ids)).orderBy(asc(articleSeo.id)).for("update");
    await tx.select({ id: articleMerchant.id }).from(articleMerchant).where(inArray(articleMerchant.articleId, ids)).orderBy(asc(articleMerchant.id)).for("update");
    await tx.select({ id: articleTranslations.id }).from(articleTranslations).where(inArray(articleTranslations.articleId, ids)).orderBy(asc(articleTranslations.id)).for("update");
    await tx.execute(sql`SELECT id FROM article_faq WHERE article_id IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)}) ORDER BY id FOR UPDATE`);
    if (schema.status.tables.article_use_cases) await tx.execute(sql`SELECT id FROM article_use_cases WHERE article_id IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)}) ORDER BY id FOR UPDATE`);
    const before = await readProductDraftData(tx, input.shopProductId);
    if ((await tx.select({ id: stockHistory.id }).from(stockHistory).where(inArray(stockHistory.articleId, before.articleIds)).orderBy(asc(stockHistory.id)).for("update")).length)
      fail("Nullbestand-Entwurf besitzt bereits Lagerbewegungen", "CONFLICT");
    const selected = input.variants[0], first = before.variants[0];
    if (before.masterArticleId !== input.masterArticleId || first.inventoryArticleId !== input.masterArticleId || first.sku !== selected.sku)
      fail("Auswahl muss exakt die erste Master-Entwurfsvariante sein", "CONFLICT");
    const aliases = await tx.select({ id: articles.id }).from(articles).where(sql`lower(${articles.sku}) = ${selected.sku.toLowerCase()}`);
    if (aliases.length !== 1 || aliases[0].id !== input.masterArticleId) fail("SKU fehlt oder ist mehrdeutig", "CONFLICT");
    const beforeSnapshotHash = draftSnapshotHash(before);
    if (beforeSnapshotHash !== input.expectedSnapshotHash) fail("Entwurf-Snapshot veraltet; getDraft erneut lesen", "CONFLICT");
    const { priceStatus: _open, ...stored } = first;
    const variant: FinalizedDraftVariant = { ...stored, price: selected.price, stock: selected.stock, publicationStatus: "finalized-draft" };
    const description = publicDescription(before.input, first);
    const now = new Date();
    const patch = { sellingPrice: selected.price.toFixed(2), description, variants: [variant], galleryImages: [first.imageUrl],
      notes: null, badge: /^(?:Entwurf|Unveröffentlichter Entwurf)$/i.test(before.master.badge ?? "") ? null : before.master.badge,
      shopVisible: 1, publishedAt: now, updatedAt: now };
    const prospective = { ...before.master, ...patch, stock: selected.stock };
    const validation = validateDraftPublication(before, prospective);
    // Stock starts at exactly zero under the same row lock. Never book component
    // inventory: these are actual single-vial inventory rows, not loose bundles.
    const movement = await applyStockMovement(tx, { articleId: input.masterArticleId, sku: selected.sku,
      expectedStock: 0, change: selected.stock, type: "wareneingang", reason: DRAFT_FINALIZATION_STOCK_REASON, actor: actor.slice(0, 100) });
    await tx.update(articles).set(patch).where(and(eq(articles.id, input.masterArticleId), eq(articles.shopProductId, input.shopProductId)));
    await tx.update(articleTranslations).set({ description, updatedAt: now }).where(eq(articleTranslations.id, before.translations[0].id));
    const availability = selected.stock > 0 ? "in_stock" : "out_of_stock";
    await tx.update(articleMerchant).set({ availability, updatedAt: now }).where(eq(articleMerchant.id, before.merchant.id));
    // Re-read all touched + untouched rows before mandatory audit to catch
    // triggers or unexpected storage mutation. Preserve every non-patch column.
    const afterRows = await tx.select().from(articles).where(inArray(articles.id, before.articleIds)).orderBy(asc(articles.id));
    const expectedRows = before.articles.map(a => a.id === input.masterArticleId ? prospective : a);
    const json = (v: unknown) => canonicalJson(JSON.parse(JSON.stringify(v)));
    if (json(afterRows) !== json(expectedRows)) fail("Finalisierung widerspricht exaktem Artikel-Snapshot", "CONFLICT");
    const [de] = await tx.select().from(articleTranslations).where(eq(articleTranslations.id, before.translations[0].id));
    const [merchant] = await tx.select().from(articleMerchant).where(eq(articleMerchant.id, before.merchant.id));
    if (json(de) !== json({ ...before.translations[0], description, updatedAt: now })
      || json(merchant) !== json({ ...before.merchant, availability, updatedAt: now })) fail("Finalisierung: DE/Merchant widersprüchlich", "CONFLICT");
    const response: FinalizeResponse = { success: true, shopProductId: input.shopProductId, masterArticleId: input.masterArticleId,
      articleIds: [input.masterArticleId], remainingDraftArticleIds: before.articleIds.filter(id => id !== input.masterArticleId),
      variants: [variant], shopVisible: true, priceStatus: "finalized", beforeSnapshotHash, validation,
      stockMovements: [{ articleId: input.masterArticleId, sku: selected.sku, ...movement }] };
    await audit(tx, input.masterArticleId, "FINALIZE_DRAFT", input.requestKey, prior.fingerprint, response, actor,
      { validation, selectedSkus: [selected.sku], remainingDraftArticleIds: response.remainingDraftArticleIds,
        initialStock: response.stockMovements, beforeSnapshotHash }, draftSnapshot(before));
    return response;
  });
}
