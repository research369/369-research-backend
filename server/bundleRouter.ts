/**
 * Bundle Router – tRPC routes for the 369 Research Bundle System
 * 27 Forscher-Bundles across 8 categories (MASS, LEAN, RECOVERY, MITO, GLOW, MIND, LOOKS, CAPS)
 */
import { z } from "zod";
import { eq, asc, sql } from "drizzle-orm";
import { router, publicProcedure, adminProcedure } from "./trpc.js";
import { getDb, getPool } from "./db.js";
import { bundles, bundleItems, articles } from "../drizzle/schema.js";

// ============================================================
// Bundle Router
// ============================================================
export const bundleRouter = router({

  /**
   * PUBLIC: Get all active bundles with their items and article details
   * Used by the shop frontend to render the bundle catalog
   */
  getAll: publicProcedure
    .input(z.object({
      category: z.string().optional(), // filter by category
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      // Fetch bundles
      let bundleQuery = db
        .select()
        .from(bundles)
        .where(eq(bundles.isActive, 1))
        .orderBy(asc(bundles.sortOrder));

      const allBundles = await bundleQuery;

      // Filter by category if provided
      const filteredBundles = input?.category
        ? allBundles.filter(b => b.category === input.category)
        : allBundles;

      if (filteredBundles.length === 0) return [];

      // Fetch all bundle items for these bundles
      const bundleIds = filteredBundles.map(b => b.id);
      const allItems = await db
        .select({
          id: bundleItems.id,
          bundleId: bundleItems.bundleId,
          articleSku: bundleItems.articleSku,
          quantity: bundleItems.quantity,
          isFreeGift: bundleItems.isFreeGift,
          isTablet: bundleItems.isTablet,
          fixedDosageMg: bundleItems.fixedDosageMg,
          sortOrder: bundleItems.sortOrder,
        })
        .from(bundleItems)
        .where(sql`${bundleItems.bundleId} = ANY(ARRAY[${sql.join(bundleIds.map(id => sql`${id}`), sql`, `)}]::int[])`)
        .orderBy(asc(bundleItems.sortOrder));

      // Fetch article details for all SKUs
      const skus = [...new Set(allItems.map(i => i.articleSku))];
      const articleDetails = skus.length > 0
        ? await db
          .select({
            sku: articles.sku,
            name: articles.name,
            sellingPrice: articles.sellingPrice,
            stock: articles.stock,
            categories: articles.categories,
            mockupImageUrl: articles.mockupImageUrl,
            shortDescription: articles.shortDescription,
            variants: articles.variants,
          })
          .from(articles)
          .where(sql`${articles.sku} = ANY(ARRAY[${sql.join(skus.map(s => sql`${s}`), sql`, `)}])`)
        : [];

      const articleMap = new Map(articleDetails.map(a => [a.sku, a]));

      // Build stock map for ALL articles (for per-variant stock check)
      // SKU pattern: SUBSTANZ-XMGX → we load all articles to check variant stock
      // Variant "5 mg" of BPC-157-10MG corresponds to BPC-157-5MG
      const allArticlesForStock = await db
        .select({ sku: articles.sku, stock: articles.stock })
        .from(articles);
      const globalStockMap = new Map(allArticlesForStock.map(a => [a.sku, a.stock ?? 0]));

      // Helper: derive variant SKU from base SKU + dosage label
      // e.g. BPC-157-10MG + "5 mg" → BPC-157-5MG
      function getVariantSku(baseSku: string, dosageLabel: string): string {
        // Remove trailing dosage from base SKU (e.g. "-10MG", "-1MG", "-100MG")
        const basePrefix = baseSku.replace(/-\d+(\.\d+)?MG$/i, '');
        // Convert dosage label to SKU suffix (e.g. "5 mg" → "5MG", "1500 mg" → "1500MG")
        const suffix = dosageLabel.replace(/\s+/g, '').toUpperCase();
        return `${basePrefix}-${suffix}`;
      }

      // Assemble result
      return filteredBundles.map(bundle => {
        const items = allItems
          .filter(i => i.bundleId === bundle.id)
          .map(item => {
            const art = articleMap.get(item.articleSku) ?? null;
            // Enrich variants with inStock flag
            const enrichedVariants = art?.variants
              ? (art.variants as Array<{ label: string; price: number; dosage?: string }>).map(v => {
                  const variantSku = getVariantSku(item.articleSku, v.label);
                  const variantStock = globalStockMap.get(variantSku);
                  // If variant SKU not found, fall back to main article stock
                  const inStock = variantStock !== undefined ? variantStock > 0 : (art.stock ?? 0) > 0;
                  return { ...v, inStock, variantSku };
                })
              : art?.variants;
            return {
              ...item,
              article: art ? { ...art, variants: enrichedVariants } : null,
            };
          });

        // Calculate base price (sum of non-free items at full price)
        const basePrice = items
          .filter(i => !i.isFreeGift)
          .reduce((sum, item) => {
            const price = parseFloat(item.article?.sellingPrice ?? "0");
            return sum + price * item.quantity;
          }, 0);

        const discountMultiplier = 1 - parseFloat(bundle.discountPercent ?? "0") / 100;
        const discountedPrice = basePrice * discountMultiplier;

        return {
          ...bundle,
          items,
          basePrice: Math.round(basePrice * 100) / 100,
          discountedPrice: Math.round(discountedPrice * 100) / 100,
          savings: Math.round((basePrice - discountedPrice) * 100) / 100,
        };
      });
    }),

  /**
   * PUBLIC: Get a single bundle by slug with full details
   */
  getBySlug: publicProcedure
    .input(z.object({ slug: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;

      const [bundle] = await db
        .select()
        .from(bundles)
        .where(eq(bundles.slug, input.slug))
        .limit(1);

      if (!bundle) return null;

      const items = await db
        .select()
        .from(bundleItems)
        .where(eq(bundleItems.bundleId, bundle.id))
        .orderBy(asc(bundleItems.sortOrder));

      const skus = items.map(i => i.articleSku);
      const articleDetails = skus.length > 0
        ? await db
          .select()
          .from(articles)
          .where(sql`${articles.sku} = ANY(ARRAY[${sql.join(skus.map(s => sql`${s}`), sql`, `)}])`)
        : [];

      const articleMap = new Map(articleDetails.map(a => [a.sku, a]));

      const enrichedItems = items.map(item => ({
        ...item,
        article: articleMap.get(item.articleSku) ?? null,
      }));

      const basePrice = enrichedItems
        .filter(i => !i.isFreeGift)
        .reduce((sum, item) => {
          const price = parseFloat(item.article?.sellingPrice ?? "0");
          return sum + price * item.quantity;
        }, 0);

      const discountMultiplier = 1 - parseFloat(bundle.discountPercent ?? "0") / 100;
      const discountedPrice = basePrice * discountMultiplier;

      return {
        ...bundle,
        items: enrichedItems,
        basePrice: Math.round(basePrice * 100) / 100,
        discountedPrice: Math.round(discountedPrice * 100) / 100,
        savings: Math.round((basePrice - discountedPrice) * 100) / 100,
      };
    }),

  /**
   * PUBLIC: Get available pen colors (check stock)
   * Returns only pens that are in stock
   */
  getPenOptions: publicProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];

    const penSkus = ['PEN-BLAU', 'PEN-LILA', 'PEN-ROSA', 'PEN-GOLD'];
    const pens = await db
      .select({
        sku: articles.sku,
        name: articles.name,
        sellingPrice: articles.sellingPrice,
        stock: articles.stock,
        mockupImageUrl: articles.mockupImageUrl,
      })
      .from(articles)
      .where(sql`${articles.sku} = ANY(ARRAY[${sql.join(penSkus.map(s => sql`${s}`), sql`, `)}])`);

    return pens
      .filter(p => (p.stock ?? 0) > 0)
      .map(p => ({
        sku: p.sku,
        name: p.name,
        price: parseFloat(p.sellingPrice ?? "39"),
        stock: p.stock ?? 0,
        color: p.sku.replace('PEN-', '').toLowerCase(), // blau, lila, rosa, gold
        imageUrl: p.mockupImageUrl ?? null,
      }));
  }),

  /**
   * ADMIN: Update bundle (image, active status, description)
   */
  update: adminProcedure
    .input(z.object({
      id: z.number(),
      imageUrl: z.string().optional(),
      isActive: z.boolean().optional(),
      description: z.string().optional(),
      tagline: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB not available");

      const updateData: Record<string, unknown> = {};
      if (input.imageUrl !== undefined) updateData.imageUrl = input.imageUrl;
      if (input.isActive !== undefined) updateData.isActive = input.isActive;
      if (input.description !== undefined) updateData.description = input.description;
      if (input.tagline !== undefined) updateData.tagline = input.tagline;

      await db.update(bundles).set(updateData).where(eq(bundles.id, input.id));
      return { success: true };
    }),
});
