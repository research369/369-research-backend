/**
 * Purchase Order Router – tRPC routes for Wareneingang (goods receipt) and Batch tracking
 * All batch data is INTERNAL ONLY – never exposed to customers
 */
import { z } from "zod";
import { eq, desc, and, sql } from "drizzle-orm";
import { router, adminProcedure } from "./trpc.js";
import { getDb } from "./db.js";
import {
  purchaseOrders,
  purchaseOrderItems,
  batches,
  orderItemBatches,
  orderItems,
  orders,
  customers,
} from "../drizzle/schema.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

function generatePoNumber(id: number): string {
  const year = new Date().getFullYear();
  return `PO-${year}-${String(id).padStart(4, "0")}`;
}

// ─── Router ────────────────────────────────────────────────────────────────

export const purchaseOrderRouter = router({

  // ── LIST all purchase orders ──────────────────────────────────────────
  list: adminProcedure
    .input(z.object({
      status: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      const rows = await db
        .select()
        .from(purchaseOrders)
        .orderBy(desc(purchaseOrders.createdAt))
        .limit(input?.limit ?? 50)
        .offset(input?.offset ?? 0);
      return rows;
    }),

  // ── GET single purchase order with items ─────────────────────────────
  get: adminProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;
      const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, input.id));
      if (!po) return null;
      const items = await db.select().from(purchaseOrderItems).where(eq(purchaseOrderItems.purchaseOrderId, input.id));
      return { ...po, items };
    }),

  // ── CREATE purchase order ─────────────────────────────────────────────
  create: adminProcedure
    .input(z.object({
      supplierName: z.string().min(1),
      orderDate: z.string(), // ISO date string
      shippingDate: z.string().optional(),
      trackingNumber: z.string().optional(),
      shippingCostUsd: z.number().optional(),
      totalUsd: z.number().optional(),
      usdToEurRate: z.number().optional(),
      notes: z.string().optional(),
      screenshotRef: z.string().optional(),
      items: z.array(z.object({
        articleId: z.number().int().nullable().optional(),
        sku: z.string().optional(),
        name: z.string().min(1),
        dosage: z.string().optional(),
        supplierCode: z.string().optional(),
        orderedQty: z.number().int().min(0).default(0),
        receivedQty: z.number().int().min(0).default(0),
        packQuantity: z.number().int().optional(),
        packSize: z.number().int().optional(),
        purchasePriceEur: z.number().optional(),
        priceUsd: z.number().optional(),
        shippingMarkup: z.number().optional(),
        usdToEurRate: z.number().optional(),
        sellingPrice: z.number().optional(),
        batchNumber: z.string().optional(),
      })),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB not available");

      const [po] = await db.insert(purchaseOrders).values({
        poNumber: "PO-TEMP",
        supplierName: input.supplierName,
        orderDate: new Date(input.orderDate),
        shippingDate: input.shippingDate ? new Date(input.shippingDate) : null,
        trackingNumber: input.trackingNumber,
        shippingCostUsd: input.shippingCostUsd?.toFixed(2),
        totalUsd: input.totalUsd?.toFixed(2),
        usdToEurRate: input.usdToEurRate?.toFixed(4),
        notes: input.notes,
        screenshotRef: input.screenshotRef,
        status: "bestellt",
      }).returning();

      // Update PO number with real ID
      const poNumber = generatePoNumber(po.id);
      await db.update(purchaseOrders).set({ poNumber }).where(eq(purchaseOrders.id, po.id));

      // Insert items
      if (input.items.length > 0) {
        await db.insert(purchaseOrderItems).values(input.items.map(item => ({
          purchaseOrderId: po.id,
          articleId: item.articleId ?? null,
          sku: item.sku,
          name: item.name,
          dosage: item.dosage,
          supplierCode: item.supplierCode,
          orderedQty: item.orderedQty ?? 0,
          receivedQty: item.receivedQty ?? 0,
          packQuantity: item.packQuantity,
          packSize: item.packSize,
          purchasePriceEur: item.purchasePriceEur?.toFixed(4),
          priceUsd: item.priceUsd?.toFixed(2),
          shippingMarkup: item.shippingMarkup?.toFixed(4),
          usdToEurRate: item.usdToEurRate?.toFixed(4),
          sellingPrice: item.sellingPrice?.toFixed(2),
          batchNumber: item.batchNumber,
        })));
      }

      return { ...po, poNumber };
    }),

  // ── UPDATE purchase order header ──────────────────────────────────────
  update: adminProcedure
    .input(z.object({
      id: z.number().int(),
      supplierName: z.string().optional(),
      orderDate: z.string().optional(),
      shippingDate: z.string().optional(),
      receivedDate: z.string().optional(),
      trackingNumber: z.string().optional(),
      status: z.enum(["bestellt", "versendet", "teilweise_eingetroffen", "vollständig", "abgeschlossen"]).optional(),
      shippingCostUsd: z.number().optional(),
      totalUsd: z.number().optional(),
      usdToEurRate: z.number().optional(),
      notes: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB not available");
      const { id, ...data } = input;
      const updateData: Record<string, unknown> = { updatedAt: new Date() };
      if (data.supplierName !== undefined) updateData.supplierName = data.supplierName;
      if (data.orderDate !== undefined) updateData.orderDate = new Date(data.orderDate);
      if (data.shippingDate !== undefined) updateData.shippingDate = data.shippingDate ? new Date(data.shippingDate) : null;
      if (data.receivedDate !== undefined) updateData.receivedDate = data.receivedDate ? new Date(data.receivedDate) : null;
      if (data.trackingNumber !== undefined) updateData.trackingNumber = data.trackingNumber;
      if (data.status !== undefined) updateData.status = data.status;
      if (data.shippingCostUsd !== undefined) updateData.shippingCostUsd = data.shippingCostUsd.toFixed(2);
      if (data.totalUsd !== undefined) updateData.totalUsd = data.totalUsd.toFixed(2);
      if (data.usdToEurRate !== undefined) updateData.usdToEurRate = data.usdToEurRate.toFixed(4);
      if (data.notes !== undefined) updateData.notes = data.notes;
      await db.update(purchaseOrders).set(updateData as any).where(eq(purchaseOrders.id, id));
      return { success: true };
    }),

  // ── ADD item to purchase order ────────────────────────────────────────
  addItem: adminProcedure
    .input(z.object({
      purchaseOrderId: z.number().int(),
      articleId: z.number().int().nullable().optional(),
      sku: z.string().optional(),
      name: z.string().min(1),
      dosage: z.string().optional(),
      supplierCode: z.string().optional(),
      orderedQty: z.number().int().min(0).default(0),
      receivedQty: z.number().int().min(0).default(0),
      packQuantity: z.number().int().optional(),
      packSize: z.number().int().optional(),
      purchasePriceEur: z.number().optional(),
      priceUsd: z.number().optional(),
      shippingMarkup: z.number().optional(),
      usdToEurRate: z.number().optional(),
      sellingPrice: z.number().optional(),
      batchNumber: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB not available");
      const [item] = await db.insert(purchaseOrderItems).values({
        purchaseOrderId: input.purchaseOrderId,
        articleId: input.articleId ?? null,
        sku: input.sku,
        name: input.name,
        dosage: input.dosage,
        supplierCode: input.supplierCode,
        orderedQty: input.orderedQty ?? 0,
        receivedQty: input.receivedQty ?? 0,
        packQuantity: input.packQuantity,
        packSize: input.packSize,
        purchasePriceEur: input.purchasePriceEur?.toFixed(4),
        priceUsd: input.priceUsd?.toFixed(2),
        shippingMarkup: input.shippingMarkup?.toFixed(4),
        usdToEurRate: input.usdToEurRate?.toFixed(4),
        sellingPrice: input.sellingPrice?.toFixed(2),
        batchNumber: input.batchNumber,
      }).returning();
      return item;
    }),

  // ── UPDATE item (including batch number and received qty) ─────────────
  updateItem: adminProcedure
    .input(z.object({
      id: z.number().int(),
      articleId: z.number().int().nullable().optional(),
      sku: z.string().optional(),
      name: z.string().optional(),
      dosage: z.string().optional(),
      supplierCode: z.string().optional(),
      orderedQty: z.number().int().min(0).optional(),
      receivedQty: z.number().int().min(0).optional(),
      packQuantity: z.number().int().optional(),
      packSize: z.number().int().optional(),
      purchasePriceEur: z.number().optional(),
      priceUsd: z.number().optional(),
      shippingMarkup: z.number().optional(),
      usdToEurRate: z.number().optional(),
      sellingPrice: z.number().optional(),
      batchNumber: z.string().optional().nullable(),
      receivedAt: z.string().optional().nullable(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB not available");
      const { id, ...data } = input;
      const updateData: Record<string, unknown> = { updatedAt: new Date() };
      if (data.articleId !== undefined) updateData.articleId = data.articleId;
      if (data.sku !== undefined) updateData.sku = data.sku;
      if (data.name !== undefined) updateData.name = data.name;
      if (data.dosage !== undefined) updateData.dosage = data.dosage;
      if (data.supplierCode !== undefined) updateData.supplierCode = data.supplierCode;
      if (data.orderedQty !== undefined) updateData.orderedQty = data.orderedQty;
      if (data.receivedQty !== undefined) updateData.receivedQty = data.receivedQty;
      if (data.packQuantity !== undefined) updateData.packQuantity = data.packQuantity;
      if (data.packSize !== undefined) updateData.packSize = data.packSize;
      if (data.purchasePriceEur !== undefined) updateData.purchasePriceEur = data.purchasePriceEur?.toFixed(4);
      if (data.priceUsd !== undefined) updateData.priceUsd = data.priceUsd?.toFixed(2);
      if (data.shippingMarkup !== undefined) updateData.shippingMarkup = data.shippingMarkup?.toFixed(4);
      if (data.usdToEurRate !== undefined) updateData.usdToEurRate = data.usdToEurRate?.toFixed(4);
      if (data.sellingPrice !== undefined) updateData.sellingPrice = data.sellingPrice?.toFixed(2);
      if (data.batchNumber !== undefined) updateData.batchNumber = data.batchNumber;
      if (data.receivedAt !== undefined) updateData.receivedAt = data.receivedAt ? new Date(data.receivedAt) : null;
      await db.update(purchaseOrderItems).set(updateData as any).where(eq(purchaseOrderItems.id, id));
      return { success: true };
    }),

  // ── DELETE item ───────────────────────────────────────────────────────
  deleteItem: adminProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB not available");
      await db.delete(purchaseOrderItems).where(eq(purchaseOrderItems.id, input.id));
      return { success: true };
    }),

  // ── RECEIVE goods: update received qty + create batch ─────────────────
  // Called when goods arrive and batch number is assigned
  receiveItem: adminProcedure
    .input(z.object({
      itemId: z.number().int(),
      receivedQty: z.number().int().min(1),
      batchNumber: z.string().min(1),
      receivedAt: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB not available");

      // Get the item
      const [item] = await db.select().from(purchaseOrderItems).where(eq(purchaseOrderItems.id, input.itemId));
      if (!item) throw new Error("Item not found");

      // Update item
      await db.update(purchaseOrderItems).set({
        receivedQty: input.receivedQty,
        batchNumber: input.batchNumber,
        receivedAt: input.receivedAt ? new Date(input.receivedAt) : new Date(),
        updatedAt: new Date(),
      }).where(eq(purchaseOrderItems.id, input.itemId));

      // Create or update batch record
      if (item.articleId) {
        const existingBatch = await db.select().from(batches)
          .where(and(eq(batches.batchNumber, input.batchNumber), eq(batches.articleId, item.articleId)));

        if (existingBatch.length > 0) {
          // Update existing batch
          await db.update(batches).set({
            quantity: existingBatch[0].quantity + input.receivedQty,
            remainingQty: existingBatch[0].remainingQty + input.receivedQty,
            updatedAt: new Date(),
          }).where(eq(batches.id, existingBatch[0].id));
        } else {
          // Create new batch
          await db.insert(batches).values({
            batchNumber: input.batchNumber,
            articleId: item.articleId,
            articleName: item.name,
            purchaseOrderId: item.purchaseOrderId,
            purchaseOrderItemId: item.id,
            supplierName: (await db.select({ s: purchaseOrders.supplierName }).from(purchaseOrders).where(eq(purchaseOrders.id, item.purchaseOrderId)))[0]?.s ?? "",
            quantity: input.receivedQty,
            remainingQty: input.receivedQty,
            receivedDate: input.receivedAt ? new Date(input.receivedAt) : new Date(),
          });
        }
      }

      return { success: true };
    }),

  // ── GET batches for an article ────────────────────────────────────────
  getBatchesForArticle: adminProcedure
    .input(z.object({ articleId: z.number().int() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      return db.select().from(batches)
        .where(and(eq(batches.articleId, input.articleId), eq(batches.isActive, 1)))
        .orderBy(desc(batches.receivedDate));
    }),

  // ── GET all batches ───────────────────────────────────────────────────
  listBatches: adminProcedure
    .input(z.object({
      articleId: z.number().int().optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      if (input?.articleId) {
        return db.select().from(batches)
          .where(eq(batches.articleId, input.articleId))
          .orderBy(desc(batches.receivedDate));
      }
      return db.select().from(batches).orderBy(desc(batches.receivedDate));
    }),

  // ── ASSIGN batch to order item (INTERNAL ONLY) ────────────────────────
  assignBatchToOrderItem: adminProcedure
    .input(z.object({
      orderId: z.string(),
      orderItemId: z.number().int().optional(),
      articleId: z.number().int().optional(),
      articleName: z.string(),
      batchId: z.number().int().optional(),
      batchNumber: z.string().min(1),
      quantity: z.number().int().min(1).default(1),
      assignedBy: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB not available");

      // Remove existing assignment for this order item (replace)
      if (input.orderItemId) {
        await db.delete(orderItemBatches)
          .where(and(
            eq(orderItemBatches.orderId, input.orderId),
            eq(orderItemBatches.orderItemId, input.orderItemId)
          ));
      }

      // Insert new assignment
      await db.insert(orderItemBatches).values({
        orderId: input.orderId,
        orderItemId: input.orderItemId ?? null,
        articleId: input.articleId ?? null,
        articleName: input.articleName,
        batchId: input.batchId ?? null,
        batchNumber: input.batchNumber,
        quantity: input.quantity,
        assignedBy: input.assignedBy ?? "admin",
        assignedAt: new Date(),
      });

      // Decrement batch remaining qty
      if (input.batchId) {
        await db.update(batches).set({
          remainingQty: sql`${batches.remainingQty} - ${input.quantity}`,
          updatedAt: new Date(),
        }).where(eq(batches.id, input.batchId));
      }

      // Store batch info in order's internal note (append, never overwrite)
      const [order] = await db.select({ note: orders.internalNote }).from(orders).where(eq(orders.orderId, input.orderId));
      if (order) {
        const batchLine = `[BATCH] ${input.articleName}: ${input.batchNumber}`;
        const existingNote = order.note ?? "";
        // Replace existing batch line for this article if present
        const lines = existingNote.split("\n").filter(l => !l.startsWith(`[BATCH] ${input.articleName}:`));
        lines.push(batchLine);
        await db.update(orders).set({ internalNote: lines.join("\n") }).where(eq(orders.orderId, input.orderId));
      }

      // Also store in customer's last order note
      const [orderRow] = await db.select({ customerId: orders.customerId }).from(orders).where(eq(orders.orderId, input.orderId));
      if (orderRow?.customerId) {
        const batchSummary = `Batch ${input.batchNumber} (${input.articleName})`;
        await db.update(customers).set({
          notes: sql`CASE WHEN notes IS NULL THEN ${batchSummary} ELSE notes || E'\n' || ${batchSummary} END`,
          updatedAt: new Date(),
        }).where(eq(customers.id, orderRow.customerId));
      }

      return { success: true };
    }),

  // ── GET batch assignments for an order (INTERNAL ONLY) ───────────────
  getOrderBatches: adminProcedure
    .input(z.object({ orderId: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      return db.select().from(orderItemBatches)
        .where(eq(orderItemBatches.orderId, input.orderId))
        .orderBy(orderItemBatches.assignedAt);
    }),

  // ── DELETE purchase order ─────────────────────────────────────────────
  delete: adminProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB not available");
      await db.delete(purchaseOrderItems).where(eq(purchaseOrderItems.purchaseOrderId, input.id));
      await db.delete(purchaseOrders).where(eq(purchaseOrders.id, input.id));
      return { success: true };
    }),
});
