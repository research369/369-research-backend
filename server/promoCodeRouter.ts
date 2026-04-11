/**
 * Promo Code Router – tRPC routes for promo/action code management
 * 
 * Business Logic:
 * - Admin creates promo codes with optional expiry date and usage limits
 * - Customers enter promo codes at checkout for a discount
 * - Codes are validated server-side (expiry, usage limit, active status)
 * - Unlike partner codes, promo codes can be used by returning customers
 */

import { z } from "zod";
import { eq, desc, and, sql } from "drizzle-orm";
import { router, publicProcedure, adminProcedure } from "./trpc.js";
import { getDb } from "./db.js";
import { promoCodes, partnerCodeUsage } from "../drizzle/schema.js";

export const promoCodeRouter = router({
  // ─── ADMIN: CRUD ───────────────────────────────────────────────

  // List all promo codes
  list: adminProcedure
    .input(z.object({
      search: z.string().optional(),
      activeOnly: z.boolean().optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      let allCodes = await db.select().from(promoCodes).orderBy(desc(promoCodes.createdAt));

      if (input?.activeOnly) {
        allCodes = allCodes.filter(c => c.isActive === 1);
      }

      if (input?.search) {
        const s = input.search.toLowerCase();
        allCodes = allCodes.filter(c =>
          c.code.toLowerCase().includes(s) ||
          (c.description && c.description.toLowerCase().includes(s))
        );
      }

      return allCodes.map(c => ({
        ...c,
        percentage: parseFloat(c.percentage || "0"),
        fixedAmount: parseFloat(c.fixedAmount || "0"),
        minOrder: parseFloat(c.minOrder || "0"),
      }));
    }),

  // Get single promo code
  get: adminProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [code] = await db.select().from(promoCodes).where(eq(promoCodes.id, input.id)).limit(1);
      if (!code) throw new Error("Aktionscode nicht gefunden");

      return {
        ...code,
        percentage: parseFloat(code.percentage || "0"),
        fixedAmount: parseFloat(code.fixedAmount || "0"),
        minOrder: parseFloat(code.minOrder || "0"),
      };
    }),

  // Create new promo code
  create: adminProcedure
    .input(z.object({
      code: z.string().min(2).max(50),
      discountType: z.enum(["percent", "fixed"]),
      percentage: z.number().min(0).max(100).optional(),
      fixedAmount: z.number().min(0).optional(),
      minOrder: z.number().min(0).optional(),
      maxUses: z.number().min(0).optional(),
      validFrom: z.string().optional(), // ISO date string
      validUntil: z.string().optional(), // ISO date string
      description: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Check uniqueness
      const existing = await db.select().from(promoCodes)
        .where(eq(promoCodes.code, input.code.toUpperCase()))
        .limit(1);
      if (existing.length > 0) throw new Error(`Code "${input.code}" existiert bereits`);

      const [newCode] = await db.insert(promoCodes).values({
        code: input.code.toUpperCase(),
        discountType: input.discountType,
        percentage: (input.percentage || 0).toFixed(2),
        fixedAmount: (input.fixedAmount || 0).toFixed(2),
        minOrder: (input.minOrder || 0).toFixed(2),
        maxUses: input.maxUses || 0,
        currentUses: 0,
        validFrom: input.validFrom ? new Date(input.validFrom) : null,
        validUntil: input.validUntil ? new Date(input.validUntil) : null,
        description: input.description || null,
        isActive: 1,
      }).returning();

      console.log(`[PromoCodes] Created: ${input.code} (${input.discountType}: ${input.discountType === "percent" ? input.percentage + "%" : input.fixedAmount + "€"})`);
      return newCode;
    }),

  // Update promo code
  update: adminProcedure
    .input(z.object({
      id: z.number(),
      code: z.string().min(2).max(50).optional(),
      discountType: z.enum(["percent", "fixed"]).optional(),
      percentage: z.number().min(0).max(100).optional(),
      fixedAmount: z.number().min(0).optional(),
      minOrder: z.number().min(0).optional(),
      maxUses: z.number().min(0).optional(),
      validFrom: z.string().nullable().optional(),
      validUntil: z.string().nullable().optional(),
      description: z.string().optional(),
      isActive: z.number().min(0).max(1).optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const updateData: Record<string, any> = { updatedAt: new Date() };
      if (input.code !== undefined) updateData.code = input.code.toUpperCase();
      if (input.discountType !== undefined) updateData.discountType = input.discountType;
      if (input.percentage !== undefined) updateData.percentage = input.percentage.toFixed(2);
      if (input.fixedAmount !== undefined) updateData.fixedAmount = input.fixedAmount.toFixed(2);
      if (input.minOrder !== undefined) updateData.minOrder = input.minOrder.toFixed(2);
      if (input.maxUses !== undefined) updateData.maxUses = input.maxUses;
      if (input.validFrom !== undefined) updateData.validFrom = input.validFrom ? new Date(input.validFrom) : null;
      if (input.validUntil !== undefined) updateData.validUntil = input.validUntil ? new Date(input.validUntil) : null;
      if (input.description !== undefined) updateData.description = input.description || null;
      if (input.isActive !== undefined) updateData.isActive = input.isActive;

      await db.update(promoCodes).set(updateData).where(eq(promoCodes.id, input.id));
      return { success: true };
    }),

  // Delete promo code
  delete: adminProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      await db.delete(promoCodes).where(eq(promoCodes.id, input.id));
      console.log(`[PromoCodes] Deleted code ID: ${input.id}`);
      return { success: true };
    }),

  // ─── PUBLIC: Checkout integration ──────────────────────────────

  // Validate a promo code (public – called from checkout)
  validate: publicProcedure
    .input(z.object({
      code: z.string(),
      orderTotal: z.number().optional(), // for minOrder check
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [code] = await db.select().from(promoCodes)
        .where(and(
          eq(promoCodes.code, input.code.toUpperCase()),
          eq(promoCodes.isActive, 1)
        ))
        .limit(1);

      if (!code) {
        return { valid: false, reason: "Code nicht gefunden", discountPercent: 0, fixedAmount: 0 };
      }

      // Check validity period
      const now = new Date();
      if (code.validFrom && now < code.validFrom) {
        return { valid: false, reason: "Code ist noch nicht gültig", discountPercent: 0, fixedAmount: 0 };
      }
      if (code.validUntil) {
        const expiry = new Date(code.validUntil);
        expiry.setHours(23, 59, 59, 999);
        if (now > expiry) {
          return { valid: false, reason: "Code ist abgelaufen", discountPercent: 0, fixedAmount: 0 };
        }
      }

      // Check usage limit
      if (code.maxUses && code.maxUses > 0 && code.currentUses >= code.maxUses) {
        return { valid: false, reason: "Code wurde bereits zu oft eingelöst", discountPercent: 0, fixedAmount: 0 };
      }

      // Check minimum order
      const minOrder = parseFloat(code.minOrder || "0");
      if (minOrder > 0 && input.orderTotal && input.orderTotal < minOrder) {
        return { valid: false, reason: `Mindestbestellwert: ${minOrder.toFixed(2)} €`, discountPercent: 0, fixedAmount: 0 };
      }

      return {
        valid: true,
        reason: null,
        discountPercent: code.discountType === "percent" ? parseFloat(code.percentage || "0") : 0,
        fixedAmount: code.discountType === "fixed" ? parseFloat(code.fixedAmount || "0") : 0,
        discountType: code.discountType,
        description: code.description,
      };
    }),

  // Increment usage count (called after successful order)
  incrementUsage: publicProcedure
    .input(z.object({ code: z.string() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      await db.update(promoCodes)
        .set({
          currentUses: sql`${promoCodes.currentUses} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(promoCodes.code, input.code.toUpperCase()));

      return { success: true };
    }),

  // ─── PARTNER CODE USAGE (email-based one-time check) ──────────

  // Check if an email has already used a partner code
  checkPartnerCodeUsage: publicProcedure
    .input(z.object({ email: z.string().email() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [usage] = await db.select().from(partnerCodeUsage)
        .where(eq(partnerCodeUsage.email, input.email.toLowerCase()))
        .limit(1);

      return {
        hasUsed: !!usage,
        partnerCode: usage?.partnerCode || null,
        usedAt: usage?.usedAt || null,
      };
    }),

  // Record partner code usage (called after successful order with partner code)
  recordPartnerCodeUsage: publicProcedure
    .input(z.object({
      email: z.string().email(),
      partnerCode: z.string(),
      orderId: z.string(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      try {
        await db.insert(partnerCodeUsage).values({
          email: input.email.toLowerCase(),
          partnerCode: input.partnerCode.toUpperCase(),
          orderId: input.orderId,
        });
        console.log(`[PartnerCodeUsage] Recorded: ${input.email} used code ${input.partnerCode} (Order: ${input.orderId})`);
        return { success: true };
      } catch (err: any) {
        // Unique constraint violation = email already used a partner code
        if (err.code === "23505") {
          return { success: false, reason: "E-Mail hat bereits einen Partnercode verwendet" };
        }
        throw err;
      }
    }),
});
