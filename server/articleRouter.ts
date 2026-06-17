/**
 * Article Router – tRPC routes for article/inventory management
 */
import { z } from "zod";
import { eq, desc, asc, like, and, sql, gte, lte, inArray } from "drizzle-orm";
import { router, adminProcedure, productManagerProcedure, publicProcedure } from "./trpc.js";
import { getDb, getPool } from "./db.js";
import { articles, stockHistory, orderItems, orders, articleTranslations, articleFaq } from "../drizzle/schema.js";

const articleSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  category: z.string().optional(),
  purchasePrice: z.number().min(0).optional(),
  sellingPrice: z.number().min(0).optional(),
  taxRate: z.number().min(0).max(100).optional(),
  stock: z.number().int().min(0).optional(),
  minStock: z.number().int().min(0).optional(),
  maxStock: z.number().int().min(0).optional(),
  shopProductId: z.string().optional(),
  notes: z.string().optional(),
  description: z.string().nullable().optional(),
  // Cross-Sell Kategorie für Follow-up Empfehlungs-Engine
  followUpCategory: z.enum(["intake", "output", "regeneration", "signaling", "structural"]).nullable().optional(),
  // Shop-Produktdaten
  mockupImageUrl: z.string().nullable().optional(),
  labelImageUrl: z.string().nullable().optional(),
  casNumber: z.string().nullable().optional(),
  molecularWeight: z.string().nullable().optional(),
  purity: z.string().nullable().optional(),
  badge: z.string().nullable().optional(),
  shortDescription: z.string().nullable().optional(),
  categories: z.array(z.string()).nullable().optional(),
  beautyData: z.record(z.unknown()).nullable().optional(),
});

export const articleRouter = router({
  // PUBLIC: Get stock availability for shop products
  shopAvailability: publicProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];

    const allArticles = await db.select({
      shopProductId: articles.shopProductId,
      stock: articles.stock,
      name: articles.name,
      isActive: articles.isActive,
    }).from(articles);

    // Return only active articles that have a shopProductId (linked to shop)
    return allArticles
      .filter(a => a.shopProductId && a.shopProductId.trim() !== "" && a.isActive !== 0)
      .map(a => ({
        shopProductId: a.shopProductId!,
        inStock: (a.stock ?? 0) > 0,
        stock: a.stock ?? 0,
        name: a.name,
      }));
  }),

  // List all articles with search/sort
  list: productManagerProcedure
    .input(z.object({
      search: z.string().optional(),
      sortBy: z.enum(["name", "sku", "stock", "sellingPrice", "createdAt"]).optional(),
      sortDir: z.enum(["asc", "desc"]).optional(),
      onlyLowStock: z.boolean().optional(),
      onlyActive: z.boolean().optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      let allArticles = await db.select().from(articles).orderBy(desc(articles.updatedAt));

      // Filter active only
      if (input?.onlyActive !== false) {
        allArticles = allArticles.filter(a => a.isActive === 1);
      }

      // Search
      if (input?.search) {
        const s = input.search.toLowerCase();
        allArticles = allArticles.filter(a =>
          a.name.toLowerCase().includes(s) ||
          a.sku.toLowerCase().includes(s) ||
          (a.category && a.category.toLowerCase().includes(s))
        );
      }

      // Low stock filter
      if (input?.onlyLowStock) {
        allArticles = allArticles.filter(a => a.stock < a.minStock);
      }

      // Sort
      if (input?.sortBy) {
        const dir = input.sortDir === "asc" ? 1 : -1;
        allArticles.sort((a, b) => {
          const key = input.sortBy!;
          const aVal = a[key as keyof typeof a];
          const bVal = b[key as keyof typeof b];
          if (aVal == null) return 1;
          if (bVal == null) return -1;
          if (typeof aVal === "string" && typeof bVal === "string") {
            return aVal.localeCompare(bVal) * dir;
          }
          return (Number(aVal) - Number(bVal)) * dir;
        });
      }

      return allArticles.map(a => ({
        ...a,
        purchasePrice: a.purchasePrice ? parseFloat(a.purchasePrice) : 0,
        sellingPrice: a.sellingPrice ? parseFloat(a.sellingPrice) : 0,
        taxRate: a.taxRate ? parseFloat(a.taxRate) : 19,
      }));
    }),

  // Get single article
  get: productManagerProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [article] = await db.select().from(articles).where(eq(articles.id, input.id)).limit(1);
      if (!article) throw new Error("Article not found");

      return {
        ...article,
        purchasePrice: article.purchasePrice ? parseFloat(article.purchasePrice) : 0,
        sellingPrice: article.sellingPrice ? parseFloat(article.sellingPrice) : 0,
        taxRate: article.taxRate ? parseFloat(article.taxRate) : 19,
      };
    }),

  // Create article
  create: productManagerProcedure
    .input(articleSchema)
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [inserted] = await db.insert(articles).values({
        sku: input.sku,
        name: input.name,
        category: input.category || null,
        purchasePrice: (input.purchasePrice || 0).toFixed(2),
        sellingPrice: (input.sellingPrice || 0).toFixed(2),
        taxRate: (input.taxRate || 19).toFixed(2),
        stock: input.stock || 0,
        minStock: input.minStock || 5,
        maxStock: input.maxStock || 100,
        shopProductId: input.shopProductId || null,
        notes: input.notes || null,
        followUpCategory: input.followUpCategory ?? null,
      }).returning();

      // Log initial stock
      if (input.stock && input.stock > 0) {
        await db.insert(stockHistory).values({
          articleId: inserted.id,
          changeType: "wareneingang",
          quantityBefore: 0,
          quantityChange: input.stock,
          quantityAfter: input.stock,
          reason: "Erstbestand",
          userName: ctx.user?.name || "Admin",
        });
      }

      return { success: true, id: inserted.id };
    }),

  // Update article
  update: productManagerProcedure
    .input(z.object({ id: z.number() }).merge(articleSchema.partial()))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const { id, ...data } = input;
      const updateData: Record<string, any> = {};

      if (data.sku !== undefined) updateData.sku = data.sku;
      if (data.name !== undefined) updateData.name = data.name;
      if (data.category !== undefined) updateData.category = data.category || null;
      if (data.purchasePrice !== undefined) updateData.purchasePrice = data.purchasePrice.toFixed(2);
      if (data.sellingPrice !== undefined) updateData.sellingPrice = data.sellingPrice.toFixed(2);
      if (data.taxRate !== undefined) updateData.taxRate = data.taxRate.toFixed(2);
      if (data.minStock !== undefined) updateData.minStock = data.minStock;
      if (data.maxStock !== undefined) updateData.maxStock = data.maxStock;
      if (data.shopProductId !== undefined) updateData.shopProductId = data.shopProductId || null;
      if (data.notes !== undefined) updateData.notes = data.notes || null;
      if (data.followUpCategory !== undefined) updateData.followUpCategory = data.followUpCategory ?? null;
      if (data.mockupImageUrl !== undefined) updateData.mockupImageUrl = data.mockupImageUrl || null;
      if (data.labelImageUrl !== undefined) updateData.labelImageUrl = data.labelImageUrl || null;
      if (data.casNumber !== undefined) updateData.casNumber = data.casNumber || null;
      if (data.molecularWeight !== undefined) updateData.molecularWeight = data.molecularWeight || null;
      if (data.purity !== undefined) updateData.purity = data.purity || null;
      if (data.badge !== undefined) updateData.badge = data.badge || null;
      if (data.shortDescription !== undefined) updateData.shortDescription = data.shortDescription || null;
      if (data.description !== undefined) updateData.description = data.description || null;
      if (data.categories !== undefined) updateData.categories = data.categories && data.categories.length > 0 ? data.categories : null;
      if (data.beautyData !== undefined) updateData.beautyData = data.beautyData || null;

      if (Object.keys(updateData).length === 0) return { success: true };
      await db.update(articles).set(updateData).where(eq(articles.id, id));

      return { success: true };
    }),

  // Delete (archive) article
  archive: productManagerProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      await db.update(articles).set({ isActive: 0 }).where(eq(articles.id, input.id));
      return { success: true };
    }),

  // Clone article
  clone: productManagerProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [original] = await db.select().from(articles).where(eq(articles.id, input.id)).limit(1);
      if (!original) throw new Error("Article not found");

      const [cloned] = await db.insert(articles).values({
        sku: `${original.sku}-KOPIE`,
        name: `${original.name} (Kopie)`,
        category: original.category,
        purchasePrice: original.purchasePrice,
        sellingPrice: original.sellingPrice,
        taxRate: original.taxRate,
        stock: 0,
        minStock: original.minStock,
        maxStock: original.maxStock,
        shopProductId: original.shopProductId,
        notes: original.notes,
      }).returning();
      return { success: true, id: cloned.id };
    }),

  // Update article(Wareneingang / Korrektur)
  adjustStock: productManagerProcedure
    .input(z.object({
      id: z.number(),
      change: z.number().int(),
      type: z.enum(["wareneingang", "verkauf", "korrektur", "retoure"]),
      reason: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [article] = await db.select().from(articles).where(eq(articles.id, input.id)).limit(1);
      if (!article) throw new Error("Article not found");

      const newStock = article.stock + input.change;
      if (newStock < 0) throw new Error("Bestand kann nicht negativ werden");

      // Update stock
      await db.update(articles).set({ stock: newStock }).where(eq(articles.id, input.id));

      // Log history
      await db.insert(stockHistory).values({
        articleId: input.id,
        changeType: input.type,
        quantityBefore: article.stock,
        quantityChange: input.change,
        quantityAfter: newStock,
        reason: input.reason || null,
        userName: ctx.user?.name || "Admin",
      });

      return { success: true, newStock };
    }),

  // Stock history for an article
  history: productManagerProcedure
    .input(z.object({
      articleId: z.number().optional(),
      limit: z.number().optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      let query = db.select().from(stockHistory).orderBy(desc(stockHistory.createdAt));

      const allHistory = await query;

      let filtered = allHistory;
      if (input?.articleId) {
        filtered = filtered.filter(h => h.articleId === input.articleId);
      }

      if (input?.limit) {
        filtered = filtered.slice(0, input.limit);
      }

      // Enrich with article names
      const articleIds = Array.from(new Set(filtered.map(h => h.articleId)));
      const articleMap = new Map<number, string>();
      for (const aid of articleIds) {
        const [a] = await db.select({ name: articles.name, sku: articles.sku }).from(articles).where(eq(articles.id, aid)).limit(1);
        if (a) articleMap.set(aid, `${a.name} (${a.sku})`);
      }

      return filtered.map(h => ({
        ...h,
        articleName: articleMap.get(h.articleId) || `Artikel #${h.articleId}`,
      }));
    }),

  // Dashboard stats
  dashboardStats: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const allArticles = await db.select().from(articles).where(eq(articles.isActive, 1));

    const totalArticles = allArticles.length;
    const totalStock = allArticles.reduce((sum, a) => sum + a.stock, 0);
    const lowStockArticles = allArticles.filter(a => a.stock < a.minStock);
    const totalPurchaseValue = allArticles.reduce((sum, a) => sum + (parseFloat(a.purchasePrice || "0") * a.stock), 0);
    const totalSellingValue = allArticles.reduce((sum, a) => sum + (parseFloat(a.sellingPrice || "0") * a.stock), 0);
    const maxStock = allArticles.reduce((max, a) => Math.max(max, a.stock), 0);

    return {
      totalArticles,
      totalStock,
      lowStockCount: lowStockArticles.length,
      lowStockArticles: lowStockArticles.map(a => ({
        id: a.id,
        sku: a.sku,
        name: a.name,
        stock: a.stock,
        minStock: a.minStock,
        sellingPrice: parseFloat(a.sellingPrice || "0"),
      })),
      totalPurchaseValue,
      totalSellingValue,
      maxStock,
    };
  }),

  // Sales statistics (Umsatzstatistik)
  salesStats: adminProcedure
    .input(z.object({
      from: z.string().optional(),
      to: z.string().optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Get all paid/shipped/delivered orders
      const allOrders = await db.select().from(orders);
      const paidOrders = allOrders.filter(o =>
        ["bezahlt", "gepackt", "versendet", "zugestellt"].includes(o.status)
      );

      // Date filter
      let filtered = paidOrders;
      if (input?.from) {
        const fromDate = new Date(input.from);
        filtered = filtered.filter(o => o.orderDate >= fromDate);
      }
      if (input?.to) {
        const toDate = new Date(input.to);
        toDate.setHours(23, 59, 59);
        filtered = filtered.filter(o => o.orderDate <= toDate);
      }

      // Get all order items for these orders
      const orderIds = filtered.map(o => o.orderId);
      let allItems: any[] = [];
      if (orderIds.length > 0) {
        const items = await db.select().from(orderItems);
        allItems = items.filter(i => orderIds.includes(i.orderId));
      }

      // Product stats
      const productMap = new Map<string, { name: string; quantity: number; revenue: number }>();
      for (const item of allItems) {
        const key = item.name;
        const existing = productMap.get(key) || { name: item.name, quantity: 0, revenue: 0 };
        existing.quantity += item.quantity;
        existing.revenue += parseFloat(item.price) * item.quantity;
        productMap.set(key, existing);
      }

      const topProducts = Array.from(productMap.values())
        .sort((a, b) => b.revenue - a.revenue);

      // Daily revenue
      const dailyMap = new Map<string, number>();
      for (const order of filtered) {
        const day = order.orderDate.toISOString().split("T")[0];
        dailyMap.set(day, (dailyMap.get(day) || 0) + parseFloat(order.total));
      }

      const dailyRevenue = Array.from(dailyMap.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, revenue]) => ({ date, revenue }));

      return {
        totalOrders: filtered.length,
        totalRevenue: filtered.reduce((sum, o) => sum + parseFloat(o.total), 0),
        avgOrderValue: filtered.length > 0
          ? filtered.reduce((sum, o) => sum + parseFloat(o.total), 0) / filtered.length
          : 0,
        topProducts,
        dailyRevenue,
      };
    }),

  // CMS: Update article description (manual or AI-generated)
  updateDescription: productManagerProcedure
    .input(z.object({
      id: z.number(),
      description: z.object({
        wirkung: z.string(),
        risiko: z.string(),
        dosierung: z.string(),
        quellen: z.array(z.string()),
        fazit: z.string(),
        kurztext: z.string().optional(),
      }),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      await db.update(articles).set({
        description: input.description,
      }).where(eq(articles.id, input.id));
      return { success: true };
    }),

  // CMS: Generate description via AI
  generateDescription: productManagerProcedure
    .input(z.object({
      id: z.number(),
      name: z.string(),
      category: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Call Forge LLM to generate description
      const FORGE_API_KEY = process.env.FORGE_API_KEY;
      const FORGE_API_URL = process.env.FORGE_API_URL || "https://forge.manus.ai";
      if (!FORGE_API_KEY) throw new Error("FORGE_API_KEY not configured");

      const prompt = `Du bist ein Experte für Forschungspeptide und Pharmazeutika. Erstelle eine wissenschaftliche Produktbeschreibung für das Forschungspeptid "${input.name}" (Kategorie: ${input.category || "Peptid"}).

WICHTIG: Alle Beschreibungen sind ausschließlich für Forschungszwecke. Keine Gesundheitsversprechen. Keine Einnahmeempfehlungen für Menschen.

Antworte als JSON mit genau dieser Struktur:
{
  "wirkung": "Beschreibung des Wirkmechanismus und der Forschungsergebnisse (2-3 Sätze, wissenschaftlich aber verständlich)",
  "risiko": "Bekannte Risiken und Nebenwirkungen aus der Forschung (2-3 Sätze)",
  "dosierung": "Typische Forschungsdosierungen aus Studien (1-2 Sätze, z.B. 'In Studien wurden Dosierungen von X-Y mg verwendet')",
  "quellen": ["Quelle 1 (z.B. PubMed-Studie)", "Quelle 2"],
  "fazit": "Kurzes Fazit zur Bedeutung für die Forschung (1-2 Sätze)",
  "kurztext": "Einzeiliger Marketingtext für den Shop (max 100 Zeichen, z.B. 'Dualer GIP/GLP-1-Agonist für die Forschung')"
}

Nur das JSON, kein Markdown, keine Erklärung.`;

      const response = await fetch(`${FORGE_API_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${FORGE_API_KEY}`,
        },
        body: JSON.stringify({
          model: "anthropic/claude-sonnet-4-20250514",
          messages: [
            { role: "system", content: "Du bist ein wissenschaftlicher Berater für Forschungspeptide. Antworte nur mit validem JSON." },
            { role: "user", content: prompt },
          ],
          temperature: 0.3,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`LLM API error: ${response.status} - ${errText}`);
      }

      const result = await response.json() as any;
      const content = result.choices?.[0]?.message?.content;
      if (!content) throw new Error("No content from LLM");

      // Parse JSON from response
      let description;
      try {
        // Try to extract JSON from potential markdown code blocks
        const jsonMatch = content.match(/```json?\s*([\s\S]*?)```/) || content.match(/\{[\s\S]*\}/);
        const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : content;
        description = JSON.parse(jsonStr.trim());
      } catch (e) {
        throw new Error(`Failed to parse LLM response: ${content}`);
      }

      // Save to DB
      await db.update(articles).set({
        description: description,
      }).where(eq(articles.id, input.id));

      return { success: true, description };
    }),

  // CMS: Toggle shop visibility
  toggleShopVisible: productManagerProcedure
    .input(z.object({
      id: z.number(),
      visible: z.boolean(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      await db.update(articles).set({
        shopVisible: input.visible ? 1 : 0,
      }).where(eq(articles.id, input.id));
      return { success: true };
    }),

  // PUBLIC: Get all shop-visible products (Single Source of Truth)
  shopProducts: publicProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    const allArticles = await db.select().from(articles)
      .where(and(eq(articles.shopVisible, 1), eq(articles.isActive, 1)))
      .orderBy(articles.name);

    // Group by shopProductId to aggregate variants
    const productMap = new Map<string, any>();
    for (const a of allArticles) {
      const pid = a.shopProductId;
      if (!pid) continue;
      const price = a.sellingPrice ? parseFloat(a.sellingPrice) : 0;
      const salePrice = a.salePrice ? parseFloat(a.salePrice) : null;
      if (!productMap.has(pid)) {
        productMap.set(pid, {
          id: pid,
          shopProductId: pid,
          name: a.name.replace(/\s*\(?\d+(?:\.\d+)?\s*(?:mg|IU|ml|mcg|iu)\)?\s*$/i, '').trim(),
          category: a.category || '',
          categories: (a.categories as string[]) || (a.category ? [a.category] : []),
          price,
          salePrice,
          salePriceLabel: a.salePriceLabel || null,
          mockupImage: a.mockupImageUrl || null,
          image: a.labelImageUrl || null,
          casNumber: a.casNumber || '',
          molecularWeight: a.molecularWeight || '',
          purity: a.purity || '99%',
          badge: a.badge || null,
          labReportImage: a.labReportImageUrl || null,
          galleryImages: (a.galleryImages as string[]) || null,
          shortDescription: a.shortDescription || null,
          beautyData: a.beautyData || null,
          photoComingSoon: a.photoComingSoon === 1,
          description: a.description || null,
          stock: 0,
          inStock: false,
          variants: [] as any[],
        });
      }
      const product = productMap.get(pid)!;
      // Regex berücksichtigt auch Klammern am Ende: "Tirzepatide (10 mg)" → "10 mg"
      const dosageMatch = a.name.match(/(\d+(?:\.\d+)?\s*(?:mg|IU|ml|mcg|iu))\s*\)?\s*$/i);
      const dosage = dosageMatch ? dosageMatch[1].trim() : '';
      if (dosage) {
        product.variants.push({ dosage, label: dosage, price, stock: a.stock, inStock: a.stock > 0, articleId: a.id });
      }
      product.stock += a.stock;
      if (a.stock > 0) product.inStock = true;
    }
    return Array.from(productMap.values()).map(p => {
      p.variants.sort((a: any, b: any) => a.price - b.price);
      if (p.variants.length > 0) p.price = p.variants[0].price;
      return p;
    });
  }),

  // CMS: Get article with description (PUBLIC - for shop product pages)
  shopArticle: publicProcedure
    .input(z.object({ shopProductId: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;
      const allArticles = await db.select().from(articles)
        .where(eq(articles.shopProductId, input.shopProductId));
      const visible = allArticles.filter(a => a.shopVisible === 1 && a.isActive === 1);
      if (visible.length === 0) return null;
      const first = visible[0];
      const variants = visible.map(a => {
        // Regex berücksichtigt auch Klammern am Ende: "MOTS-c (10 mg)" → "10 mg"
        const dosageMatch = a.name.match(/(\d+(?:\.\d+)?\s*(?:mg|IU|ml|mcg|iu))\s*\)?\s*$/i);
        const dosage = dosageMatch ? dosageMatch[1].trim() : '';
        return { dosage, label: dosage, price: a.sellingPrice ? parseFloat(a.sellingPrice) : 0, stock: a.stock, inStock: a.stock > 0, articleId: a.id };
      }).filter(v => v.dosage);
      variants.sort((a, b) => a.price - b.price);
      return {
        id: first.shopProductId,
        shopProductId: first.shopProductId,
        name: first.name.replace(/\s*\(?\d+(?:\.\d+)?\s*(?:mg|IU|ml|mcg|iu)\)?\s*$/i, '').trim(),
        description: first.description,
        sellingPrice: first.sellingPrice ? parseFloat(first.sellingPrice) : 0,
        price: variants.length > 0 ? variants[0].price : (first.sellingPrice ? parseFloat(first.sellingPrice) : 0),
        salePrice: first.salePrice ? parseFloat(first.salePrice) : null,
        salePriceLabel: first.salePriceLabel || null,
        mockupImage: first.mockupImageUrl || null,
        image: first.labelImageUrl || null,
        casNumber: first.casNumber || '',
        molecularWeight: first.molecularWeight || '',
        purity: first.purity || '99%',
        badge: first.badge || null,
        labReportImage: first.labReportImageUrl || null,
        galleryImages: (first.galleryImages as string[]) || null,
        shortDescription: first.shortDescription || null,
        beautyData: first.beautyData || null,
        photoComingSoon: first.photoComingSoon === 1,
        category: first.category || '',
        categories: (first.categories as string[]) || (first.category ? [first.category] : []),
        stock: visible.reduce((sum, a) => sum + a.stock, 0),
        inStock: visible.some(a => a.stock > 0),
        variants,
      };
    }),

  // PUBLIC: Translations + FAQs für ein Produkt (mehrsprachige Produktseiten)
  shopArticleTranslations: publicProcedure
    .input(z.object({ shopProductId: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { translations: [], faqs: [] };

      // Alle article_ids für dieses shopProductId holen
      const arts = await db.select({ id: articles.id })
        .from(articles)
        .where(eq(articles.shopProductId, input.shopProductId));
      if (arts.length === 0) return { translations: [], faqs: [] };

      const articleIds = arts.map(a => a.id);

      // Translations für alle Varianten laden
      // Verwende getPool() für Raw-SQL um Drizzle inArray()-Probleme mit mehreren IDs zu umgehen
      const pool = await getPool();
      const translationsResult = pool
        ? await pool.query(
            `SELECT * FROM article_translations WHERE article_id = ANY($1)`,
            [articleIds]
          )
        : { rows: [] };
      const allTranslations = translationsResult.rows as Array<{
        id: number; article_id: number; lang: string; name: string | null;
        description: Record<string, unknown> | null; meta_title: string | null;
        meta_description: string | null; keywords: string | null;
        slug: string | null; benefits: string | null; research_summary: string | null;
        created_at: Date; updated_at: Date;
      }>;

      // Deduplizieren + Mergen: pro lang alle Einträge zusammenführen
      // (verschiedene article_ids = Varianten desselben Produkts)
      // Alle Felder aus allen Einträgen zusammenführen – Accordion-Felder haben Vorrang
      const byLang = new Map<string, typeof allTranslations[0]>();
      for (const t of allTranslations) {
        if (!byLang.has(t.lang)) {
          byLang.set(t.lang, t);
        } else {
          const existing = byLang.get(t.lang)!;
          const existingDesc = (existing.description as Record<string, unknown>) || {};
          const newDesc = (t.description as Record<string, unknown>) || {};
          const mergedDesc: Record<string, unknown> = { ...existingDesc };
          for (const [key, value] of Object.entries(newDesc)) {
            if (value === null || value === undefined) continue;
            if (Array.isArray(value) && (value as unknown[]).length === 0) continue;
            if (typeof value === 'string' && value.trim() === '') continue;
            const ev = mergedDesc[key];
            if (ev === null || ev === undefined ||
                (Array.isArray(ev) && (ev as unknown[]).length === 0) ||
                (typeof ev === 'string' && ev.trim() === '')) {
              mergedDesc[key] = value;
            }
          }
          byLang.set(t.lang, { ...existing, description: mergedDesc as typeof existing.description });
        }
      }

      // FAQs für alle Varianten laden
      const faqsResult = pool
        ? await pool.query(
            `SELECT * FROM article_faq WHERE article_id = ANY($1) AND is_visible = 1`,
            [articleIds]
          )
        : { rows: [] };
      const allFaqs = faqsResult.rows as Array<{
        id: number; article_id: number; lang: string; question: string;
        answer: string; sort_order: number | null; is_visible: number;
        created_at: Date; updated_at: Date;
      }>;

      return {
        translations: Array.from(byLang.values()).map(t => ({
          id: (t as unknown as { id: number }).id,
          articleId: (t as unknown as { article_id: number }).article_id,
          lang: t.lang,
          title: (t as unknown as { name: string | null }).name,
          shortDescription: null,
          description: t.description,
          metaTitle: (t as unknown as { meta_title: string | null }).meta_title,
          metaDescription: (t as unknown as { meta_description: string | null }).meta_description,
          keywords: (t as unknown as { keywords: string | null }).keywords,
          slug: (t as unknown as { slug: string | null }).slug,
          benefits: (t as unknown as { benefits: string | null }).benefits,
          researchSummary: (t as unknown as { research_summary: string | null }).research_summary,
        })),
        faqs: allFaqs.map(f => ({
          id: f.id,
          articleId: f.article_id,
          lang: f.lang,
          question: f.question,
          answer: f.answer,
          sortOrder: f.sort_order,
          isVisible: f.is_visible,
        })),
      };
    }),

  // Check stock availability for shop products (PUBLIC)
  checkAvailability: productManagerProcedure
    .input(z.object({
      shopProductIds: z.array(z.string()),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const allArticles = await db.select().from(articles).where(eq(articles.isActive, 1));

      const availability = new Map<string, { inStock: boolean; stock: number }>();
      for (const pid of input.shopProductIds) {
        const article = allArticles.find(a => a.shopProductId === pid);
        if (article) {
          availability.set(pid, { inStock: article.stock > 0, stock: article.stock });
        } else {
          // Not tracked in WaWi = assume available
          availability.set(pid, { inStock: true, stock: 999 });
        }
      }

      return Object.fromEntries(availability);
    }),
});
