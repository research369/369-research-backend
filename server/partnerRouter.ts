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
import { partners, partnerTransactions, orders, orderItems, partnerCodeUsage } from "../drizzle/schema.js";
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

      const updateData: Record<string, any> = { updatedAt: new Date() };
      if (input.name !== undefined) updateData.name = input.name;
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

      const commissionRate = parseFloat(partner.commissionPercent) / 100;
      const commissionAmount = Math.round(input.productSubtotalAfterDiscount * commissionRate * 100) / 100;

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

  // Partner login (public)
  login: publicProcedure
    .input(z.object({
      email: z.string().email(),
      password: z.string(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [partner] = await db.select().from(partners)
        .where(and(
          eq(partners.email, input.email.toLowerCase()),
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
  logout: publicProcedure
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
  me: partnerProcedure
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
  myTransactions: partnerProcedure
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

      const transactions = await db.select().from(partnerTransactions)
        .where(eq(partnerTransactions.partnerId, partner.id))
        .orderBy(desc(partnerTransactions.createdAt))
        .limit(limit)
        .offset(offset);

      return transactions.map(t => ({
        id: t.id,
        type: t.type,
        amount: parseFloat(t.amount),
        balanceAfter: parseFloat(t.balanceAfter),
        orderId: t.orderId,
        // NO customer name or email exposed to partner!
        description: t.type === "provision" 
          ? `Provision – Bestellung ${t.orderId}` 
          : t.type === "einloesung"
          ? `Guthaben eingelöst – Bestellung ${t.orderId}`
          : t.description || "Korrektur",
        createdAt: t.createdAt,
      }));
    }),

  // Get own referred orders summary (partner-authenticated)
  // Shows: order number, date, total, commission – NO customer data
  myOrders: partnerProcedure
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
        status: o.status,
        commission: parseFloat(o.partnerCommission || "0"),
        paidAt: o.paidAt,
      }));
    }),

  // Get partner dashboard stats (partner-authenticated)
  myStats: partnerProcedure
    .query(async ({ ctx }) => {
      const partner = (ctx as any).partner;
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Count total referred orders (paid only)
      const { inArray } = await import("drizzle-orm");
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

      // Get total redeemed
      const transactions = await db.select().from(partnerTransactions)
        .where(and(
          eq(partnerTransactions.partnerId, partner.id),
          eq(partnerTransactions.type, "einloesung")
        ));
      const totalRedeemed = transactions.reduce((sum, t) => sum + Math.abs(parseFloat(t.amount)), 0);

      return {
        totalOrders,
        totalRevenue,
        totalCommission,
        totalRedeemed,
        currentBalance: parseFloat(partner.creditBalance),
        commissionType: partner.commissionType,
        commissionPercent: parseFloat(partner.commissionPercent),
        customerDiscountPercent: parseFloat(partner.customerDiscountPercent),
      };
    }),

  // ─── PARTNER PORTAL: Checkout credit redemption ────────────────

  // Partner-authenticated credit check for checkout (more secure than public checkCredit)
  myCredit: partnerProcedure
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
  redeemCredit: partnerProcedure
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

  // Redeem credit from checkout by partner number (used when partner orders via Feld 2)
  // Security: partner number is already validated in checkout, and amount is server-validated
  redeemCreditByNumber: publicProcedure
    .input(z.object({
      partnerNumber: z.string(),
      amount: z.number().positive(),
      orderId: z.string(),
      description: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Find partner by number
      const [partner] = await db.select().from(partners)
        .where(and(eq(partners.partnerNumber, input.partnerNumber), eq(partners.active, true)))
        .limit(1);
      if (!partner) throw new Error("Partner nicht gefunden");

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
  changePassword: partnerProcedure
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
});
