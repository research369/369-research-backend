/**
 * Partner Router – tRPC routes for partner/affiliate management
 * 
 * Business Logic:
 * - Partners have a unique CODE (for customers) and a unique PARTNER NUMBER (for themselves)
 * - Customer enters CODE at checkout → gets discount % on product subtotal (NOT shipping)
 * - commissionType "einmalig": partner gets one-time cash payout on FIRST order only
 * - commissionType "dauerhaft": partner gets ongoing shop credit (Guthaben) on EVERY order
 * - Dauerhaft-partners can redeem credit at checkout via login
 * - All transactions are tracked for transparent accounting
 */

import { z } from "zod";
import { eq, desc, and, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { router, publicProcedure, adminProcedure, middleware } from "./trpc.js";
import { getDb } from "./db.js";
import { partners, partnerTransactions, orders, orderItems, partnerCodeUsage, customers } from "../drizzle/schema.js";
import { ENV } from "./env.js";
import type { Request } from "express";

// ─── Partner Auth Helpers ─────────────────────────────────────────
const PARTNER_TOKEN_EXPIRY = "30d";
const PARTNER_COOKIE_NAME = "369_partner_session";

function createPartnerToken(partnerId: number): string {
  return jwt.sign({ partnerId, type: "partner" }, ENV.jwtSecret, { expiresIn: PARTNER_TOKEN_EXPIRY });
}

function verifyPartnerToken(token: string): { partnerId: number } | null {
  try {
    const payload = jwt.verify(token, ENV.jwtSecret) as any;
    if (payload.type !== "partner") return null;
    return { partnerId: payload.partnerId };
  } catch {
    return null;
  }
}

async function getPartnerFromRequest(req: Request) {
  // Check Authorization header (Bearer token)
  const authHeader = req.headers.authorization;
  let token: string | undefined;
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  }
  // Also check cookie
  if (!token) {
    const cookieHeader = req.headers.cookie || "";
    const cookies = Object.fromEntries(
      cookieHeader.split(";").map(c => {
        const [k, ...v] = c.trim().split("=");
        return [k, v.join("=")];
      })
    );
    token = cookies[PARTNER_COOKIE_NAME];
  }
  if (!token) return null;

  const payload = verifyPartnerToken(token);
  if (!payload) return null;

  const db = await getDb();
  if (!db) return null;

  const [partner] = await db.select().from(partners).where(eq(partners.id, payload.partnerId)).limit(1);
  if (!partner || partner.isActive !== 1) return null;

  return partner;
}

// Middleware for partner-authenticated procedures
const isPartner = middleware(async ({ ctx, next }) => {
  const partner = await getPartnerFromRequest(ctx.req);
  if (!partner) {
    const { TRPCError } = await import("@trpc/server");
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Partner-Login erforderlich" });
  }
  return next({ ctx: { ...ctx, partner } });
});

const partnerProcedure = publicProcedure.use(isPartner);

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
        passwordHash: undefined, // Never expose
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
        passwordHash: undefined,
        hasPassword: !!partner.passwordHash,
        transactions: transactions.map(t => ({
          ...t,
          amount: parseFloat(t.amount),
          balanceAfter: parseFloat(t.balanceAfter),
          status: t.status || "normal",
          adminNote: t.adminNote || null,
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
      commissionType: z.enum(["einmalig", "dauerhaft"]).optional(),
      password: z.string().min(6).optional(),
      notes: z.string().optional(),
      street: z.string().optional(),
      houseNumber: z.string().optional(),
      zip: z.string().optional(),
      city: z.string().optional(),
      country: z.string().optional(),
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

      let passwordHash: string | null = null;
      if (input.password) {
        passwordHash = await bcrypt.hash(input.password, 12);
      }

      const [newPartner] = await db.insert(partners).values({
        name: input.name,
        email: input.email || null,
        phone: input.phone || null,
        company: input.company || null,
        code: input.code.toUpperCase(),
        partnerNumber: input.partnerNumber,
        street: input.street || null,
        houseNumber: input.houseNumber || null,
        zip: input.zip || null,
        city: input.city || null,
        country: input.country || null,
        commissionPercent: input.commissionPercent.toFixed(2),
        customerDiscountPercent: input.customerDiscountPercent.toFixed(2),
        commissionType: input.commissionType || "dauerhaft",
        creditBalance: "0.00",
        passwordHash,
        notes: input.notes || null,
      }).returning();

      console.log(`[Partners] Created partner: ${input.name} (Code: ${input.code}, Nr: ${input.partnerNumber}, Type: ${input.commissionType || "dauerhaft"})`);
      return { ...newPartner, passwordHash: undefined };
    }),

  // Update partner
  update: adminProcedure
    .input(z.object({
      id: z.number(),
      name: z.string().min(1).optional(),
      code: z.string().min(1).optional(),
      email: z.string().email().optional().or(z.literal("")),
      phone: z.string().optional(),
      company: z.string().optional(),
      commissionPercent: z.number().min(0).max(100).optional(),
      customerDiscountPercent: z.number().min(0).max(100).optional(),
      commissionType: z.enum(["einmalig", "dauerhaft"]).optional(),
      isActive: z.number().min(0).max(1).optional(),
      notes: z.string().optional(),
      street: z.string().optional(),
      houseNumber: z.string().optional(),
      zip: z.string().optional(),
      city: z.string().optional(),
      country: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Check for code uniqueness if code is being changed
      if (input.code !== undefined) {
        const normalizedCode = input.code.toUpperCase().trim();
        // Check each code in the comma-separated list for duplicates
        const codeParts = normalizedCode.split(",").map(c => c.trim()).filter(Boolean);
        for (const codePart of codeParts) {
          const existing = await db.select({ id: partners.id }).from(partners)
            .where(and(
              sql`UPPER(${partners.code}) LIKE ${'%' + codePart + '%'}`,
              sql`${partners.id} != ${input.id}`
            ));
          if (existing.length > 0) {
            throw new Error(`Code "${codePart}" ist bereits vergeben`);
          }
        }
      }

      const updateData: Record<string, any> = { updatedAt: new Date() };
      if (input.name !== undefined) updateData.name = input.name;
      if (input.code !== undefined) updateData.code = input.code.toUpperCase().trim();
      if (input.email !== undefined) updateData.email = input.email || null;
      if (input.phone !== undefined) updateData.phone = input.phone || null;
      if (input.company !== undefined) updateData.company = input.company || null;
      if (input.commissionPercent !== undefined) updateData.commissionPercent = input.commissionPercent.toFixed(2);
      if (input.customerDiscountPercent !== undefined) updateData.customerDiscountPercent = input.customerDiscountPercent.toFixed(2);
      if (input.commissionType !== undefined) updateData.commissionType = input.commissionType;
      if (input.isActive !== undefined) updateData.isActive = input.isActive;
      if (input.notes !== undefined) updateData.notes = input.notes || null;
      if (input.street !== undefined) updateData.street = input.street || null;
      if (input.houseNumber !== undefined) updateData.houseNumber = input.houseNumber || null;
      if (input.zip !== undefined) updateData.zip = input.zip || null;
      if (input.city !== undefined) updateData.city = input.city || null;
      if (input.country !== undefined) updateData.country = input.country || null;

      await db.update(partners).set(updateData).where(eq(partners.id, input.id));
      return { success: true };
    }),

  // Set/reset partner password (admin)
  setPassword: adminProcedure
    .input(z.object({
      partnerId: z.number(),
      password: z.string().min(6),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const hash = await bcrypt.hash(input.password, 12);
      await db.update(partners).set({
        passwordHash: hash,
        updatedAt: new Date(),
      }).where(eq(partners.id, input.partnerId));

      console.log(`[Partners] Password set for partner ID ${input.partnerId}`);
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
          passwordHash: undefined,
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
          paidAt: o.paidAt,
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
          status: t.status || "normal",
          adminNote: t.adminNote || null,
        })),
      };
    }),

  // ─── ADMIN: Partner-Zuordnung & Transaktions-Kontrolle ────────

  // Assign a partner to a customer and retroactively calculate commissions
  assignPartnerToCustomer: adminProcedure
    .input(z.object({
      customerId: z.number(),
      partnerId: z.number(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [customer] = await db.select().from(customers).where(eq(customers.id, input.customerId)).limit(1);
      if (!customer) throw new Error("Kunde nicht gefunden");

      const [partner] = await db.select().from(partners).where(eq(partners.id, input.partnerId)).limit(1);
      if (!partner) throw new Error("Partner nicht gefunden");

      // Update customer with partner assignment
      await db.update(customers).set({
        acquiredBy: "partner",
        acquiredByPartnerId: input.partnerId,
        updatedAt: new Date(),
      }).where(eq(customers.id, input.customerId));

      // Retroactively calculate commissions for all existing paid orders of this customer
      const { inArray } = await import("drizzle-orm");
      const paidStatuses = ["bezahlt", "gepackt", "versendet", "zugestellt"];

      // Find all paid orders for this customer (by email or customerId)
      const customerOrders = await db.select().from(orders)
        .where(and(
          eq(orders.email, customer.email || ""),
          inArray(orders.status, paidStatuses)
        ))
        .orderBy(orders.orderDate);

      let commissionsBooked = 0;
      let totalCommission = 0;
      let currentBalance = parseFloat(partner.creditBalance);

      for (const order of customerOrders) {
        // Check if commission was already booked for this order
        const existingTx = await db.select().from(partnerTransactions)
          .where(and(
            eq(partnerTransactions.partnerId, partner.id),
            eq(partnerTransactions.orderId, order.orderId),
            eq(partnerTransactions.type, "provision")
          ))
          .limit(1);

        if (existingTx.length > 0) continue; // Already booked

        // For einmalig: only book for the first order
        if (partner.commissionType === "einmalig" && commissionsBooked > 0) continue;

        // Calculate commission on product subtotal after discount
        const productSubtotal = parseFloat(order.subtotal) - parseFloat(order.discount);
        const commissionRate = parseFloat(partner.commissionPercent) / 100;
        const commissionAmount = Math.round(productSubtotal * commissionRate * 100) / 100;

        if (commissionAmount <= 0) continue;

        currentBalance += commissionAmount;

        const description = partner.commissionType === "einmalig"
          ? `R\u00fcckwirkende Provision f\u00fcr Bestellung ${order.orderId} (${order.firstName} ${order.lastName}) \u2013 Auszahlung`
          : `R\u00fcckwirkende Provision f\u00fcr Bestellung ${order.orderId} (${order.firstName} ${order.lastName}) \u2013 Guthaben`;

        await db.insert(partnerTransactions).values({
          partnerId: partner.id,
          type: "provision",
          amount: commissionAmount.toFixed(2),
          balanceAfter: currentBalance.toFixed(2),
          orderId: order.orderId,
          customerName: `${order.firstName} ${order.lastName}`,
          description,
        });

        // Also update the order's partner fields
        await db.update(orders).set({
          partnerCode: partner.code,
          partnerCommission: commissionAmount.toFixed(2),
        }).where(eq(orders.id, order.id));

        commissionsBooked++;
        totalCommission += commissionAmount;
      }

      // Update partner balance
      if (totalCommission > 0) {
        await db.update(partners).set({
          creditBalance: currentBalance.toFixed(2),
          updatedAt: new Date(),
        }).where(eq(partners.id, partner.id));
      }

      console.log(`[Partners] Assigned partner ${partner.name} to customer ${customer.name}. Retroactive commissions: ${commissionsBooked} orders, ${totalCommission.toFixed(2)} EUR`);
      return {
        success: true,
        commissionsBooked,
        totalCommission,
        newBalance: currentBalance,
      };
    }),

  // Remove partner assignment from customer
  removePartnerFromCustomer: adminProcedure
    .input(z.object({ customerId: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      await db.update(customers).set({
        acquiredBy: "shop",
        acquiredByPartnerId: null,
        updatedAt: new Date(),
      }).where(eq(customers.id, input.customerId));

      return { success: true };
    }),

  // Update transaction status (admin control: storno, nicht werten, ausblenden)
  updateTransactionStatus: adminProcedure
    .input(z.object({
      transactionId: z.number(),
      status: z.enum(["normal", "storniert", "nicht_gewertet", "ausgeblendet"]),
      adminNote: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [tx] = await db.select().from(partnerTransactions)
        .where(eq(partnerTransactions.id, input.transactionId))
        .limit(1);
      if (!tx) throw new Error("Transaktion nicht gefunden");

      const oldStatus = tx.status || "normal";
      const txAmount = parseFloat(tx.amount);

      // Get the partner
      const [partner] = await db.select().from(partners)
        .where(eq(partners.id, tx.partnerId))
        .limit(1);
      if (!partner) throw new Error("Partner nicht gefunden");

      let currentBalance = parseFloat(partner.creditBalance);
      let balanceAdjustment = 0;

      // Calculate balance adjustment based on status change
      // If going FROM normal TO storniert/nicht_gewertet: reverse the amount
      // If going FROM storniert/nicht_gewertet TO normal: re-apply the amount
      if (oldStatus === "normal" && (input.status === "storniert" || input.status === "nicht_gewertet")) {
        // Reverse: subtract the positive provision or re-add the negative einloesung
        balanceAdjustment = -txAmount;
      } else if ((oldStatus === "storniert" || oldStatus === "nicht_gewertet") && input.status === "normal") {
        // Restore: re-apply the original amount
        balanceAdjustment = txAmount;
      }
      // ausgeblendet: same balance effect as storniert (reversed) but hidden from partner view
      if (oldStatus === "normal" && input.status === "ausgeblendet") {
        balanceAdjustment = -txAmount;
      } else if (oldStatus === "ausgeblendet" && input.status === "normal") {
        balanceAdjustment = txAmount;
      }

      // Apply balance adjustment
      if (balanceAdjustment !== 0) {
        currentBalance += balanceAdjustment;
        await db.update(partners).set({
          creditBalance: currentBalance.toFixed(2),
          updatedAt: new Date(),
        }).where(eq(partners.id, tx.partnerId));
      }

      // Update transaction status and admin note
      await db.update(partnerTransactions).set({
        status: input.status,
        adminNote: input.adminNote || null,
      }).where(eq(partnerTransactions.id, input.transactionId));

      // If storniert: create a visible counter-booking for the partner's statement
      if (input.status === "storniert" && txAmount > 0) {
        await db.insert(partnerTransactions).values({
          partnerId: tx.partnerId,
          type: "korrektur",
          amount: (-txAmount).toFixed(2),
          balanceAfter: currentBalance.toFixed(2),
          orderId: tx.orderId,
          description: `Storno: ${input.adminNote || "Provision storniert"}`,
          adminNote: `Storno von Transaktion #${tx.id}`,
        });
      }

      console.log(`[Partners] Transaction #${tx.id} status changed: ${oldStatus} -> ${input.status} (Balance adj: ${balanceAdjustment.toFixed(2)})`);
      return {
        success: true,
        balanceAdjustment,
        newBalance: currentBalance,
      };
    }),

  // Record a monetary payout for einmalig-partners (admin books cash payout)
  recordPayout: adminProcedure
    .input(z.object({
      partnerId: z.number(),
      amount: z.number().positive(),
      description: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [partner] = await db.select().from(partners).where(eq(partners.id, input.partnerId)).limit(1);
      if (!partner) throw new Error("Partner nicht gefunden");

      const currentBalance = parseFloat(partner.creditBalance);
      if (input.amount > currentBalance) {
        throw new Error(`Nicht gen\u00fcgend Guthaben f\u00fcr Auszahlung. Verf\u00fcgbar: ${currentBalance.toFixed(2)} \u20ac`);
      }

      const newBalance = Math.round((currentBalance - input.amount) * 100) / 100;

      // Update balance
      await db.update(partners).set({
        creditBalance: newBalance.toFixed(2),
        updatedAt: new Date(),
      }).where(eq(partners.id, input.partnerId));

      // Record auszahlung transaction
      await db.insert(partnerTransactions).values({
        partnerId: input.partnerId,
        type: "auszahlung",
        amount: (-input.amount).toFixed(2),
        balanceAfter: newBalance.toFixed(2),
        description: input.description || `Monet\u00e4re Auszahlung: ${input.amount.toFixed(2)} \u20ac`,
      });

      console.log(`[Partners] Payout recorded: ${input.amount.toFixed(2)} EUR for ${partner.name}`);
      return { success: true, newBalance };
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
        address: {
          street: partner.street || "",
          houseNumber: partner.houseNumber || "",
          zip: partner.zip || "",
          city: partner.city || "",
          country: partner.country || "",
        },
      };
    }),

  // ─── INTERNAL: Commission booking with commissionType logic ────

  /**
   * Book commission for a referred order.
   * - einmalig: Only book if this is the FIRST paid order from this customer email via this partner
   * - dauerhaft: Always book as shop credit (Guthaben)
   * 
   * Called when an order is marked as "bezahlt" (paid).
   */
  bookCommission: adminProcedure
    .input(z.object({
      orderId: z.string(),
      partnerCode: z.string(),
      productSubtotalAfterDiscount: z.number(),
      customerName: z.string(),
      customerEmail: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [partner] = await db.select().from(partners)
        .where(eq(partners.code, input.partnerCode.toUpperCase()))
        .limit(1);

      if (!partner) return { success: false, message: "Partner nicht gefunden" };

      // Check if commission was already booked for this order
      const existingTx = await db.select().from(partnerTransactions)
        .where(and(
          eq(partnerTransactions.partnerId, partner.id),
          eq(partnerTransactions.orderId, input.orderId),
          eq(partnerTransactions.type, "provision")
        ))
        .limit(1);

      if (existingTx.length > 0) {
        return { success: false, message: "Provision für diese Bestellung bereits gebucht" };
      }

      // ── EINMALIG CHECK ──
      // If commissionType is "einmalig", only book provision for the FIRST order from this customer
      if (partner.commissionType === "einmalig" && input.customerEmail) {
        // Check if there's already a provision transaction for this customer email
        const { like } = await import("drizzle-orm");
        const existingProvisions = await db.select().from(partnerTransactions)
          .where(and(
            eq(partnerTransactions.partnerId, partner.id),
            eq(partnerTransactions.type, "provision")
          ));
        
        // Check if any previous provision was for the same customer
        // We check by looking at orders with this partner code and this email
        const previousOrders = await db.select().from(orders)
          .where(and(
            eq(orders.partnerCode, partner.code),
            eq(orders.email, input.customerEmail)
          ));
        
        // If there are other PAID orders from this customer (excluding current), skip
        const otherPaidOrders = previousOrders.filter(o => 
          o.orderId !== input.orderId && 
          (o.status === "bezahlt" || o.status === "gepackt" || o.status === "versendet" || o.status === "zugestellt")
        );

        if (otherPaidOrders.length > 0) {
          console.log(`[Partners] EINMALIG: Skipping commission for ${partner.name} – customer ${input.customerEmail} already has ${otherPaidOrders.length} previous paid orders`);
          return { 
            success: false, 
            message: `Einmalige Provision: Kunde hat bereits ${otherPaidOrders.length} bezahlte Bestellung(en). Keine weitere Provision.`,
            skippedReason: "einmalig_already_paid"
          };
        }
      }

      // Provision wird IMMER auf den übergebenen Nettobetrag nach ALLEN Rabatten berechnet
      const commissionRate = parseFloat(partner.commissionPercent) / 100;
      const commissionAmount = Math.round(input.productSubtotalAfterDiscount * commissionRate * 100) / 100;
      console.log(`[Partners] Commission calc: nettoAfterDiscount=${input.productSubtotalAfterDiscount}, rate=${commissionRate}, commission=${commissionAmount}`);

      if (commissionAmount <= 0) return { success: false, message: "Keine Provision" };

      // For "dauerhaft" partners: book as credit (Guthaben)
      // For "einmalig" partners: also track in balance for accounting, but it's meant for cash payout
      const currentBalance = parseFloat(partner.creditBalance);
      const newBalance = currentBalance + commissionAmount;

      // Update partner balance
      await db.update(partners).set({
        creditBalance: newBalance.toFixed(2),
        updatedAt: new Date(),
      }).where(eq(partners.id, partner.id));

      // Record provision transaction
      const description = partner.commissionType === "einmalig"
        ? `Einmalige Provision für Bestellung ${input.orderId} (${input.customerName}) – Auszahlung`
        : `Provision für Bestellung ${input.orderId} (${input.customerName}) – Guthaben`;

      await db.insert(partnerTransactions).values({
        partnerId: partner.id,
        type: "provision",
        amount: commissionAmount.toFixed(2),
        balanceAfter: newBalance.toFixed(2),
        orderId: input.orderId,
        customerName: input.customerName,
        description,
      });

      console.log(`[Partners] Commission booked (${partner.commissionType}): ${commissionAmount.toFixed(2)} EUR for ${partner.name} (Order: ${input.orderId})`);
      return { success: true, commissionAmount, newBalance, commissionType: partner.commissionType };
    }),

  // ─── PARTNER PORTAL: Auth ─────────────────────────────────────

  // Partner login via Partnernummer + Passwort (public)
  portalLogin: publicProcedure
    .input(z.object({
      partnerNumber: z.string(),
      password: z.string(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [partner] = await db.select().from(partners)
        .where(and(
          eq(partners.partnerNumber, input.partnerNumber),
          eq(partners.isActive, 1)
        ))
        .limit(1);

      if (!partner || !partner.passwordHash) {
        throw new Error("Ungültige Anmeldedaten");
      }

      const valid = await bcrypt.compare(input.password, partner.passwordHash);
      if (!valid) {
        throw new Error("Ungültige Anmeldedaten");
      }

      // Update last login
      await db.update(partners).set({ lastLogin: new Date() }).where(eq(partners.id, partner.id));

      const token = createPartnerToken(partner.id);

      // Set cookie
      ctx.res.cookie(PARTNER_COOKIE_NAME, token, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        path: "/",
      });

      return {
        success: true,
        token,
        partner: {
          id: partner.id,
          name: partner.name,
          email: partner.email,
          code: partner.code,
          partnerNumber: partner.partnerNumber,
          commissionType: partner.commissionType,
          creditBalance: parseFloat(partner.creditBalance),
        },
      };
    }),

  // Partner logout
  portalLogout: publicProcedure
    .mutation(async ({ ctx }) => {
      ctx.res.clearCookie(PARTNER_COOKIE_NAME, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        path: "/",
      });
      return { success: true };
    }),

  // ─── PARTNER PORTAL: Data (requires partner auth) ─────────────

  // Get own profile (partner-authenticated)
  portalMe: partnerProcedure
    .query(async ({ ctx }) => {
      const partner = (ctx as any).partner;
      return {
        id: partner.id,
        name: partner.name,
        email: partner.email,
        phone: partner.phone,
        company: partner.company,
        code: partner.code,
        partnerNumber: partner.partnerNumber,
        commissionPercent: parseFloat(partner.commissionPercent),
        customerDiscountPercent: parseFloat(partner.customerDiscountPercent),
        commissionType: partner.commissionType,
        creditBalance: parseFloat(partner.creditBalance),
        address: {
          street: partner.street || "",
          houseNumber: partner.houseNumber || "",
          zip: partner.zip || "",
          city: partner.city || "",
          country: partner.country || "",
        },
      };
    }),

  // Get own transactions (partner-authenticated)
  // Filters out "ausgeblendet" transactions, shows storniert/nicht_gewertet with status marker
  portalMyTransactions: partnerProcedure
    .input(z.object({
      limit: z.number().min(1).max(200).optional(),
      offset: z.number().min(0).optional(),
    }).optional())
    .query(async ({ ctx, input }) => {
      const partner = (ctx as any).partner;
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const limit = input?.limit || 50;
      const offset = input?.offset || 0;

      const { ne } = await import("drizzle-orm");
      const transactions = await db.select().from(partnerTransactions)
        .where(and(
          eq(partnerTransactions.partnerId, partner.id),
          ne(partnerTransactions.status, "ausgeblendet")
        ))
        .orderBy(desc(partnerTransactions.createdAt))
        .limit(limit)
        .offset(offset);

      return transactions.map(t => {
        let description = "";
        if (t.type === "provision") {
          description = `Provision \u2013 Bestellung ${t.orderId}`;
        } else if (t.type === "einloesung") {
          description = `Guthaben eingel\u00f6st \u2013 Bestellung ${t.orderId}`;
        } else if (t.type === "auszahlung") {
          description = `Auszahlung`;
        } else {
          description = t.description || "Korrektur";
        }

        // Mark storniert/nicht_gewertet transactions
        const status = t.status || "normal";
        if (status === "storniert") {
          description = `[STORNIERT] ${description}`;
        } else if (status === "nicht_gewertet") {
          description = `[NICHT GEWERTET] ${description}`;
        }

        return {
          id: t.id,
          type: t.type,
          amount: parseFloat(t.amount),
          balanceAfter: parseFloat(t.balanceAfter),
          orderId: t.orderId,
          description,
          status,
          createdAt: t.createdAt,
        };
      });
    }),

  // Get own referred orders summary (partner-authenticated)
  // Shows: order number, date, total, commission – NO customer data
  portalMyOrders: partnerProcedure
    .input(z.object({
      limit: z.number().min(1).max(200).optional(),
      offset: z.number().min(0).optional(),
    }).optional())
    .query(async ({ ctx, input }) => {
      const partner = (ctx as any).partner;
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const limit = input?.limit || 50;
      const offset = input?.offset || 0;

      // Only show paid orders
      const { inArray } = await import("drizzle-orm");
      const paidStatuses = ["bezahlt", "gepackt", "versendet", "zugestellt"];

      const referredOrders = await db.select({
        orderId: orders.orderId,
        orderDate: orders.orderDate,
        total: orders.total,
        subtotal: orders.subtotal,
        discount: orders.discount,
        status: orders.status,
        partnerCommission: orders.partnerCommission,
        paidAt: orders.paidAt,
      }).from(orders)
        .where(and(
          eq(orders.partnerCode, partner.code),
          inArray(orders.status, paidStatuses)
        ))
        .orderBy(desc(orders.orderDate))
        .limit(limit)
        .offset(offset);

      return referredOrders.map(o => ({
        orderId: o.orderId,
        orderDate: o.orderDate,
        total: parseFloat(o.total),
        netAmount: Math.max(0, parseFloat(o.subtotal || "0") - parseFloat(o.discount || "0")),
        status: o.status,
        commission: parseFloat(o.partnerCommission || "0"),
        paidAt: o.paidAt,
      }));
    }),

  // Get partner dashboard stats (partner-authenticated)
  // Shows both payout (einmalig) and credit redemption (dauerhaft) totals
  portalMyStats: partnerProcedure
    .query(async ({ ctx }) => {
      const partner = (ctx as any).partner;
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Count total referred orders (paid only)
      const { inArray, ne } = await import("drizzle-orm");
      const paidStatuses = ["bezahlt", "gepackt", "versendet", "zugestellt"];

      const referredOrders = await db.select({
        total: orders.total,
        partnerCommission: orders.partnerCommission,
      }).from(orders)
        .where(and(
          eq(orders.partnerCode, partner.code),
          inArray(orders.status, paidStatuses)
        ));

      const totalOrders = referredOrders.length;
      const totalRevenue = referredOrders.reduce((sum, o) => sum + parseFloat(o.total), 0);
      const totalCommission = referredOrders.reduce((sum, o) => sum + parseFloat(o.partnerCommission || "0"), 0);

      // Get all non-hidden transactions for this partner
      const allTransactions = await db.select().from(partnerTransactions)
        .where(and(
          eq(partnerTransactions.partnerId, partner.id),
          ne(partnerTransactions.status, "ausgeblendet")
        ));

      // Total redeemed as shop credit (Guthaben-Einl\u00f6sung)
      const totalCreditRedeemed = allTransactions
        .filter(t => t.type === "einloesung" && (t.status === "normal" || !t.status))
        .reduce((sum, t) => sum + Math.abs(parseFloat(t.amount)), 0);

      // Total paid out as cash (monet\u00e4re Auszahlung)
      const totalPaidOut = allTransactions
        .filter(t => t.type === "auszahlung" && (t.status === "normal" || !t.status))
        .reduce((sum, t) => sum + Math.abs(parseFloat(t.amount)), 0);

      // Combined "eingel\u00f6st" = credit redeemed + cash paid out
      const totalRedeemed = totalCreditRedeemed + totalPaidOut;

      return {
        totalOrders,
        totalRevenue,
        totalCommission,
        totalRedeemed,
        totalCreditRedeemed,
        totalPaidOut,
        currentBalance: parseFloat(partner.creditBalance),
        commissionType: partner.commissionType,
        commissionPercent: parseFloat(partner.commissionPercent),
        customerDiscountPercent: parseFloat(partner.customerDiscountPercent),
      };
    }),

  // ─── PARTNER PORTAL: Checkout credit redemption ────────────────

  // Partner-authenticated credit check for checkout (more secure than public checkCredit)
  portalMyCredit: partnerProcedure
    .query(async ({ ctx }) => {
      const partner = (ctx as any).partner;
      return {
        creditBalance: parseFloat(partner.creditBalance),
        partnerName: partner.name,
        partnerNumber: partner.partnerNumber,
        commissionType: partner.commissionType,
        address: {
          street: partner.street || "",
          houseNumber: partner.houseNumber || "",
          zip: partner.zip || "",
          city: partner.city || "",
          country: partner.country || "",
        },
      };
    }),

  // Redeem credit at checkout (partner-authenticated, server-validated)
  portalRedeemCredit: partnerProcedure
    .input(z.object({
      amount: z.number().positive(),
      orderId: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      const partner = (ctx as any).partner;
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Re-fetch partner to get latest balance (prevent race conditions)
      const [freshPartner] = await db.select().from(partners).where(eq(partners.id, partner.id)).limit(1);
      if (!freshPartner) throw new Error("Partner nicht gefunden");

      const currentBalance = parseFloat(freshPartner.creditBalance);
      
      // Validate amount
      if (input.amount > currentBalance) {
        throw new Error(`Nicht genügend Guthaben. Verfügbar: ${currentBalance.toFixed(2)} €`);
      }

      const newBalance = Math.round((currentBalance - input.amount) * 100) / 100;

      // Update balance
      await db.update(partners).set({
        creditBalance: newBalance.toFixed(2),
        updatedAt: new Date(),
      }).where(eq(partners.id, partner.id));

      // Record einloesung transaction
      await db.insert(partnerTransactions).values({
        partnerId: partner.id,
        type: "einloesung",
        amount: (-input.amount).toFixed(2),
        balanceAfter: newBalance.toFixed(2),
        orderId: input.orderId,
        description: `Guthaben eingelöst für Bestellung ${input.orderId}`,
      });

      console.log(`[Partners] Credit redeemed: ${input.amount.toFixed(2)} EUR by ${partner.name} (Order: ${input.orderId})`);
      return { success: true, amountRedeemed: input.amount, newBalance };
    }),

  // Redeem credit from checkout by partner number (requires password for security)
  redeemCreditByNumber: publicProcedure
    .input(z.object({
      partnerNumber: z.string(),
      password: z.string(),
      amount: z.number().positive(),
      orderId: z.string(),
      description: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Find partner by number
      const [partner] = await db.select().from(partners)
        .where(and(eq(partners.partnerNumber, input.partnerNumber), eq(partners.isActive, 1)))
        .limit(1);
      if (!partner) throw new Error("Partner nicht gefunden");

      // Verify password
      if (!partner.passwordHash) {
        throw new Error("Kein Passwort gesetzt. Bitte wenden Sie sich an 369 Research.");
      }
      const validPw = await bcrypt.compare(input.password, partner.passwordHash);
      if (!validPw) {
        throw new Error("Falsches Passwort");
      }

      const currentBalance = parseFloat(partner.creditBalance);
      if (input.amount > currentBalance) {
        throw new Error(`Nicht gen\u00fcgend Guthaben. Verf\u00fcgbar: ${currentBalance.toFixed(2)} \u20ac`);
      }

      const newBalance = Math.round((currentBalance - input.amount) * 100) / 100;

      // Update balance
      await db.update(partners).set({
        creditBalance: newBalance.toFixed(2),
        updatedAt: new Date(),
      }).where(eq(partners.id, partner.id));

      // Record transaction
      await db.insert(partnerTransactions).values({
        partnerId: partner.id,
        type: "einloesung",
        amount: (-input.amount).toFixed(2),
        balanceAfter: newBalance.toFixed(2),
        orderId: input.orderId,
        description: input.description || `Guthaben eingel\u00f6st f\u00fcr Bestellung ${input.orderId}`,
      });

      console.log(`[Partners] Checkout credit redeemed: ${input.amount.toFixed(2)} EUR by ${partner.name} (Order: ${input.orderId})`);
      return { success: true, newBalance };
    }),

  // Change own password (partner-authenticated)
  portalChangePassword: partnerProcedure
    .input(z.object({
      currentPassword: z.string(),
      newPassword: z.string().min(6),
    }))
    .mutation(async ({ ctx, input }) => {
      const partner = (ctx as any).partner;
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      if (!partner.passwordHash) {
        throw new Error("Kein Passwort gesetzt");
      }

      const valid = await bcrypt.compare(input.currentPassword, partner.passwordHash);
      if (!valid) {
        throw new Error("Aktuelles Passwort ist falsch");
      }

      const hash = await bcrypt.hash(input.newPassword, 12);
      await db.update(partners).set({
        passwordHash: hash,
        updatedAt: new Date(),
      }).where(eq(partners.id, partner.id));

      return { success: true };
    }),

  // ─── PARTNER PORTAL: Password Reset (public, email-based) ─────

  /**
   * Step 1: Partner requests a password reset.
   * - Checks if partner exists and has an email
   * - Generates a 6-digit code, stores it with expiry (15 min)
   * - Sends email via Resend
   */
  portalRequestPasswordReset: publicProcedure
    .input(z.object({
      partnerNumber: z.string().min(1),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [partner] = await db.select().from(partners)
        .where(eq(partners.partnerNumber, input.partnerNumber))
        .limit(1);

      // Always return success to prevent enumeration attacks
      if (!partner || partner.isActive !== 1) {
        // Don't reveal whether partner exists
        return { success: true, message: "Falls eine E-Mail-Adresse hinterlegt ist, wurde ein Reset-Code gesendet." };
      }

      if (!partner.email) {
        return { success: false, message: "Keine E-Mail-Adresse hinterlegt. Bitte kontaktiere den Admin." };
      }

      // Generate 6-digit code
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

      // Store code in partner's notes field temporarily (prefixed so we can parse it)
      // Format: __RESET_CODE__:CODE:EXPIRY_ISO
      const resetData = `__RESET_CODE__:${code}:${expiresAt.toISOString()}`;
      
      // We store the reset code in a dedicated field approach: use SQL directly
      const { getPool } = await import("./db.js");
      const pool = await getPool();
      if (!pool) throw new Error("Database not available");
      
      // Store reset code (we use a simple approach: store in a temporary column or use notes)
      // Using raw SQL to set a reset_code and reset_code_expires field
      await pool.query(
        `UPDATE partners SET notes = COALESCE(REGEXP_REPLACE(notes, '__RESET_CODE__:[^|]*\\|?', ''), '') || $1 WHERE id = $2`,
        [`|${resetData}`, partner.id]
      );

      // Send email via Resend
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey) {
        console.warn("[Partners] RESEND_API_KEY not configured, cannot send reset email");
        return { success: false, message: "E-Mail-Service nicht verfuegbar. Bitte kontaktiere den Admin." };
      }

      const emailHtml = `
<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background-color:#0a0a0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:500px;margin:0 auto;padding:40px 20px;">
    <div style="background:linear-gradient(135deg,#0d1117,#161b22);border:1px solid #1c2433;border-radius:16px;padding:40px;text-align:center;">
      <div style="margin-bottom:24px;">
        <h1 style="color:#3b82f6;margin:0;font-size:24px;font-weight:700;letter-spacing:1px;">369 RESEARCH</h1>
        <p style="color:#64748b;margin:4px 0 0;font-size:12px;letter-spacing:2px;">PARTNER PORTAL</p>
      </div>
      <div style="background:#0a0f1a;border:1px solid #1e3a5f;border-radius:12px;padding:24px;margin:24px 0;">
        <p style="color:#94a3b8;font-size:14px;margin:0 0 16px;">Dein Passwort-Reset-Code:</p>
        <p style="color:#3b82f6;font-size:36px;font-weight:700;letter-spacing:8px;margin:0;font-family:monospace;">${code}</p>
        <p style="color:#64748b;font-size:12px;margin:16px 0 0;">Gueltig fuer 15 Minuten</p>
      </div>
      <p style="color:#64748b;font-size:13px;margin:0;">Falls du keinen Reset angefordert hast, ignoriere diese E-Mail.</p>
    </div>
  </div>
</body>
</html>`;

      try {
        const RESEND_API_URL = "https://api.resend.com/emails";
        const response = await fetch(RESEND_API_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: "369 Research <noreply@369research.eu>",
            to: [partner.email],
            subject: "Passwort zuruecksetzen – 369 Research Partner Portal",
            html: emailHtml,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.warn(`[Partners] Failed to send reset email (${response.status}):`, errorText);
          return { success: false, message: "E-Mail konnte nicht gesendet werden. Bitte versuche es spaeter." };
        }

        console.log(`[Partners] Password reset code sent to ${partner.email} for ${partner.partnerNumber}`);
        return { success: true, message: "Falls eine E-Mail-Adresse hinterlegt ist, wurde ein Reset-Code gesendet." };
      } catch (error) {
        console.warn("[Partners] Error sending reset email:", error);
        return { success: false, message: "E-Mail konnte nicht gesendet werden." };
      }
    }),

  /**
   * Step 2: Partner confirms the reset code and sets a new password.
   */
  portalConfirmPasswordReset: publicProcedure
    .input(z.object({
      partnerNumber: z.string().min(1),
      code: z.string().length(6),
      newPassword: z.string().min(6),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [partner] = await db.select().from(partners)
        .where(and(
          eq(partners.partnerNumber, input.partnerNumber),
          eq(partners.isActive, 1)
        ))
        .limit(1);

      if (!partner) {
        throw new Error("Ungueltiger Reset-Code");
      }

      // Extract reset code from notes
      const notes = partner.notes || "";
      const resetMatch = notes.match(/__RESET_CODE__:(\d{6}):([^|]+)/);
      
      if (!resetMatch) {
        throw new Error("Kein Reset-Code vorhanden. Bitte fordere einen neuen an.");
      }

      const storedCode = resetMatch[1];
      const expiresAt = new Date(resetMatch[2]);

      if (storedCode !== input.code) {
        throw new Error("Ungueltiger Reset-Code");
      }

      if (new Date() > expiresAt) {
        throw new Error("Reset-Code abgelaufen. Bitte fordere einen neuen an.");
      }

      // Code is valid – set new password
      const hash = await bcrypt.hash(input.newPassword, 12);
      
      // Remove reset code from notes and update password
      const cleanedNotes = notes.replace(/\|?__RESET_CODE__:[^|]*/g, "").replace(/^\|/, "");
      
      await db.update(partners).set({
        passwordHash: hash,
        notes: cleanedNotes || null,
        updatedAt: new Date(),
      }).where(eq(partners.id, partner.id));

      console.log(`[Partners] Password reset confirmed for ${partner.partnerNumber}`);
      return { success: true, message: "Passwort erfolgreich zurueckgesetzt. Du kannst dich jetzt einloggen." };
    }),

  // ─── Send Credentials Email (Admin) ─────────────────────────────
  // Sends an email to the partner with portal link, partner number, and password
  sendCredentials: adminProcedure
    .input(z.object({
      partnerId: z.number(),
      password: z.string().min(6, "Passwort muss mindestens 6 Zeichen haben"),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Get partner data
      const [partner] = await db.select().from(partners).where(eq(partners.id, input.partnerId));
      if (!partner) throw new Error("Partner nicht gefunden");
      if (!partner.email) throw new Error("Partner hat keine E-Mail-Adresse hinterlegt");

      // Set the password first
      const hash = await bcrypt.hash(input.password, 12);
      await db.update(partners).set({
        passwordHash: hash,
        updatedAt: new Date(),
      }).where(eq(partners.id, input.partnerId));

      // Build the credentials email
      const html = `
<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#0a0e17;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:20px;">
    
    <!-- Header -->
    <div style="background:linear-gradient(135deg,#0f172a,#1e293b);border-radius:12px 12px 0 0;padding:32px;text-align:center;border:1px solid #1e3a5f;border-bottom:none;">
      <h1 style="color:#3b82f6;margin:0;font-size:28px;font-weight:700;letter-spacing:2px;">369 RESEARCH</h1>
      <p style="color:#64748b;margin:8px 0 0;font-size:12px;letter-spacing:3px;text-transform:uppercase;">Partner Portal</p>
    </div>

    <!-- Content -->
    <div style="background:#111827;padding:32px;border:1px solid #1e3a5f;border-top:none;">
      <h2 style="font-size:20px;color:#ffffff;margin:0 0 8px;">Willkommen im Partner-Programm!</h2>
      <p style="font-size:14px;color:#94a3b8;margin:0 0 24px;line-height:1.6;">Hallo ${partner.name},<br><br>hier sind deine Zugangsdaten f\u00fcr das 369 Research Partner Portal:</p>

      <!-- Credentials Box -->
      <div style="background:#0a0f1a;border:1px solid #1e3a5f;border-radius:12px;padding:24px;margin-bottom:24px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr>
            <td style="padding:12px 0;color:#64748b;font-size:13px;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #1c2433;">Portal-Link</td>
            <td style="padding:12px 0;text-align:right;border-bottom:1px solid #1c2433;"><a href="https://www.369research.eu/partner" style="color:#3b82f6;font-weight:600;text-decoration:none;">369research.eu/partner</a></td>
          </tr>
          <tr>
            <td style="padding:12px 0;color:#64748b;font-size:13px;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #1c2433;">Partnernummer</td>
            <td style="padding:12px 0;text-align:right;color:#3b82f6;font-weight:700;font-family:monospace;font-size:16px;border-bottom:1px solid #1c2433;">${partner.partnerNumber}</td>
          </tr>
          <tr>
            <td style="padding:12px 0;color:#64748b;font-size:13px;text-transform:uppercase;letter-spacing:1px;">Passwort</td>
            <td style="padding:12px 0;text-align:right;color:#ffffff;font-weight:700;font-family:monospace;font-size:16px;">${input.password}</td>
          </tr>
        </table>
      </div>

      <!-- Partner Info -->
      <div style="background:#0a0f1a;border:1px solid #1e3a5f;border-radius:12px;padding:24px;margin-bottom:24px;">
        <h3 style="font-size:14px;color:#64748b;margin:0 0 16px;text-transform:uppercase;letter-spacing:1px;">Deine Partner-Details</h3>
        <table style="width:100%;border-collapse:collapse;">
          <tr>
            <td style="padding:8px 0;color:#94a3b8;font-size:14px;">Dein Rabattcode</td>
            <td style="padding:8px 0;text-align:right;color:#10b981;font-weight:700;font-family:monospace;font-size:16px;">${partner.code}</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#94a3b8;font-size:14px;">Kundenrabatt</td>
            <td style="padding:8px 0;text-align:right;color:#ffffff;font-weight:600;">${partner.customerDiscountPercent}%</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#94a3b8;font-size:14px;">Deine Provision</td>
            <td style="padding:8px 0;text-align:right;color:#ffffff;font-weight:600;">${partner.commissionPercent}%</td>
          </tr>
        </table>
      </div>

      <!-- CTA Button -->
      <div style="text-align:center;margin:24px 0;">
        <a href="https://www.369research.eu/partner" style="background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#ffffff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:600;font-size:16px;display:inline-block;">Zum Partner Portal</a>
      </div>

      <p style="font-size:13px;color:#475569;margin:24px 0 0;line-height:1.6;text-align:center;">Bitte \u00e4ndere dein Passwort nach dem ersten Login \u00fcber die Einstellungen im Portal.</p>
    </div>

    <!-- Footer -->
    <div style="background:#0d1117;border:1px solid #1e3a5f;border-top:none;border-radius:0 0 12px 12px;padding:20px;text-align:center;">
      <p style="margin:0;font-size:12px;color:#475569;">369 Research \u00b7 Precision. Purity. Performance.</p>
      <p style="margin:4px 0 0;font-size:12px;color:#475569;">Bei Fragen: WhatsApp +4915510063537</p>
    </div>
  </div>
</body>
</html>`;

      // Send email via Resend
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey) throw new Error("E-Mail-Service nicht konfiguriert (RESEND_API_KEY fehlt)");

      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "369 Research <noreply@369research.eu>",
          to: [partner.email],
          subject: `Deine Zugangsdaten – 369 Research Partner Portal`,
          html,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.warn(`[Partners] Failed to send credentials email (${response.status}):`, errorText);
        throw new Error(`E-Mail konnte nicht gesendet werden: ${response.status}`);
      }

      const result = await response.json();
      console.log(`[Partners] Credentials email sent to ${partner.email}, id: ${result.id}`);
      return { success: true, message: `Zugangsdaten an ${partner.email} gesendet` };
    }),
});
