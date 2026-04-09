/**
 * Article Router – tRPC routes for article/inventory management
 */
import { z } from "zod";
import { eq, desc, asc, like, and, sql, gte, lte } from "drizzle-orm";
import { router, adminProcedure, publicProcedure } from "./trpc.js";
import { getDb } from "./db.js";
import { articles, stockHistory, orderItems, orders } from "../drizzle/schema.js";

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
    }).from(articles);

    // Return only articles that have a shopProductId (linked to shop)
    return allArticles
      .filter(a => a.shopProductId && a.shopProductId.trim() !== "")
      .map(a => ({
        shopProductId: a.shopProductId!,
        inStock: (a.stock ?? 0) > 0,
        stock: a.stock ?? 0,
        name: a.name,
      }));
  }),

  // List all articles with search/sort
  list: adminProcedure
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
  get: adminProcedure
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
  create: adminProcedure
    .input(articleSchema)
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const result = await db.insert(articles).values({
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
      });

      // Log initial stock
      if (input.stock && input.stock > 0) {
        const insertId = result[0].insertId;
        await db.insert(stockHistory).values({
          articleId: insertId,
          changeType: "wareneingang",
          quantityBefore: 0,
          quantityChange: input.stock,
          quantityAfter: input.stock,
          reason: "Erstbestand",
          userName: ctx.user?.name || "Admin",
        });
      }

      return { success: true, id: result[0].insertId };
    }),

  // Update article
  update: adminProcedure
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

      await db.update(articles).set(updateData).where(eq(articles.id, id));

      return { success: true };
    }),

  // Delete (archive) article
  archive: adminProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      await db.update(articles).set({ isActive: 0 }).where(eq(articles.id, input.id));
      return { success: true };
    }),

  // Clone article
  clone: adminProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [original] = await db.select().from(articles).where(eq(articles.id, input.id)).limit(1);
      if (!original) throw new Error("Article not found");

      const result = await db.insert(articles).values({
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
      });

      return { success: true, id: result[0].insertId };
    }),

  // Adjust stock (Wareneingang / Korrektur)
  adjustStock: adminProcedure
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
  history: adminProcedure
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

  // Check stock availability for shop products (PUBLIC)
  checkAvailability: adminProcedure
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
