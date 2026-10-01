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
import { getDb, getPool } from "./db.js";
import { promoCodes, partnerCodeUsage } from "../drizzle/schema.js";
import {
  getEffectivePersonalPromoUseLimit,
  getPersonalPromoAssignmentForCode,
  getPersonalPromoAssignmentsForPromoCodeIds,
  getPersonalPromoContact,
  hasPersonalPromoContact,
  matchesPersonalPromoContact,
} from "./customerPromoAssignmentService.js";

/**
 * Standard WaWi codes retain their established end-of-day expiry. Follow-up
 * codes opt into an exact timestamp so a stated 72-hour window is never
 * silently prolonged until midnight.
 */
export function isPromoCodeExpired(
  code: { validUntil?: Date | null; validUntilExact?: number | null },
  now = new Date(),
): boolean {
  if (!code.validUntil) return false;
  const expiry = new Date(code.validUntil);
  if (code.validUntilExact === 1) return now > expiry;
  expiry.setHours(23, 59, 59, 999);
  return now > expiry;
}

const personalPromoInput = z.object({
  orderId: z.string().trim().min(1).max(32),
  code: z.string().trim().min(2).max(50),
  discountType: z.enum(["percent", "fixed"]),
  percentage: z.number().min(0).max(100).optional(),
  fixedAmount: z.number().min(0).optional(),
  minOrder: z.number().min(0).optional(),
  maxUses: z.number().int().min(0).optional(),
  maxUsesPerCustomer: z.number().int().min(0).optional(),
  validFrom: z.string().optional(),
  validUntil: z.string().optional(),
  restrictedProducts: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
  freeShippingRegions: z.array(z.string().trim().min(1).max(32)).max(10).optional(),
  description: z.string().trim().max(1_000).optional(),
});

function buildPromoDescription(input: z.infer<typeof personalPromoInput>): string {
  const cleanDescription = input.description?.trim() || `Persönlicher Aktionscode ${input.code.trim().toUpperCase()}`;
  const metadata: Record<string, unknown> = {};
  if (input.restrictedProducts?.length) metadata.restrict = input.restrictedProducts;
  if ((input.maxUsesPerCustomer || 0) > 0) metadata.maxPerCustomer = input.maxUsesPerCustomer;
  if (input.freeShippingRegions?.length) metadata.freeShipping = input.freeShippingRegions;
  return Object.keys(metadata).length > 0 ? `${cleanDescription} | ${JSON.stringify(metadata)}` : cleanDescription;
}

function describePersonalPromoForNote(input: z.infer<typeof personalPromoInput>): string {
  const amount = input.discountType === "percent"
    ? `${Number(input.percentage || 0).toLocaleString("de-DE", { maximumFractionDigits: 2 })} % Rabatt`
    : `${Number(input.fixedAmount || 0).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} € Rabatt`;
  const pieces = [amount, "persönlich zugeordnet"];
  if (input.validUntil) {
    const date = new Date(input.validUntil);
    if (!Number.isNaN(date.getTime())) pieces.push(`gültig bis ${date.toLocaleDateString("de-DE")}`);
  }
  return pieces.join(" · ");
}

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

      const assignments = await getPersonalPromoAssignmentsForPromoCodeIds(allCodes.map((code) => code.id));
      return allCodes.map(c => ({
        ...c,
        percentage: parseFloat(c.percentage || "0"),
        fixedAmount: parseFloat(c.fixedAmount || "0"),
        minOrder: parseFloat(c.minOrder || "0"),
        personalAssignment: assignments.get(c.id) ?? null,
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

      const personalAssignment = await getPersonalPromoAssignmentForCode(code.id);
      return {
        ...code,
        percentage: parseFloat(code.percentage || "0"),
        fixedAmount: parseFloat(code.fixedAmount || "0"),
        minOrder: parseFloat(code.minOrder || "0"),
        personalAssignment,
      };
    }),

  // Create an individual promo code from an existing order. The code remains a
  // regular promo code for pricing, but is additionally bound to the order's
  // exact customer contact so a forwarded code cannot be redeemed by somebody else.
  createForOrder: adminProcedure
    .input(personalPromoInput)
    .mutation(async ({ input, ctx }) => {
      if (input.discountType === "percent" && (!input.percentage || input.percentage <= 0)) {
        throw new Error("Prozent muss zwischen 1 und 100 liegen");
      }
      if (input.discountType === "fixed" && (!input.fixedAmount || input.fixedAmount <= 0)) {
        throw new Error("Fester Betrag muss größer als 0 sein");
      }
      if (input.freeShippingRegions?.length === 0) {
        throw new Error("Bitte mindestens eine Versandregion auswählen");
      }

      const pool = await getPool();
      if (!pool) throw new Error("Datenbank nicht verfügbar");
      const client = await pool.connect();
      const code = input.code.trim().toUpperCase();
      const actor = ctx.user.name || ctx.user.username || "Master-Admin";

      try {
        await client.query("BEGIN");
        const orderResult = await client.query<{
          orderId: string;
          customerId: number | null;
          internalNote: string | null;
        }>(
          `SELECT order_id AS "orderId", customer_id AS "customerId", internal_note AS "internalNote"
             FROM orders
            WHERE order_id = $1
            FOR UPDATE`,
          [input.orderId],
        );
        const order = orderResult.rows[0];
        if (!order) throw new Error("Bestellung nicht gefunden");
        if (!order.customerId) {
          throw new Error("Für diese Bestellung ist kein eindeutiger Kundendatensatz verknüpft. Bitte zuerst den Kunden zuordnen.");
        }

        const customerResult = await client.query<{
          id: number;
          email: string | null;
          phone: string | null;
        }>(
          `SELECT id, email, phone FROM customers WHERE id = $1 FOR UPDATE`,
          [order.customerId],
        );
        const customer = customerResult.rows[0];
        if (!customer) throw new Error("Kundendatensatz nicht gefunden");
        if (!hasPersonalPromoContact(customer)) {
          throw new Error("Für den persönlichen Aktionscode wird eine gültige E-Mail-Adresse oder Telefonnummer im Kundendatensatz benötigt");
        }

        const existing = await client.query(`SELECT id FROM promo_codes WHERE code = $1 LIMIT 1`, [code]);
        if (existing.rowCount && existing.rowCount > 0) throw new Error(`Code "${code}" existiert bereits`);

        const description = buildPromoDescription({ ...input, code });
        const insertPromo = await client.query<{ id: number }>(
          `INSERT INTO promo_codes
            (code, discount_type, percentage, fixed_amount, min_order, max_uses, current_uses, valid_from, valid_until, valid_until_exact, description, is_active, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, 0, $9, 1, NOW(), NOW())
           RETURNING id`,
          [
            code,
            input.discountType,
            Number(input.percentage || 0).toFixed(2),
            Number(input.fixedAmount || 0).toFixed(2),
            Number(input.minOrder || 0).toFixed(2),
            input.maxUses || 0,
            input.validFrom ? new Date(input.validFrom) : null,
            input.validUntil ? new Date(input.validUntil) : null,
            description,
          ],
        );
        const promoCodeId = insertPromo.rows[0]?.id;
        if (!promoCodeId) throw new Error("Aktionscode konnte nicht angelegt werden");

        const contact = getPersonalPromoContact(customer);
        await client.query(
          `INSERT INTO customer_promo_assignments
             (promo_code_id, customer_id, origin_order_id, email_normalized, phone_normalized, max_uses_per_customer, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [promoCodeId, customer.id, order.orderId, contact.emailNormalized, contact.phoneNormalized, input.maxUsesPerCustomer || 0, actor],
        );

        const issueNote = `[Persönlicher Aktionscode ausgegeben]\nCode: ${code} · ${describePersonalPromoForNote({ ...input, code })}\nAusgabe vorgesehen für Versand-WhatsApp`;
        const nextNote = order.internalNote?.trim() ? `${order.internalNote.trim()}\n\n${issueNote}` : issueNote;
        await client.query(
          `UPDATE orders SET internal_note = $2, updated_at = NOW() WHERE order_id = $1`,
          [order.orderId, nextNote],
        );

        await client.query("COMMIT");
        console.log(`[PromoCodes] Persönlicher Code ${code} für Kunde ${customer.id} aus ${order.orderId} erstellt`);
        return { success: true, promoCodeId, code, originOrderId: order.orderId, customerId: customer.id };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
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
      email: z.string().optional(),
      phone: z.string().optional(),
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
      if (isPromoCodeExpired(code, now)) {
        return { valid: false, reason: "Code ist abgelaufen", discountPercent: 0, fixedAmount: 0 };
      }

      // Check usage limit
      if (code.maxUses && code.maxUses > 0 && code.currentUses >= code.maxUses) {
        return { valid: false, reason: "Code wurde bereits zu oft eingelöst", discountPercent: 0, fixedAmount: 0 };
      }

      const personalAssignment = await getPersonalPromoAssignmentForCode(code.id);
      if (personalAssignment) {
        if (!hasPersonalPromoContact(input)) {
          return { valid: false, reason: "Bitte gib zuerst die bei deinem Code hinterlegte E-Mail-Adresse oder Telefonnummer ein", discountPercent: 0, fixedAmount: 0 };
        }
        if (!matchesPersonalPromoContact(personalAssignment, input)) {
          return { valid: false, reason: "Aktionscode nicht verfügbar", discountPercent: 0, fixedAmount: 0 };
        }
        const personalUseLimit = getEffectivePersonalPromoUseLimit(code.maxUses, personalAssignment.maxUsesPerCustomer);
        if (personalUseLimit > 0 && code.currentUses >= personalUseLimit) {
          return { valid: false, reason: "Code wurde bereits zu oft eingelöst", discountPercent: 0, fixedAmount: 0 };
        }
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

      const [promo] = await db.select({ id: promoCodes.id })
        .from(promoCodes)
        .where(eq(promoCodes.code, input.code.toUpperCase()))
        .limit(1);
      const personalAssignment = promo ? await getPersonalPromoAssignmentForCode(promo.id) : null;
      if (personalAssignment) {
        // The browser no longer calls this route for normal checkout completion.
        // Keeping it from touching personal codes prevents an unauthorised legacy
        // client from consuming a code outside the transactional checkout guard.
        throw new Error("AKTIONSCODE_UNGUELTIG");
      }

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
