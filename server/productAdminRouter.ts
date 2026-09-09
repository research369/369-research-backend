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

  // ─── 4. UPDATE VARIANTS ───────────────────────────────────
  /**
   * Variantenvertrag: nur am explizit ausgewählten Stammartikel.
   * Jeder aktive Eintrag muss auf einen aktiven Lagerartikel derselben
   * Produktfamilie verweisen. Preise, Bestand und Sichtbarkeit bleiben dabei
   * unverändert; es wird ausschließlich das variants-JSON normalisiert.
   */
  updateVariants: productManagerProcedure
    .input(z.object({
      articleId: z.number().int().positive(),
      shopProductId: z.string().min(1),
      variants: z.array(z.object({
        sku: z.string().min(1).max(100),
        name: z.string().min(1).max(100).optional(),
        label: z.string().min(1).max(100),
        price: z.number().positive().max(9999),
        dosage: z.string().min(1).max(100),
        isActive: z.boolean().default(true),
        inventoryArticleId: z.number().int().positive(),
      })).min(1).max(50),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("DB nicht verfügbar");

      const existing = await db
        .select()
        .from(articles)
        .where(and(eq(articles.id, input.articleId), eq(articles.shopProductId, input.shopProductId)))
        .limit(1);
      const article = existing[0];
      if (!article) {
        throw new Error("Stammartikel passt nicht zur angegebenen Produktfamilie");
      }

      const activeVariants = input.variants.filter(variant => variant.isActive);
      if (activeVariants.length === 0) {
        throw new Error("Mindestens eine aktive Variante ist erforderlich");
      }
      const seenSkus = new Set<string>();
      const seenInventoryIds = new Set<number>();
      for (const variant of activeVariants) {
        if (seenSkus.has(variant.sku)) {
          throw new Error(`Doppelte Varianten-SKU: ${variant.sku}`);
        }
        if (seenInventoryIds.has(variant.inventoryArticleId)) {
          throw new Error(`Doppelte Lagerartikel-ID: ${variant.inventoryArticleId}`);
        }
        seenSkus.add(variant.sku);
        seenInventoryIds.add(variant.inventoryArticleId);
      }

      const inventoryRows = await db
        .select({
          id: articles.id,
          sku: articles.sku,
          shopProductId: articles.shopProductId,
          isActive: articles.isActive,
        })
        .from(articles);
      const inventoryById = new Map(inventoryRows.map(row => [row.id, row]));
      for (const variant of activeVariants) {
        const inventory = inventoryById.get(variant.inventoryArticleId);
        if (!inventory) {
          throw new Error(`Lagerartikel ${variant.inventoryArticleId} nicht gefunden`);
        }
        if (inventory.shopProductId !== input.shopProductId) {
          throw new Error(`Lagerartikel ${variant.inventoryArticleId} gehört nicht zur Produktfamilie`);
        }
        if (inventory.sku !== variant.sku) {
          throw new Error(`SKU ${variant.sku} passt nicht zu Lagerartikel ${variant.inventoryArticleId}`);
        }
        if (inventory.isActive !== 1) {
          throw new Error(`Lagerartikel ${variant.inventoryArticleId} ist inaktiv`);
        }
      }

      await db.update(articles)
        .set({ variants: input.variants as any })
        .where(eq(articles.id, article.id));
      await writeAuditLog(db, {
        articleId: article.id,
        action: "UPDATE_VARIANTS",
        fieldName: "variants",
        oldValue: { variants: article.variants },
        newValue: { variants: input.variants },
        changedBy: ctx.user?.email ?? "product_manager",
        rollbackData: { variants: article.variants },
      });
      return { success: true, articleId: article.id, variantCount: input.variants.length };
    }),

  // ─── 5. UPDATE SEO ────────────────────────────────────────
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
      description: z.union([z.string(), z.record(z.unknown()), z.array(z.unknown()), z.null()]).optional(),
      shortDescription: z.string().max(500).optional(),
      seoTitle: z.string().max(70).optional(),
      seoDescription: z.string().max(160).optional(),
      merchantTitle: z.string().max(150).optional(),
      merchantDescription: z.string().max(5000).optional(),
      imageAlt: z.string().max(200).optional(),
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
        .where(
          and(
            eq(articleTranslations.articleId, article[0].id),
            eq(articleTranslations.lang, input.lang),
          ),
        )
        .limit(1);

      const patch: Record<string, unknown> = { articleId: article[0].id, lang: input.lang };
      if (input.name !== undefined) patch.name = input.name;
      if (input.description !== undefined) patch.description = input.description;
      if (input.shortDescription !== undefined) patch.shortDescription = input.shortDescription;
      if (input.seoTitle !== undefined) patch.seoTitle = input.seoTitle;
      if (input.seoDescription !== undefined) patch.seoDescription = input.seoDescription;
      if (input.merchantTitle !== undefined) patch.merchantTitle = input.merchantTitle;
      if (input.merchantDescription !== undefined) patch.merchantDescription = input.merchantDescription;
      if (input.imageAlt !== undefined) patch.imageAlt = input.imageAlt;

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
      limit: z.number().int().min(1).max(200).default(50),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB nicht verfügbar");

      const article = await db
        .select()
        .from(articles)
        .where(eq(articles.shopProductId, input.shopProductId))
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

      const issues: string[] = [];
      const warnings: string[] = [];

      // === PFLICHTFELDER (blockieren Speicherung) ===
      if (!article[0].name) issues.push("Produktname fehlt");
      if (!article[0].sku) issues.push("SKU fehlt");
      if (!article[0].shopProductId) issues.push("shopProductId fehlt");
      if (!article[0].sellingPrice || Number(article[0].sellingPrice) <= 0) issues.push("Verkaufspreis fehlt oder 0");
      if (article[0].stock === null || article[0].stock === undefined || article[0].stock < 0) issues.push("Bestand darf nicht negativ sein");
      if (!article[0].mockupImageUrl) issues.push("Hauptbild fehlt (mockupImageUrl)");
      if (!seo[0]) issues.push("SEO-Eintrag fehlt (kein Slug vorhanden)");
      if (seo[0] && !seo[0].slug) issues.push("Slug fehlt");
      if (!seo[0]?.seoTitle) issues.push("SEO Title fehlt (max. 60 Zeichen)");
      if (!seo[0]?.seoDescription) issues.push("Meta Description fehlt (max. 155 Zeichen)");

      // === PREISLOGIK ===
      const sp = Number(article[0].sellingPrice ?? 0);
      const sale = article[0].salePrice ? Number(article[0].salePrice) : null;
      if (sale !== null && sale >= sp) issues.push(`Sale Price (${sale} €) muss kleiner als Verkaufspreis (${sp} €) sein`);

      // === SEO LÄNGEN-CHECKS ===
      if (seo[0]?.seoTitle && seo[0].seoTitle.length > 60) warnings.push(`SEO Title zu lang: ${seo[0].seoTitle.length} Zeichen (max. 60)`);
      if (seo[0]?.seoDescription && seo[0].seoDescription.length > 155) warnings.push(`Meta Description zu lang: ${seo[0].seoDescription.length} Zeichen (max. 155)`);

      // === CANONICAL URL ===
      if (seo[0]?.canonical && !seo[0].canonical.startsWith("https://www.369research.eu")) {
        warnings.push(`Canonical URL sollte mit https://www.369research.eu beginnen`);
      }

      // === MERCHANT CHECKS ===
      if (!merchant[0]) warnings.push("Merchant-Eintrag fehlt");
      if (!deTranslation[0]?.merchantTitle) warnings.push("Merchant Title fehlt (DE)");
      if (!deTranslation[0]?.merchantDescription) warnings.push("Merchant Description fehlt (DE)");
      if (!merchant[0]?.availability) warnings.push("Verfügbarkeit nicht gesetzt (Standard: in_stock)");
      if (!merchant[0]?.productType) warnings.push("Product Type fehlt (Google Shopping)");
      if (!merchant[0]?.googleProductCategory) warnings.push("Google Product Category fehlt");

      // === KATEGORIE ===
      const cats = article[0].categories as unknown[];
      if (!article[0].category && (!cats || cats.length === 0)) {
        warnings.push("Keine Kategorie gesetzt");
      }

      // === COMPLIANCE CHECKS ===
      const descText = JSON.stringify(article[0].description ?? "").toLowerCase();
      const shortDesc = (article[0].shortDescription ?? "").toLowerCase();
      const allText = descText + " " + shortDesc;
      const forbiddenPhrases = ["dosierung", "einnahme", "nehmen sie", "täglich einnehmen", "heilt", "behandelt", "therapie", "heilmittel"];
      for (const phrase of forbiddenPhrases) {
        if (allText.includes(phrase)) {
          warnings.push(`Möglicher Human-Use Hinweis: "${phrase}" – bitte prüfen`);
        }
      }
      const hasResearchNote = allText.includes("research use only") || allText.includes("forschungszwecke") || allText.includes("not for human use");
      if (!hasResearchNote) warnings.push("Research Use Only Hinweis fehlt im Produkttext");

      // === OPTIONALE EMPFEHLUNGEN ===
      if (!article[0].casNumber) warnings.push("CAS-Nummer fehlt (empfohlen für Peptide)");
      if (!article[0].shortDescription) warnings.push("Kurzbeschreibung fehlt");
      if (!article[0].purity) warnings.push("Reinheitsangabe fehlt");

      const totalChecks = 18;
      const score = Math.max(0, Math.round(((totalChecks - issues.length * 2 - warnings.length * 0.5) / totalChecks) * 100));

      return {
        shopProductId: input.shopProductId,
        name: article[0].name,
        sku: article[0].sku,
        sellingPrice: article[0].sellingPrice,
        salePrice: article[0].salePrice,
        stock: article[0].stock,
        slug: seo[0]?.slug ?? null,
        seoTitle: seo[0]?.seoTitle ?? null,
        seoDescription: seo[0]?.seoDescription ?? null,
        merchantTitle: deTranslation[0]?.merchantTitle ?? null,
        merchantDescription: deTranslation[0]?.merchantDescription ?? null,
        hasImage: !!article[0].mockupImageUrl,
        hasResearchNote,
        isValid: issues.length === 0,
        issues,
        warnings,
        score,
      };
    }),
});
