/**
 * Product Admin Router – 12 tRPC Procedures für den Product Manager Chat
 *
 * ZERO RISK:
 * - Kein Zugriff auf orders, customers, invoices, payments, checkout, users, migrations
 * - Nur Produktdaten: articles, article_seo, article_merchant, article_translations, product_audit_log
 * - Rollback betrifft ausschließlich Produktdaten
 * - Alle Procedures erfordern role = "admin" ODER role = "product_manager"
 *
 * Auth: Bearer Token (JWT) – kein Cookie nötig
 * Login: POST /api/auth/login → { token }
 */

import { z } from "zod";
import { and, eq, desc } from "drizzle-orm";
import { router, productManagerProcedure } from "./trpc.js";
import { getDb } from "./db.js";
import {
  articles,
  articleSeo,
  articleMerchant,
  articleTranslations,
  productAuditLog,
} from "../drizzle/schema.js";
import {validateProductData} from "./productValidation.js";
import { createFamilyInput, getFamilyInput, publishFamilyInput,
  createProductFamily, readFamily, publishProductFamily, createSingleBlendInput, publishSingleBlendInput,
  createSingleBlend, publishSingleBlend } from "./productFamily.js";
import { createProductDraftInput, createProductDraft, readProductDraft, isProductDraftArticle } from "./productDraft.js";
import { finalizeProductDraftInput, finalizeProductDraft } from "./productDraftFinalization.js";
import { getVariantReleaseInput, releaseProductVariantInput, readVariantReleaseSnapshot, releaseProductVariant } from "./productVariantRelease.js";

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

type DbType = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** Schreibt einen Eintrag in product_audit_log */
async function writeAuditLog(
  db: DbType,
  params: {
    articleId: number;
    action: string;
    fieldName?: string;
    oldValue?: unknown;
    newValue?: unknown;
    changedBy: string;
    rollbackData?: unknown;
  }
) {
  try {
    await db.insert(productAuditLog).values({
      articleId: params.articleId,
      action: params.action,
      fieldName: params.fieldName ?? null,
      oldValue: params.oldValue !== undefined ? JSON.stringify(params.oldValue) : null,
      newValue: params.newValue !== undefined ? JSON.stringify(params.newValue) : null,
      changedBy: params.changedBy,
      rollbackData: params.rollbackData !== undefined ? params.rollbackData as any : null,
    });
  } catch (err) {
    console.warn("[ProductAdmin] Failed to write audit log:", err);
  }
}

// ─────────────────────────────────────────────────────────────
// ROUTER
// ─────────────────────────────────────────────────────────────

export const productAdminRouter = router({

  getVariantReleaseSnapshot: productManagerProcedure.input(getVariantReleaseInput).query(async ({ input }) => {
    const db = await getDb();
    if (!db) throw new Error("DB nicht verfügbar");
    return readVariantReleaseSnapshot(db, input.shopProductId, input.masterArticleId);
  }),

  releaseVariant: productManagerProcedure.input(releaseProductVariantInput).mutation(async ({ input, ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("DB nicht verfügbar");
    return releaseProductVariant(db, input, ctx.user.username || ctx.user.email || "product_manager");
  }),

  // Draft-only additive API: zero stock, open price, hidden rows; no publication.
  createDraft: productManagerProcedure.input(createProductDraftInput).mutation(async ({ input, ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("DB nicht verfügbar");
    return createProductDraft(db, input, ctx.user.username || ctx.user.email || "product_manager");
  }),

  getDraft: productManagerProcedure.input(getFamilyInput).query(async ({ input }) => {
    const db = await getDb();
    if (!db) throw new Error("DB nicht verfügbar");
    return readProductDraft(db, input.shopProductId);
  }),

  // One existing first/master draft variant only; price/stock/publication/audit
  // commit together. Never route through legacy piecemeal article mutations.
  finalizeDraft: productManagerProcedure.input(finalizeProductDraftInput).mutation(async ({ input, ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("DB nicht verfügbar");
    return finalizeProductDraft(db, input, ctx.user.username || ctx.user.email || "product_manager");
  }),

  // Additive exact-family operations. Existing single-article procedures unchanged.
  createFamily: productManagerProcedure.input(createFamilyInput).mutation(async ({ input, ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("DB nicht verfügbar");
    return createProductFamily(db, input, ctx.user.username || ctx.user.email || "product_manager");
  }),

  getFamily: productManagerProcedure.input(getFamilyInput).query(async ({ input }) => {
    const db = await getDb();
    if (!db) throw new Error("DB nicht verfügbar");
    return db.transaction(tx => readFamily(tx, input.shopProductId), { isolationLevel: "repeatable read", accessMode: "read only" });
  }),

  publishFamily: productManagerProcedure.input(publishFamilyInput).mutation(async ({ input, ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("DB nicht verfügbar");
    return publishProductFamily(db, input, ctx.user.username || ctx.user.email || "product_manager");
  }),

  createSingleBlend: productManagerProcedure.input(createSingleBlendInput).mutation(async ({ input, ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("DB nicht verfügbar");
    return createSingleBlend(db, input, ctx.user.username || ctx.user.email || "product_manager");
  }),

  publishSingleBlend: productManagerProcedure.input(publishSingleBlendInput).mutation(async ({ input, ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("DB nicht verfügbar");
    return publishSingleBlend(db, input, ctx.user.username || ctx.user.email || "product_manager");
  }),

  // ─── 1. PREVIEW ────────────────────────────────────────────
  /** Vollständige Produktdaten für Preview (kein Schreiben) */
  preview: productManagerProcedure
    .input(z.object({ shopProductId: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB nicht verfügbar");

      const article = await db
        .select()
        .from(articles)
        .where(eq(articles.shopProductId, input.shopProductId))
        .limit(1);

      if (!article[0]) throw new Error(`Produkt '${input.shopProductId}' nicht gefunden`);

      const seo = await db
        .select()
        .from(articleSeo)
        .where(eq(articleSeo.articleId, article[0].id))
        .limit(1);

      const merchant = await db
        .select()
        .from(articleMerchant)
        .where(eq(articleMerchant.articleId, article[0].id))
        .limit(1);

      const translations = await db
        .select()
        .from(articleTranslations)
        .where(eq(articleTranslations.articleId, article[0].id));

      return {
        article: article[0],
        seo: seo[0] ?? null,
        merchant: merchant[0] ?? null,
        translations,
      };
    }),

  // ─── 2. UPDATE BASIC INFO ──────────────────────────────────
  /** Basisfelder: name, shortDescription, badge, casNumber, molecularWeight, purity */
  updateBasicInfo: productManagerProcedure
    .input(z.object({
      shopProductId: z.string(),
      name: z.string().min(1).max(200).optional(),
      description: z.string().optional(),
      shortDescription: z.string().max(500).optional(),
      badge: z.string().max(50).optional(),
      casNumber: z.string().max(50).optional(),
      molecularWeight: z.string().max(50).optional(),
      purity: z.string().max(50).optional(),
      notes: z.string().max(2000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("DB nicht verfügbar");

      const existing = await db
        .select()
        .from(articles)
        .where(eq(articles.shopProductId, input.shopProductId))
        .limit(1);

      if (!existing[0]) throw new Error(`Produkt '${input.shopProductId}' nicht gefunden`);

      const old = existing[0];
      const { shopProductId, ...updates } = input;

      // Nur definierte Felder aktualisieren
      const patch: Record<string, unknown> = {};
      if (updates.name !== undefined) patch.name = updates.name;
      if (updates.description !== undefined) patch.description = updates.description;
      if (updates.shortDescription !== undefined) patch.shortDescription = updates.shortDescription;
      if (updates.badge !== undefined) patch.badge = updates.badge;
      if (updates.casNumber !== undefined) patch.casNumber = updates.casNumber;
      if (updates.molecularWeight !== undefined) patch.molecularWeight = updates.molecularWeight;
      if (updates.purity !== undefined) patch.purity = updates.purity;
      if (updates.notes !== undefined) patch.notes = updates.notes;

      if (Object.keys(patch).length === 0) return { success: true, message: "Keine Änderungen" };

      await db.update(articles).set(patch as any).where(eq(articles.id, old.id));

      await writeAuditLog(db, {
        articleId: old.id,
        action: "UPDATE_BASIC_INFO",
        oldValue: Object.fromEntries(Object.keys(patch).map(k => [k, (old as any)[k]])),
        newValue: patch,
        changedBy: ctx.user?.email ?? "product_manager",
        rollbackData: Object.fromEntries(Object.keys(patch).map(k => [k, (old as any)[k]])),
      });

      return { success: true, articleId: old.id };
    }),

  // ─── 3. UPDATE PRICING ────────────────────────────────────
  /** Preise: sellingPrice, salePrice, saleActive – KEIN Zugriff auf purchasePrice */
  updatePricing: productManagerProcedure
    .input(z.object({
      shopProductId: z.string(),
      sellingPrice: z.number().min(0).max(9999).optional(),
      salePrice: z.number().min(0).max(9999).optional().nullable(),
      saleActive: z.boolean().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("DB nicht verfügbar");

      const existing = await db
        .select()
        .from(articles)
        .where(eq(articles.shopProductId, input.shopProductId))
        .limit(1);

      if (!existing[0]) throw new Error(`Produkt '${input.shopProductId}' nicht gefunden`);
      const old = existing[0];

      // LIMIT 1 may return a preserved hidden sibling after master promotion.
      // Preserve the existing restriction for the entire finalized family.
      const familyVariants = await db.select({ variants: articles.variants }).from(articles)
        .where(eq(articles.shopProductId, input.shopProductId));
      if (familyVariants.some(a => Array.isArray(a.variants) && a.variants.some(v => v?.publicationStatus === "finalized-draft")))
        throw new Error("Finalisierte Entwurfsvariante benötigt einen separaten atomaren Preisvertrag.");
      // Validierung: salePrice muss kleiner als sellingPrice sein
      const newSellingPrice = input.sellingPrice ?? Number(old.sellingPrice ?? 0);
      const newSalePrice = input.salePrice !== undefined ? input.salePrice : null;
      if (newSalePrice !== null && newSalePrice !== undefined && newSalePrice >= newSellingPrice) {
        throw new Error(`Aktionspreis (${newSalePrice}) muss kleiner als Verkaufspreis (${newSellingPrice}) sein`);
      }

      const patch: Record<string, unknown> = {};
      if (input.sellingPrice !== undefined) patch.sellingPrice = String(input.sellingPrice);
      if (input.salePrice !== undefined) patch.salePrice = input.salePrice !== null ? String(input.salePrice) : null;
      if (input.saleActive !== undefined) patch.saleActive = input.saleActive ? 1 : 0;

      if (Object.keys(patch).length === 0) return { success: true, message: "Keine Änderungen" };

      await db.update(articles).set(patch as any).where(eq(articles.id, old.id));

      await writeAuditLog(db, {
        articleId: old.id,
        action: "UPDATE_PRICING",
        oldValue: { sellingPrice: old.sellingPrice, salePrice: (old as any).salePrice, saleActive: (old as any).saleActive },
        newValue: patch,
        changedBy: ctx.user?.email ?? "product_manager",
        rollbackData: { sellingPrice: old.sellingPrice, salePrice: (old as any).salePrice, saleActive: (old as any).saleActive },
      });

      return { success: true, articleId: old.id };
    }),

  // ─── 4. UPDATE SEO ────────────────────────────────────────
  /** SEO: seoTitle, seoDescription, seoKeywords, schemaJson – pro Sprache */
  updateSeo: productManagerProcedure
    .input(z.object({
      shopProductId: z.string(),
      lang: z.string().default("de"),
      slug: z.string().max(200).optional(),
      seoTitle: z.string().max(70).optional(),
      seoDescription: z.string().max(160).optional(),
      seoKeywords: z.string().max(500).optional(),
      canonical: z.string().max(500).optional(),
      ogImage: z.string().max(500).optional(),
      schemaJson: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("DB nicht verfügbar");

      const article = await db
        .select()
        .from(articles)
        .where(eq(articles.shopProductId, input.shopProductId))
        .limit(1);

      if (!article[0]) throw new Error(`Produkt '${input.shopProductId}' nicht gefunden`);

      const existing = await db
        .select()
        .from(articleSeo)
        .where(eq(articleSeo.articleId, article[0].id))
        .limit(1);

      const patch: Record<string, unknown> = { articleId: article[0].id };
      if (input.seoTitle !== undefined) patch.seoTitle = input.seoTitle;
      if (input.seoDescription !== undefined) patch.seoDescription = input.seoDescription;
      if (input.seoKeywords !== undefined) patch.seoKeywords = input.seoKeywords;
      if (input.canonical !== undefined) patch.canonical = input.canonical;
      if (input.ogImage !== undefined) patch.ogImage = input.ogImage;
      if (input.schemaJson !== undefined) patch.schemaJson = input.schemaJson;

      if (existing[0]) {
        if (input.slug !== undefined) patch.slug = input.slug;
        await db.update(articleSeo).set(patch as any).where(eq(articleSeo.id, existing[0].id));
      } else {
        patch.slug = input.slug ?? input.shopProductId.toLowerCase().replace(/[^a-z0-9-]/g, '-');
        await db.insert(articleSeo).values(patch as any);
      }

      await writeAuditLog(db, {
        articleId: article[0].id,
        action: "UPDATE_SEO",
        oldValue: existing[0] ?? null,
        newValue: patch,
        changedBy: ctx.user?.email ?? "product_manager",
      });

      return { success: true, articleId: article[0].id };
    }),

  // ─── 5. UPDATE MERCHANT ───────────────────────────────────
  /** Merchant Feed: title, description, availability, condition, imageLink, gtin, mpn */
  updateMerchant: productManagerProcedure
    .input(z.object({
      shopProductId: z.string(),
      lang: z.string().default("de"),
      merchantTitle: z.string().max(150).optional(),
      merchantDescription: z.string().max(5000).optional(),
      availability: z.enum(["in_stock", "out_of_stock", "preorder"]).optional(),
      condition: z.enum(["new", "refurbished", "used"]).optional(),
      imageLink: z.string().url().optional(),
      gtin: z.string().max(14).optional(),
      mpn: z.string().max(70).optional(),
      brand: z.string().max(70).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("DB nicht verfügbar");

      const article = await db
        .select()
        .from(articles)
        .where(eq(articles.shopProductId, input.shopProductId))
        .limit(1);

      if (!article[0]) throw new Error(`Produkt '${input.shopProductId}' nicht gefunden`);

      const existing = await db
        .select()
        .from(articleMerchant)
        .where(eq(articleMerchant.articleId, article[0].id))
        .limit(1);

      const patch: Record<string, unknown> = { articleId: article[0].id };
      if (input.merchantTitle !== undefined) patch.merchantTitle = input.merchantTitle;
      if (input.merchantDescription !== undefined) patch.merchantDescription = input.merchantDescription;
      if (input.availability !== undefined) patch.availability = input.availability;
      if (input.condition !== undefined) patch.condition = input.condition;
      if (input.imageLink !== undefined) patch.imageLink = input.imageLink;
      if (input.gtin !== undefined) patch.gtin = input.gtin;
      if (input.mpn !== undefined) patch.mpn = input.mpn;
      if (input.brand !== undefined) patch.brand = input.brand;

      if (existing[0]) {
        await db.update(articleMerchant).set(patch as any).where(eq(articleMerchant.id, existing[0].id));
      } else {
        await db.insert(articleMerchant).values(patch as any);
      }

      await writeAuditLog(db, {
        articleId: article[0].id,
        action: "UPDATE_MERCHANT",
        oldValue: existing[0] ?? null,
        newValue: patch,
        changedBy: ctx.user?.email ?? "product_manager",
      });

      return { success: true, articleId: article[0].id };
    }),

  // ─── 6. UPDATE TRANSLATION ────────────────────────────────
  /** Übersetzung: name, description, shortDescription – pro Sprache */
  updateTranslation: productManagerProcedure
    .input(z.object({
      shopProductId: z.string(),
      lang: z.string().min(2).max(5),
      name: z.string().max(200).optional(),
      description: z.string().optional(),
      shortDescription: z.string().max(500).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("DB nicht verfügbar");

      const article = await db
        .select()
        .from(articles)
        .where(eq(articles.shopProductId, input.shopProductId))
        .limit(1);

      if (!article[0]) throw new Error(`Produkt '${input.shopProductId}' nicht gefunden`);

      const existing = await db
        .select()
        .from(articleTranslations)
        .where(eq(articleTranslations.articleId, article[0].id))
        .limit(1);

      const patch: Record<string, unknown> = { articleId: article[0].id, lang: input.lang };
      if (input.name !== undefined) patch.name = input.name;
      if (input.description !== undefined) patch.description = input.description;
      if (input.shortDescription !== undefined) patch.shortDescription = input.shortDescription;

      if (existing[0]) {
        await db.update(articleTranslations).set(patch as any).where(eq(articleTranslations.id, existing[0].id));
      } else {
        await db.insert(articleTranslations).values(patch as any);
      }

      await writeAuditLog(db, {
        articleId: article[0].id,
        action: "UPDATE_TRANSLATION",
        fieldName: `lang:${input.lang}`,
        oldValue: existing[0] ?? null,
        newValue: patch,
        changedBy: ctx.user?.email ?? "product_manager",
      });

      return { success: true, articleId: article[0].id };
    }),

  // ─── 7. UPDATE IMAGES ─────────────────────────────────────
  /** Bilder: mockupImageUrl, labelImageUrl, labReportImageUrl, galleryImages – nur URL-Felder, kein Upload */
  updateImages: productManagerProcedure
    .input(z.object({
      shopProductId: z.string(),
      mockupImageUrl: z.string().url().optional().nullable(),
      labelImageUrl: z.string().url().optional().nullable(),
      labReportImageUrl: z.string().url().optional().nullable(),
      galleryImages: z.array(z.string().url()).optional().nullable(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("DB nicht verfügbar");

      const existing = await db
        .select()
        .from(articles)
        .where(eq(articles.shopProductId, input.shopProductId))
        .limit(1);

      if (!existing[0]) throw new Error(`Produkt '${input.shopProductId}' nicht gefunden`);
      const old = existing[0];

      const patch: Record<string, unknown> = {};
      if (input.mockupImageUrl !== undefined) patch.mockupImageUrl = input.mockupImageUrl;
      if (input.labelImageUrl !== undefined) patch.labelImageUrl = input.labelImageUrl;
      if (input.labReportImageUrl !== undefined) patch.labReportImageUrl = input.labReportImageUrl;
      if (input.galleryImages !== undefined) patch.galleryImages = input.galleryImages;

      if (Object.keys(patch).length === 0) return { success: true, message: "Keine Änderungen" };

      await db.update(articles).set(patch as any).where(eq(articles.id, old.id));

      await writeAuditLog(db, {
        articleId: old.id,
        action: "UPDATE_IMAGES",
        oldValue: { mockupImageUrl: old.mockupImageUrl, labelImageUrl: old.labelImageUrl, labReportImageUrl: old.labReportImageUrl },
        newValue: patch,
        changedBy: ctx.user?.email ?? "product_manager",
        rollbackData: { mockupImageUrl: old.mockupImageUrl, labelImageUrl: old.labelImageUrl, labReportImageUrl: old.labReportImageUrl },
      });

      return { success: true, articleId: old.id };
    }),

  // ─── 8. TOGGLE SHOP VISIBLE ───────────────────────────────
  /** Shop-Sichtbarkeit: shopVisible ein/ausschalten */
  toggleShopVisible: productManagerProcedure
    .input(z.object({
      shopProductId: z.string(),
      visible: z.boolean(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("DB nicht verfügbar");

      const existing = await db
        .select()
        .from(articles)
        .where(eq(articles.shopProductId, input.shopProductId))
        .limit(1);

      if (!existing[0]) throw new Error(`Produkt '${input.shopProductId}' nicht gefunden`);
      const old = existing[0];

      if (input.visible && isProductDraftArticle(old)) {
        throw new Error("Unvollständiger Produktentwurf: Preis und Produktfreigabe müssen zuerst bestätigt werden.");
      }

      await db.update(articles)
        .set({ shopVisible: input.visible ? 1 : 0 } as any)
        .where(eq(articles.id, old.id));

      await writeAuditLog(db, {
        articleId: old.id,
        action: input.visible ? "PUBLISH" : "UNPUBLISH",
        fieldName: "shopVisible",
        oldValue: old.shopVisible,
        newValue: input.visible ? 1 : 0,
        changedBy: ctx.user?.email ?? "product_manager",
        rollbackData: { shopVisible: old.shopVisible },
      });

      return { success: true, articleId: old.id, shopVisible: input.visible };
    }),

  // ─── 9. GET AUDIT LOG ─────────────────────────────────────
  /** Audit-Log für ein Produkt – letzte 50 Einträge */
  getAuditLog: productManagerProcedure
    .input(z.object({
      shopProductId: z.string(),
      articleId: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB nicht verfügbar");

      const article = await db
        .select()
        .from(articles)
        .where(input.articleId === undefined ? eq(articles.shopProductId, input.shopProductId)
          : and(eq(articles.shopProductId, input.shopProductId), eq(articles.id, input.articleId)))
        .limit(1);

      if (!article[0]) throw new Error(`Produkt '${input.shopProductId}' nicht gefunden`);

      const logs = await db
        .select()
        .from(productAuditLog)
        .where(eq(productAuditLog.articleId, article[0].id))
        .orderBy(desc(productAuditLog.changedAt))
        .limit(input.limit);

      return logs;
    }),

  // ─── 10. ROLLBACK ─────────────────────────────────────────
  /** Rollback: Stellt Produktdaten auf Stand eines Audit-Log-Eintrags zurück */
  rollback: productManagerProcedure
    .input(z.object({
      auditLogId: z.number().int().positive(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("DB nicht verfügbar");

      const logEntry = await db
        .select()
        .from(productAuditLog)
        .where(eq(productAuditLog.id, input.auditLogId))
        .limit(1);

      if (!logEntry[0]) throw new Error(`Audit-Log-Eintrag #${input.auditLogId} nicht gefunden`);
      if (!logEntry[0].rollbackData) throw new Error("Kein Rollback-Snapshot für diesen Eintrag vorhanden");

      const rollbackData = logEntry[0].rollbackData as Record<string, unknown>;

      // Nur articles-Felder zurückrollen (KEIN Zugriff auf orders/customers/invoices)
      const safeFields = ["name", "shortDescription", "badge", "casNumber", "molecularWeight",
        "purity", "notes", "sellingPrice", "salePrice", "saleActive", "mockupImageUrl",
        "labelImageUrl", "shopVisible"];

      const patch: Record<string, unknown> = {};
      for (const field of safeFields) {
        if (rollbackData[field] !== undefined) patch[field] = rollbackData[field];
      }

      if (Object.keys(patch).length === 0) {
        return { success: false, message: "Keine rollback-fähigen Felder im Snapshot" };
      }

      await db.update(articles).set(patch as any).where(eq(articles.id, logEntry[0].articleId));

      await writeAuditLog(db, {
        articleId: logEntry[0].articleId,
        action: "ROLLBACK",
        fieldName: `rollback_to_audit_log_${input.auditLogId}`,
        newValue: patch,
        changedBy: ctx.user?.email ?? "product_manager",
      });

      return { success: true, articleId: logEntry[0].articleId, restoredFields: Object.keys(patch) };
    }),

  // ─── 11. LIST PRODUCTS ────────────────────────────────────
  /** Alle Produkte auflisten (nur Produktfelder, kein orders/customers) */
  listProducts: productManagerProcedure
    .input(z.object({
      shopOnly: z.boolean().default(true),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB nicht verfügbar");

      const result = await db
        .select({
          id: articles.id,
          sku: articles.sku,
          name: articles.name,
          shopProductId: articles.shopProductId,
          sellingPrice: articles.sellingPrice,
          stock: articles.stock,
          shopVisible: articles.shopVisible,
          category: articles.category,
          badge: articles.badge,
          shortDescription: articles.shortDescription,
          mockupImageUrl: articles.mockupImageUrl,
        })
        .from(articles)
        .orderBy(articles.name);

      if (input.shopOnly) {
        return result.filter(a => a.shopProductId);
      }
      return result;
    }),

  // ─── 12. VALIDATE PRODUCT ─────────────────────────────────
  /** Validierung: Prüft ob Produkt bereit für Google Shopping / Merchant Center */
  validateProduct: productManagerProcedure
    .input(z.object({ shopProductId: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB nicht verfügbar");
      if (input.shopProductId === "somatide") {
        const family = await db.transaction(tx => readFamily(tx, input.shopProductId),
          { isolationLevel: "repeatable read", accessMode: "read only" });
        if (!family.master) throw new Error(`Produkt '${input.shopProductId}' nicht gefunden`);
        return family.validation;
      }

      const article = await db
        .select()
        .from(articles)
        .where(eq(articles.shopProductId, input.shopProductId))
        .limit(1);

      if (!article[0]) throw new Error(`Produkt '${input.shopProductId}' nicht gefunden`);

      const seo = await db
        .select()
        .from(articleSeo)
        .where(eq(articleSeo.articleId, article[0].id))
        .limit(1);

      const merchant = await db
        .select()
        .from(articleMerchant)
        .where(eq(articleMerchant.articleId, article[0].id))
        .limit(1);

      const deTranslation = await db
        .select()
        .from(articleTranslations)
        .where(eq(articleTranslations.articleId, article[0].id))
        .limit(1);

      return validateProductData(article[0],seo[0],merchant[0],deTranslation[0]);
    }),
});
