/**
 * Partner Router – tRPC routes for partner/affiliate management
 * 
 * Business Logic:
 * - Partners have a unique CODE (for customers) and a unique PARTNER NUMBER (for themselves)
 * - Customer enters CODE at checkout → gets discount % on product subtotal (NOT shipping)
 * - Partner earns commission % on the discounted product subtotal
 * - Partner can redeem accumulated credit at checkout using their PARTNER NUMBER
 * - All transactions are tracked for transparent accounting
 */

import { z } from "zod";
import { eq, desc, and, sql } from "drizzle-orm";
import { router, publicProcedure, adminProcedure } from "./trpc.js";
import { getDb } from "./db.js";
import { partners, partnerTransactions, orders, orderItems } from "../drizzle/schema.js";

export const partnerRouter = router({
  // ─── ADMIN: CRUD ───────────────────────────────────────────────

  // List all partners
  list: adminProcedure
    .input(z.object({
      search: z.string().optional(),
      activeOnly: z.boolean().optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      let allPartners = await db.select().from(partners).orderBy(desc(partners.createdAt));

      if (input?.activeOnly) {
        allPartners = allPartners.filter(p => p.isActive === 1);
      }

      if (input?.search) {
        const s = input.search.toLowerCase();
        allPartners = allPartners.filter(p =>
          p.name.toLowerCase().includes(s) ||
          p.code.toLowerCase().includes(s) ||
          p.partnerNumber.toLowerCase().includes(s) ||
          (p.email && p.email.toLowerCase().includes(s))
        );
      }

      return allPartners.map(p => ({
        ...p,
        commissionPercent: parseFloat(p.commissionPercent),
        customerDiscountPercent: parseFloat(p.customerDiscountPercent),
        creditBalance: parseFloat(p.creditBalance),
      }));
    }),

  // Get single partner with transactions
  get: adminProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [partner] = await db.select().from(partners).where(eq(partners.id, input.id)).limit(1);
      if (!partner) throw new Error("Partner nicht gefunden");

      const transactions = await db.select().from(partnerTransactions)
        .where(eq(partnerTransactions.partnerId, input.id))
        .orderBy(desc(partnerTransactions.createdAt));

      return {
        ...partner,
        commissionPercent: parseFloat(partner.commissionPercent),
        customerDiscountPercent: parseFloat(partner.customerDiscountPercent),
        creditBalance: parseFloat(partner.creditBalance),
        transactions: transactions.map(t => ({
          ...t,
          amount: parseFloat(t.amount),
          balanceAfter: parseFloat(t.balanceAfter),
        })),
      };
    }),

  // Create new partner
  create: adminProcedure
    .input(z.object({
      name: z.string().min(1),
      email: z.string().email().optional().or(z.literal("")),
      phone: z.string().optional(),
      company: z.string().optional(),
      code: z.string().min(2).max(50),
      partnerNumber: z.string().min(2).max(50),
      commissionPercent: z.number().min(0).max(100),
      customerDiscountPercent: z.number().min(0).max(100),
      notes: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Check uniqueness of code
      const existingCode = await db.select().from(partners).where(eq(partners.code, input.code.toUpperCase())).limit(1);
      if (existingCode.length > 0) throw new Error(`Code "${input.code}" ist bereits vergeben`);

      // Check uniqueness of partner number
      const existingPN = await db.select().from(partners).where(eq(partners.partnerNumber, input.partnerNumber)).limit(1);
      if (existingPN.length > 0) throw new Error(`Partnernummer "${input.partnerNumber}" ist bereits vergeben`);

      const [newPartner] = await db.insert(partners).values({
        name: input.name,
        email: input.email || null,
        phone: input.phone || null,
        company: input.company || null,
        code: input.code.toUpperCase(),
        partnerNumber: input.partnerNumber,
        commissionPercent: input.commissionPercent.toFixed(2),
        customerDiscountPercent: input.customerDiscountPercent.toFixed(2),
        creditBalance: "0.00",
        notes: input.notes || null,
      }).returning();

      console.log(`[Partners] Created partner: ${input.name} (Code: ${input.code}, Nr: ${input.partnerNumber})`);
      return newPartner;
    }),

  // Update partner
  update: adminProcedure
    .input(z.object({
      id: z.number(),
      name: z.string().min(1).optional(),
      email: z.string().email().optional().or(z.literal("")),
      phone: z.string().optional(),
      company: z.string().optional(),
      commissionPercent: z.number().min(0).max(100).optional(),
      customerDiscountPercent: z.number().min(0).max(100).optional(),
      isActive: z.number().min(0).max(1).optional(),
      notes: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const updateData: Record<string, any> = { updatedAt: new Date() };
      if (input.name !== undefined) updateData.name = input.name;
      if (input.email !== undefined) updateData.email = input.email || null;
      if (input.phone !== undefined) updateData.phone = input.phone || null;
      if (input.company !== undefined) updateData.company = input.company || null;
      if (input.commissionPercent !== undefined) updateData.commissionPercent = input.commissionPercent.toFixed(2);
      if (input.customerDiscountPercent !== undefined) updateData.customerDiscountPercent = input.customerDiscountPercent.toFixed(2);
      if (input.isActive !== undefined) updateData.isActive = input.isActive;
      if (input.notes !== undefined) updateData.notes = input.notes || null;

      await db.update(partners).set(updateData).where(eq(partners.id, input.id));
      return { success: true };
    }),

  // Manual credit adjustment (admin)
  adjustCredit: adminProcedure
    .input(z.object({
      partnerId: z.number(),
      amount: z.number(), // positive or negative
      description: z.string().min(1),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [partner] = await db.select().from(partners).where(eq(partners.id, input.partnerId)).limit(1);
      if (!partner) throw new Error("Partner nicht gefunden");

      const currentBalance = parseFloat(partner.creditBalance);
      const newBalance = currentBalance + input.amount;

      // Update partner balance
      await db.update(partners).set({
        creditBalance: newBalance.toFixed(2),
        updatedAt: new Date(),
      }).where(eq(partners.id, input.partnerId));

      // Record transaction
      await db.insert(partnerTransactions).values({
        partnerId: input.partnerId,
        type: "korrektur",
        amount: input.amount.toFixed(2),
        balanceAfter: newBalance.toFixed(2),
        description: input.description,
      });

      console.log(`[Partners] Credit adjustment for ${partner.name}: ${input.amount > 0 ? "+" : ""}${input.amount.toFixed(2)} EUR (${input.description})`);
      return { success: true, newBalance };
    }),

  // ─── ADMIN: REPORTING ──────────────────────────────────────────

  // Get partner settlement / accounting report
  settlement: adminProcedure
    .input(z.object({ partnerId: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [partner] = await db.select().from(partners).where(eq(partners.id, input.partnerId)).limit(1);
      if (!partner) throw new Error("Partner nicht gefunden");

      // Get all transactions
      const transactions = await db.select().from(partnerTransactions)
        .where(eq(partnerTransactions.partnerId, input.partnerId))
        .orderBy(desc(partnerTransactions.createdAt));

      // Get all orders referred by this partner
      const referredOrders = await db.select().from(orders)
        .where(eq(orders.partnerCode, partner.code))
        .orderBy(desc(orders.orderDate));

      // Get order items for referred orders
      const orderIds = referredOrders.map(o => o.orderId);
      let allItems: any[] = [];
      if (orderIds.length > 0) {
        const { inArray } = await import("drizzle-orm");
        allItems = await db.select().from(orderItems).where(inArray(orderItems.orderId, orderIds));
      }

      // Calculate totals
      const totalCommissionEarned = transactions
        .filter(t => t.type === "provision")
        .reduce((sum, t) => sum + parseFloat(t.amount), 0);

      const totalRedeemed = transactions
        .filter(t => t.type === "einloesung")
        .reduce((sum, t) => sum + Math.abs(parseFloat(t.amount)), 0);

      const totalAdjustments = transactions
        .filter(t => t.type === "korrektur")
        .reduce((sum, t) => sum + parseFloat(t.amount), 0);

      return {
        partner: {
          ...partner,
          commissionPercent: parseFloat(partner.commissionPercent),
          customerDiscountPercent: parseFloat(partner.customerDiscountPercent),
          creditBalance: parseFloat(partner.creditBalance),
        },
        summary: {
          totalOrders: referredOrders.length,
          totalCommissionEarned,
          totalRedeemed,
          totalAdjustments,
          currentBalance: parseFloat(partner.creditBalance),
        },
        orders: referredOrders.map(o => ({
          orderId: o.orderId,
          customerName: `${o.firstName} ${o.lastName}`,
          orderDate: o.orderDate,
          subtotal: parseFloat(o.subtotal),
          discount: parseFloat(o.discount),
          total: parseFloat(o.total),
          status: o.status,
          partnerDiscount: parseFloat(o.partnerDiscount || "0"),
          partnerCommission: parseFloat(o.partnerCommission || "0"),
          items: allItems
            .filter(i => i.orderId === o.orderId)
            .map(i => ({ name: i.name, quantity: i.quantity, price: parseFloat(i.price) })),
        })),
        transactions: transactions.map(t => ({
          ...t,
          amount: parseFloat(t.amount),
          balanceAfter: parseFloat(t.balanceAfter),
        })),
      };
    }),

  // ─── PUBLIC: Checkout integration ──────────────────────────────

  // Validate a partner code (public – called from checkout)
  validateCode: publicProcedure
    .input(z.object({ code: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [partner] = await db.select().from(partners)
        .where(and(
          eq(partners.code, input.code.toUpperCase()),
          eq(partners.isActive, 1)
        ))
        .limit(1);

      if (!partner) {
        return { valid: false, discountPercent: 0, partnerName: null };
      }

      return {
        valid: true,
        discountPercent: parseFloat(partner.customerDiscountPercent),
        partnerName: partner.name,
      };
    }),

  // Check partner credit balance (public – called from checkout when partner number is entered)
  checkCredit: publicProcedure
    .input(z.object({ partnerNumber: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [partner] = await db.select().from(partners)
        .where(and(
          eq(partners.partnerNumber, input.partnerNumber),
          eq(partners.isActive, 1)
        ))
        .limit(1);

      if (!partner) {
        return { valid: false, creditBalance: 0, partnerName: null, discountPercent: 0 };
      }

      return {
        valid: true,
        creditBalance: parseFloat(partner.creditBalance),
        partnerName: partner.name,
        discountPercent: parseFloat(partner.customerDiscountPercent),
      };
    }),

  // ─── INTERNAL: Called after order creation to book commission ───

  // Book commission for a referred order (called from orderRouter after order creation)
  bookCommission: adminProcedure
    .input(z.object({
      orderId: z.string(),
      partnerCode: z.string(),
      productSubtotalAfterDiscount: z.number(),
      customerName: z.string(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [partner] = await db.select().from(partners)
        .where(eq(partners.code, input.partnerCode.toUpperCase()))
        .limit(1);

      if (!partner) return { success: false, message: "Partner nicht gefunden" };

      const commissionRate = parseFloat(partner.commissionPercent) / 100;
      const commissionAmount = Math.round(input.productSubtotalAfterDiscount * commissionRate * 100) / 100;

      if (commissionAmount <= 0) return { success: false, message: "Keine Provision" };

      const currentBalance = parseFloat(partner.creditBalance);
      const newBalance = currentBalance + commissionAmount;

      // Update partner balance
      await db.update(partners).set({
        creditBalance: newBalance.toFixed(2),
        updatedAt: new Date(),
      }).where(eq(partners.id, partner.id));

      // Record provision transaction
      await db.insert(partnerTransactions).values({
        partnerId: partner.id,
        type: "provision",
        amount: commissionAmount.toFixed(2),
        balanceAfter: newBalance.toFixed(2),
        orderId: input.orderId,
        customerName: input.customerName,
        description: `Provision für Bestellung ${input.orderId} (${input.customerName})`,
      });

      console.log(`[Partners] Commission booked: ${commissionAmount.toFixed(2)} EUR for ${partner.name} (Order: ${input.orderId})`);
      return { success: true, commissionAmount, newBalance };
    }),
});
