/**
 * Partner Router – tRPC routes for partner/affiliate management
 * 
 * Business Logic:
 * - Partners have a unique CODE (for customers) and a unique PARTNER NUMBER (for themselves)
 * - Customer enters CODE at checkout → gets discount % on product subtotal (NOT shipping)
 * - Program policies are data-driven: Creator earns a payout on every paid code order;
 *   Partner retains the historical first-order credit policy; Eigennutzer is credit-only.
 * - Each order snapshots its program conditions, so future configuration changes never
 *   alter historical settlement rights.
 * - All transactions are tracked for transparent accounting
 */

import { z } from "zod";
import { eq, desc, and, inArray, isNull, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { router, publicProcedure, adminProcedure, middleware } from "./trpc.js";
import { getDb, getPool } from "./db.js";
import { partners, partnerAddressRequests, partnerTransactions, orders, orderItems, partnerCodeUsage, customers } from "../drizzle/schema.js";
import { ENV } from "./env.js";
import { bookPaidPartnerCommission, redeemPartnerCreditForOrder } from "./partnerCreditService.js";
import type { Request } from "express";
import {
  createPartnerToken,
  getAuthenticatedPartnerFromRequest,
  PARTNER_COOKIE_NAME,
  PARTNER_TOKEN_EXPIRY,
} from "./partnerAuth.js";
import {
  buildLegacyPartnerCodeTerms,
  calculateSelfOrderDiscountPercent,
  canRedeemShopCredit,
  getPartnerProgram,
  isDiscountAllowedForProgram,
  isRepeatCodeUseAllowed,
  listPartnerCodeTerms,
  normalizePartnerCodeTerms,
  replacePartnerCodes,
  resolveActivePartnerCode,
  splitPartnerCodes,
} from "./partnerProgramService.js";
import { persistAddressValidation, validateGermanAddress } from "./addressValidationService.js";
import { PARTNER_SUPPORT_CONTACT, PARTNER_TECHNICAL_CONTACT } from "./partnerContactProfile.js";
// ─── Partner Auth Helpers ─────────────────────────────────────────
// Middleware for partner-authenticated procedures
const isPartner = middleware(async ({ ctx, next }) => {
  const partner = await getAuthenticatedPartnerFromRequest(ctx.req);
  if (!partner) {
    const { TRPCError } = await import("@trpc/server");
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Partner-Login erforderlich" });
  }
  return next({ ctx: { ...ctx, partner } });
});

const partnerProcedure = publicProcedure.use(isPartner);

const partnerAddressInput = z.object({
  street: z.string().trim().min(1).max(300),
  houseNumber: z.string().trim().max(100).optional().default(""),
  zip: z.string().trim().min(1).max(30),
  city: z.string().trim().min(1).max(100),
  country: z.string().trim().min(1).max(100),
});

const partnerAddressUpdateInput = partnerAddressInput.extend({
  addressValidationOverride: z.object({ confirmed: z.literal(true) }).optional(),
});

const partnerCodeTermsInput = z.object({
  id: z.number().int().positive().optional(),
  code: z.string().trim().min(1).max(50),
  commissionPercent: z.number().min(0).max(100),
  customerDiscountPercent: z.number().min(0).max(100),
  isActive: z.boolean().optional(),
});

type PartnerAddress = z.infer<typeof partnerAddressInput>;

async function getPartnerAttributionCodes(partnerId: number, legacyCsv: string): Promise<string[]> {
  const storedCodes = await listPartnerCodeTerms(partnerId);
  return [...new Set([
    ...splitPartnerCodes(legacyCsv),
    ...storedCodes.map((entry) => entry.code),
  ])];
}

function partnerAttributionWhere(partnerId: number, codes: string[]) {
  // All post-program orders use partner_source_id. The code-only fallback is
  // deliberately limited to legacy rows with no source ID, so no order can be
  // attributed to two partners when a historical CSV mirror changes.
  return codes.length > 0
    ? or(
        eq(orders.partnerSourceId, partnerId),
        and(isNull(orders.partnerSourceId), inArray(orders.partnerCode, codes)),
      )
    : eq(orders.partnerSourceId, partnerId);
}

function normalisePartnerAddress(address: PartnerAddress) {
  return {
    street: address.street.trim(),
    houseNumber: address.houseNumber.trim(),
    zip: address.zip.trim(),
    city: address.city.trim(),
    country: address.country.trim(),
  };
}

function addressFingerprint(address: Record<string, string>): string {
  return createHash("sha256")
    .update(JSON.stringify({
      street: address.street.trim().toLowerCase(),
      houseNumber: address.houseNumber.trim().toLowerCase(),
      zip: address.zip.trim().toLowerCase(),
      city: address.city.trim().toLowerCase(),
      country: address.country.trim().toLowerCase(),
    }))
    .digest("hex");
}

function serialisePartnerAddress(address: Record<string, string | null | undefined>): string {
  return JSON.stringify({
    street: address.street || "",
    houseNumber: address.houseNumber || "",
    zip: address.zip || "",
    city: address.city || "",
    country: address.country || "",
  });
}

function partnerAddressValidationError(warnings: Array<{ message: string }>): Error {
  return new Error(`PARTNER_ADRESSE_UNGUELTIG: ${warnings.map((warning) => warning.message).join(" ")}`);
}

async function getPartnerAddressNotificationRecipients(): Promise<string[]> {
  const pool = await getPool();
  if (!pool) return [];
  const result = await pool.query<{ value: string }>(
    "SELECT value FROM shop_settings WHERE key = 'partner_address_request_notification_recipients' LIMIT 1"
  );
  const raw = result.rows[0]?.value || "";
  return raw.split(/[;,\n]/).map((value) => value.trim()).filter((value) => z.string().email().safeParse(value).success);
}

async function isPartnerAddressNotificationEnabled(): Promise<boolean> {
  const pool = await getPool();
  if (!pool) return false;
  const result = await pool.query<{ value: string }>(
    "SELECT value FROM shop_settings WHERE key = 'partner_address_request_notification_enabled' LIMIT 1"
  );
  return result.rows[0]?.value !== "false";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'\"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;",
  }[character] || character));
}

async function sendPartnerAddressRequestNotification(request: {
  id: number;
  partnerName: string;
  partnerNumber: string;
  partnerEmail: string | null;
  currentAddress: Record<string, string>;
  requestedAddress: Record<string, string>;
}): Promise<{ sent: boolean; error?: string }> {
  if (!await isPartnerAddressNotificationEnabled()) return { sent: false, error: "Benachrichtigungen sind zentral deaktiviert" };
  const recipients = await getPartnerAddressNotificationRecipients();
  if (!ENV.resendApiKey || recipients.length === 0) {
    return { sent: false, error: "Kein zentral konfigurierter Benachrichtigungsempfänger" };
  }

  const formatAddress = (address: Record<string, string>) =>
    `${escapeHtml(address.street)} ${escapeHtml(address.houseNumber)}<br>${escapeHtml(address.zip)} ${escapeHtml(address.city)}<br>${escapeHtml(address.country)}`;
  const html = `<!doctype html><html lang="de"><body style="font-family:Arial,sans-serif;color:#111827;line-height:1.5">
    <h2>Partnerportal: Adressänderung prüfen</h2>
    <p><strong>${escapeHtml(request.partnerName)}</strong> (${escapeHtml(request.partnerNumber)}) hat eine Lieferadressänderung beantragt.</p>
    <table style="border-collapse:collapse"><tr><td style="padding:8px 20px 8px 0;vertical-align:top"><strong>Bisher</strong><br>${formatAddress(request.currentAddress)}</td><td style="padding:8px;vertical-align:top"><strong>Beantragt</strong><br>${formatAddress(request.requestedAddress)}</td></tr></table>
    <p>Die Änderung ist in der WaWi unter <strong>Partner / Affiliates</strong> als offener Antrag sichtbar und muss dort ausdrücklich freigegeben oder abgelehnt werden.</p>
    <p style="color:#6b7280;font-size:12px">Partner-E-Mail: ${escapeHtml(request.partnerEmail || "nicht hinterlegt")} · Antrag #${request.id}</p>
  </body></html>`;

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${ENV.resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "369 Research <noreply@coreversand.de>",
        reply_to: "support@369research.eu",
        to: recipients,
        subject: `Adressänderung prüfen: ${request.partnerName} (${request.partnerNumber})`,
        html,
      }),
    });
    if (!response.ok) return { sent: false, error: `Resend antwortete mit HTTP ${response.status}` };
    return { sent: true };
  } catch (error) {
    return { sent: false, error: error instanceof Error ? error.message : "Unbekannter Versandfehler" };
  }
}

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

      return Promise.all(allPartners.map(async (p) => ({
        ...p,
        commissionPercent: parseFloat(p.commissionPercent),
        customerDiscountPercent: parseFloat(p.customerDiscountPercent),
        creditBalance: parseFloat(p.creditBalance),
        codeTerms: await listPartnerCodeTerms(p.id),
        passwordHash: undefined, // Never expose
      })));
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
      const codeTerms = await listPartnerCodeTerms(input.id);

      return {
        ...partner,
        commissionPercent: parseFloat(partner.commissionPercent),
        customerDiscountPercent: parseFloat(partner.customerDiscountPercent),
        creditBalance: parseFloat(partner.creditBalance),
        codeTerms,
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

  // Offene oder erledigte Partneradressanträge für die WaWi-Prüfung.
  addressRequests: adminProcedure
    .input(z.object({ status: z.enum(["open", "approved", "rejected", "all"]).optional() }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const query = db.select().from(partnerAddressRequests).orderBy(desc(partnerAddressRequests.createdAt));
      const requests = input?.status && input.status !== "all"
        ? await query.where(eq(partnerAddressRequests.status, input.status))
        : await query;
      return requests.map((request) => ({
        ...request,
        currentAddress: JSON.parse(request.currentAddressJson),
        requestedAddress: JSON.parse(request.requestedAddressJson),
      }));
    }),

  // Freigabe ist die einzige Stelle, an der die kanonische Partneradresse aus einem Portal-Antrag geändert wird.
  reviewAddressRequest: adminProcedure
    .input(z.object({
      requestId: z.number().int().positive(),
      decision: z.enum(["approve", "reject"]),
      reviewNote: z.string().trim().max(2000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const pool = await getPool();
      if (!pool) throw new Error("Database not available");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query<{
          id: number; partner_id: number; status: string; requested_address_json: string;
        }>("SELECT id, partner_id, status, requested_address_json FROM partner_address_requests WHERE id = $1 FOR UPDATE", [input.requestId]);
        const request = result.rows[0];
        if (!request) throw new Error("Adressantrag nicht gefunden");
        if (request.status !== "open") throw new Error("Dieser Adressantrag wurde bereits bearbeitet");

        const reviewedBy = (ctx as any).user?.username || (ctx as any).user?.name || "admin";
        const reviewNote = input.reviewNote || null;
        if (input.decision === "approve") {
          let address: PartnerAddress;
          try {
            address = normalisePartnerAddress(partnerAddressInput.parse(JSON.parse(request.requested_address_json)));
          } catch {
            throw new Error("Der gespeicherte Adressantrag ist unvollständig");
          }
          await client.query(
            `UPDATE partners SET street = $1, house_number = $2, zip = $3, city = $4, country = $5, updated_at = NOW() WHERE id = $6`,
            [address.street, address.houseNumber || null, address.zip, address.city, address.country, request.partner_id]
          );
        }
        await client.query(
          `UPDATE partner_address_requests
           SET status = $1, reviewed_at = NOW(), reviewed_by = $2, review_note = $3, updated_at = NOW()
           WHERE id = $4`,
          [input.decision === "approve" ? "approved" : "rejected", reviewedBy, reviewNote, request.id]
        );
        await client.query("COMMIT");
        return { success: true, status: input.decision === "approve" ? "approved" : "rejected" };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }),

  // Create new partner
  create: adminProcedure
    .input(z.object({
      name: z.string().min(1),
      email: z.string().email().optional().or(z.literal("")),
      phone: z.string().optional(),
      company: z.string().optional(),
      code: z.string().min(2).max(500).optional(),
      codes: z.array(partnerCodeTermsInput).min(1).optional(),
      partnerNumber: z.string().min(2).max(50),
      commissionPercent: z.number().min(0).max(100),
      customerDiscountPercent: z.number().min(0).max(100),
      commissionType: z.enum(["einmalig", "dauerhaft"]).optional(),
      programKey: z.enum(["creator", "partner", "self_user"]).optional(),
      password: z.string().min(6).optional(),
      notes: z.string().optional(),
      street: z.string().optional(),
      houseNumber: z.string().optional(),
      zip: z.string().optional(),
      city: z.string().optional(),
      country: z.string().optional(),
    }).refine((value) => Boolean(value.code || value.codes?.length), {
      message: "Mindestens ein Partnercode ist erforderlich",
      path: ["codes"],
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const codeTerms = input.codes
        ? normalizePartnerCodeTerms(input.codes)
        : normalizePartnerCodeTerms(splitPartnerCodes(input.code || "").map((code) => ({
            code,
            commissionPercent: input.commissionPercent,
            customerDiscountPercent: input.customerDiscountPercent,
            isActive: true,
          })));
      const activeCodes = codeTerms.filter((entry) => entry.isActive).map((entry) => entry.code);
      const pool = await getPool();
      if (!pool) throw new Error("Database not available");
      const duplicateCode = await pool.query(
        "SELECT code_normalized FROM partner_codes WHERE code_normalized = ANY($1::varchar[])",
        [codeTerms.map((entry) => entry.code)],
      );
      if (duplicateCode.rows.length > 0) throw new Error(`Code "${duplicateCode.rows[0].code_normalized}" ist bereits vergeben`);

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
        code: activeCodes.join(", "),
        partnerNumber: input.partnerNumber,
        street: input.street || null,
        houseNumber: input.houseNumber || null,
        zip: input.zip || null,
        city: input.city || null,
        country: input.country || null,
        commissionPercent: input.commissionPercent.toFixed(2),
        customerDiscountPercent: input.customerDiscountPercent.toFixed(2),
        commissionType: input.commissionType || "dauerhaft",
        programKey: input.programKey || (input.commissionType === "einmalig" ? "creator" : "partner"),
        creditBalance: "0.00",
        passwordHash,
        notes: input.notes || null,
      }).returning();

      const storedCodes = await replacePartnerCodes(newPartner.id, codeTerms);
      console.log(`[Partners] Created partner: ${input.name} (Code: ${activeCodes.join(", ")}, Nr: ${input.partnerNumber}, Program: ${newPartner.programKey})`);
      return { ...newPartner, codeTerms: storedCodes, passwordHash: undefined };
    }),

  // Update partner
  update: adminProcedure
    .input(z.object({
      id: z.number(),
      name: z.string().min(1).optional(),
      code: z.string().min(1).optional(),
      codes: z.array(partnerCodeTermsInput).min(1).optional(),
      email: z.string().email().optional().or(z.literal("")),
      phone: z.string().optional(),
      company: z.string().optional(),
      commissionPercent: z.number().min(0).max(100).optional(),
      customerDiscountPercent: z.number().min(0).max(100).optional(),
      commissionType: z.enum(["einmalig", "dauerhaft"]).optional(),
      programKey: z.enum(["creator", "partner", "self_user"]).optional(),
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

      const existingCodeTerms = input.codes || input.code !== undefined
        ? await listPartnerCodeTerms(input.id)
        : [];
      const nextCommissionDefault = input.commissionPercent;
      const nextDiscountDefault = input.customerDiscountPercent;
      const requestedCodeTerms = input.codes
        ? normalizePartnerCodeTerms(input.codes)
        : input.code === undefined
          ? null
          : buildLegacyPartnerCodeTerms(
              input.code,
              existingCodeTerms,
              {
                commissionPercent: nextCommissionDefault ?? Number(existingCodeTerms[0]?.commissionPercent ?? 0),
                customerDiscountPercent: nextDiscountDefault ?? Number(existingCodeTerms[0]?.customerDiscountPercent ?? 0),
              },
            );

      const updateData: Record<string, any> = { updatedAt: new Date() };
      if (input.name !== undefined) updateData.name = input.name;
      if (input.email !== undefined) updateData.email = input.email || null;
      if (input.phone !== undefined) updateData.phone = input.phone || null;
      if (input.company !== undefined) updateData.company = input.company || null;
      if (input.commissionPercent !== undefined) updateData.commissionPercent = input.commissionPercent.toFixed(2);
      if (input.customerDiscountPercent !== undefined) updateData.customerDiscountPercent = input.customerDiscountPercent.toFixed(2);
      if (input.commissionType !== undefined) updateData.commissionType = input.commissionType;
      if (input.programKey !== undefined) updateData.programKey = input.programKey;
      if (input.isActive !== undefined) updateData.isActive = input.isActive;
      if (input.notes !== undefined) updateData.notes = input.notes || null;
      if (input.street !== undefined) updateData.street = input.street || null;
      if (input.houseNumber !== undefined) updateData.houseNumber = input.houseNumber || null;
      if (input.zip !== undefined) updateData.zip = input.zip || null;
      if (input.city !== undefined) updateData.city = input.city || null;
      if (input.country !== undefined) updateData.country = input.country || null;

      await db.update(partners).set(updateData).where(eq(partners.id, input.id));
      const storedCodes = requestedCodeTerms
        ? await replacePartnerCodes(input.id, requestedCodeTerms)
        : await listPartnerCodeTerms(input.id);
      return { success: true, codeTerms: storedCodes };
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
      requestId: z.string().uuid(),
    }))
    .mutation(async ({ input }) => {
      const pool = await getPool();
      if (!pool) throw new Error("Database not available");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`partner-adjust:${input.partnerId}`]);

        const duplicate = await client.query<{ balance_after: string }>(
          `SELECT balance_after FROM partner_transactions
            WHERE partner_id = $1 AND type = 'korrektur' AND admin_note = $2
            LIMIT 1`,
          [input.partnerId, `request:${input.requestId}`],
        );
        if (duplicate.rows.length > 0) {
          await client.query("COMMIT");
          return { success: true, newBalance: Number(duplicate.rows[0].balance_after), alreadyApplied: true };
        }

        const partnerResult = await client.query<{ name: string; credit_balance: string }>(
          "SELECT name, credit_balance FROM partners WHERE id = $1 FOR UPDATE",
          [input.partnerId],
        );
        if (partnerResult.rows.length !== 1) throw new Error("Partner nicht gefunden");
        const partner = partnerResult.rows[0];
        const currentBalance = Number(partner.credit_balance);
        const newBalance = Math.round((currentBalance + input.amount + Number.EPSILON) * 100) / 100;
        if (newBalance < -0.001) throw new Error("Eine manuelle Korrektur darf das Partnerguthaben nicht negativ machen");

        await client.query(
          "UPDATE partners SET credit_balance = $1, updated_at = NOW() WHERE id = $2",
          [newBalance.toFixed(2), input.partnerId],
        );
        await client.query(
          `INSERT INTO partner_transactions
            (partner_id, type, amount, balance_after, description, admin_note, status)
           VALUES ($1, 'korrektur', $2, $3, $4, $5, 'normal')`,
          [input.partnerId, input.amount.toFixed(2), newBalance.toFixed(2), input.description, `request:${input.requestId}`],
        );
        await client.query("COMMIT");
        console.log(`[Partners] Credit adjustment for ${partner.name}: ${input.amount > 0 ? "+" : ""}${input.amount.toFixed(2)} EUR (${input.description})`);
        return { success: true, newBalance, alreadyApplied: false };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
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
      const codeTerms = await listPartnerCodeTerms(partner.id);
      const attributionCodes = await getPartnerAttributionCodes(partner.id, partner.code);

      // Get all transactions
      const transactions = await db.select().from(partnerTransactions)
        .where(eq(partnerTransactions.partnerId, input.partnerId))
        .orderBy(desc(partnerTransactions.createdAt));

      // Get all orders referred by this partner
      const referredOrders = await db.select().from(orders)
        .where(partnerAttributionWhere(partner.id, attributionCodes))
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
          codeTerms,
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
          appliedPartnerCode: o.partnerCode,
          partnerCodeIdSnapshot: o.partnerCodeIdSnapshot,
          partnerDiscount: parseFloat(o.partnerDiscount || "0"),
          partnerCommission: parseFloat(o.partnerCommission || "0"),
          partnerCommissionPercentSnapshot: o.partnerCommissionPercentSnapshot === null ? null : parseFloat(o.partnerCommissionPercentSnapshot),
          partnerCustomerDiscountPercentSnapshot: o.partnerCustomerDiscountPercentSnapshot === null ? null : parseFloat(o.partnerCustomerDiscountPercentSnapshot),
          partnerCommissionBaseSnapshot: o.partnerCommissionBaseSnapshot === null ? null : parseFloat(o.partnerCommissionBaseSnapshot),
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

  // Assign a partner to a customer. Historical orders are deliberately never
  // credited here: attribution changes must not silently create past payouts.
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

      const [partner] = await db.select().from(partners)
        .where(and(eq(partners.id, input.partnerId), eq(partners.isActive, 1)))
        .limit(1);
      if (!partner) throw new Error("Aktiver Partner nicht gefunden");

      // Update customer with partner assignment
      await db.update(customers).set({
        acquiredBy: "partner",
        acquiredByPartnerId: input.partnerId,
        updatedAt: new Date(),
      }).where(eq(customers.id, input.customerId));

      console.log(`[Partners] Assigned partner ${partner.name} to customer ${customer.name}; no historical commission was created.`);
      return {
        success: true,
        commissionsBooked: 0,
        totalCommission: 0,
        newBalance: parseFloat(partner.creditBalance),
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
      requestId: z.string().uuid(),
    }))
    .mutation(async ({ input }) => {
      const pool = await getPool();
      if (!pool) throw new Error("Database not available");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`partner-payout:${input.partnerId}`]);
        const duplicate = await client.query<{ balance_after: string }>(
          `SELECT balance_after FROM partner_transactions
            WHERE partner_id = $1 AND type = 'auszahlung' AND admin_note = $2
            LIMIT 1`,
          [input.partnerId, `request:${input.requestId}`],
        );
        if (duplicate.rows.length > 0) {
          await client.query("COMMIT");
          return { success: true, newBalance: Number(duplicate.rows[0].balance_after), alreadyApplied: true };
        }

        const partnerResult = await client.query<{ name: string; credit_balance: string }>(
          "SELECT name, credit_balance FROM partners WHERE id = $1 FOR UPDATE",
          [input.partnerId],
        );
        if (partnerResult.rows.length !== 1) throw new Error("Partner nicht gefunden");
        const partner = partnerResult.rows[0];
        const currentBalance = Number(partner.credit_balance);
        if (input.amount > currentBalance + 0.001) {
          throw new Error(`Nicht genügend Guthaben für Auszahlung. Verfügbar: ${currentBalance.toFixed(2)} €`);
        }
        const newBalance = Math.round((currentBalance - input.amount + Number.EPSILON) * 100) / 100;
        await client.query(
          "UPDATE partners SET credit_balance = $1, updated_at = NOW() WHERE id = $2",
          [newBalance.toFixed(2), input.partnerId],
        );
        await client.query(
          `INSERT INTO partner_transactions
            (partner_id, type, amount, balance_after, description, admin_note, status)
           VALUES ($1, 'auszahlung', $2, $3, $4, $5, 'normal')`,
          [
            input.partnerId,
            (-input.amount).toFixed(2),
            newBalance.toFixed(2),
            input.description || `Monetäre Auszahlung: ${input.amount.toFixed(2)} €`,
            `request:${input.requestId}`,
          ],
        );
        await client.query("COMMIT");
        console.log(`[Partners] Payout recorded: ${input.amount.toFixed(2)} EUR for ${partner.name}`);
        return { success: true, newBalance, alreadyApplied: false };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }),

  // ─── PUBLIC: Checkout integration ──────────────────────────────

  // Validate a partner code (public – called from checkout)
  // A Creator code grants its configured customer discount on every valid use.
  // Historical Partner and Eigennutzer conditions remain separately configured.
  validateCode: publicProcedure
    .input(z.object({ code: z.string(), customerEmail: z.string().optional() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const resolved = await resolveActivePartnerCode(input.code);
      if (!resolved) {
        return { valid: false, discountPercent: 0, partnerName: null, discountEligible: false, reason: "code_not_found" };
      }

      let discountEligible = isDiscountAllowedForProgram(resolved.program, input.customerEmail, resolved.partnerEmail);
      let reason: string | null = null;
      if (!discountEligible) {
        reason = resolved.program.customerDiscountPolicy === "own_email_only"
          ? (input.customerEmail ? "eigennutzer_locked" : "eigennutzer_email_required")
          : "program_inactive";
      }

      // Creators explicitly allow unlimited valid code use. The legacy partner
      // program retains its existing first-paid-code-order policy.
      if (input.customerEmail && discountEligible && !isRepeatCodeUseAllowed(resolved.program)) {
        const customerEmail = input.customerEmail.toLowerCase().trim();
        // Legacy records are matched by the normalized actual code, not a comma list.
        const previousOrders = await db.select().from(orders)
          .where(and(
            eq(orders.partnerCode, resolved.partnerCode),
            eq(orders.email, customerEmail)
          ));
        const previousPaidOrders = previousOrders.filter(o =>
          o.status === "bezahlt" || o.status === "gepackt" || o.status === "versendet" || o.status === "zugestellt"
        );
        if (previousPaidOrders.length > 0) {
          discountEligible = false;
          reason = "already_used";
          console.log(`[Partners] validateCode: Customer ${customerEmail} already has ${previousPaidOrders.length} paid orders with code ${resolved.partnerCode} – discount not eligible`);
        }
      }

      return {
        valid: true,
        codeId: resolved.codeId,
        partnerCode: resolved.partnerCode,
        discountPercent: discountEligible ? resolved.customerDiscountPercent : 0,
        partnerName: resolved.partnerName,
        commissionType: resolved.program.key === "creator" ? "einmalig" : "dauerhaft",
        programKey: resolved.program.key,
        settlementMethod: resolved.program.settlementMethod,
        discountEligible,
        reason,
      };
    }),

  // Public existence check for the two-step checkout login. Financial and address data
  // are deliberately returned only by portalLogin after password verification.
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
        return { valid: false };
      }

      return { valid: true };
    }),

  // ─── INTERNAL: payment-bound commission booking ────────────────
  // Compatibility endpoint: amount and customer data are deliberately ignored.
  // The persisted paid order is the only source of truth.
  bookCommission: adminProcedure
    .input(z.object({
      orderId: z.string(),
      partnerCode: z.string(),
      productSubtotalAfterDiscount: z.number(),
      customerName: z.string(),
      customerEmail: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const result = await bookPaidPartnerCommission(input.orderId);
      return {
        success: result.booked,
        commissionAmount: result.amount,
        newBalance: result.balance,
        reason: result.reason,
        message: result.booked
          ? "Provision wurde nach bestätigtem Zahlungseingang gebucht"
          : `Keine neue Provision gebucht: ${result.reason}`,
      };
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
      const program = await getPartnerProgram(partner.id);
      if (!program) throw new Error("Partnerprogramm nicht verfügbar");
      const selfOrderDiscountPercent = calculateSelfOrderDiscountPercent(
        program,
        parseFloat(partner.customerDiscountPercent),
        parseFloat(partner.commissionPercent),
      );

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
          programKey: partner.programKey,
          creditBalance: parseFloat(partner.creditBalance),
          customerDiscountPercent: parseFloat(partner.customerDiscountPercent),
          selfOrderDiscountPercent,
          address: {
            street: partner.street || "",
            houseNumber: partner.houseNumber || "",
            zip: partner.zip || "",
            city: partner.city || "",
            country: partner.country || "",
          },
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
      const program = await getPartnerProgram(partner.id);
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
        programKey: partner.programKey,
        creditBalance: parseFloat(partner.creditBalance),
        selfOrderDiscountPercent: program
          ? calculateSelfOrderDiscountPercent(
              program,
              parseFloat(partner.customerDiscountPercent),
              parseFloat(partner.commissionPercent),
            )
          : parseFloat(partner.customerDiscountPercent),
        address: {
          street: partner.street || "",
          houseNumber: partner.houseNumber || "",
          zip: partner.zip || "",
          city: partner.city || "",
          country: partner.country || "",
        },
      };
    }),

  // Aktuellen offenen Adressantrag für die Partnerportal-Einstellungen anzeigen.
  portalAddressRequestStatus: partnerProcedure
    .query(async ({ ctx }) => {
      const partner = (ctx as any).partner;
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const [request] = await db.select().from(partnerAddressRequests)
        .where(and(eq(partnerAddressRequests.partnerId, partner.id), eq(partnerAddressRequests.status, "open")))
        .orderBy(desc(partnerAddressRequests.updatedAt))
        .limit(1);
      if (!request) return null;
      return {
        id: request.id,
        status: request.status,
        requestedAddress: JSON.parse(request.requestedAddressJson),
        createdAt: request.createdAt,
        updatedAt: request.updatedAt,
      };
    }),

  // An authenticated partner owns their own delivery address. Every direct
  // change is validated first and retained as an immutable approved audit row;
  // no other partner, customer or historic order can be altered through this route.
  portalUpdateDeliveryAddress: partnerProcedure
    .input(partnerAddressUpdateInput)
    .mutation(async ({ ctx, input }) => {
      const partner = (ctx as any).partner;
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const requestedAddress = normalisePartnerAddress(input);
      const currentAddress = {
        street: partner.street || "",
        houseNumber: partner.houseNumber || "",
        zip: partner.zip || "",
        city: partner.city || "",
        country: partner.country || "",
      };
      if (addressFingerprint(requestedAddress) === addressFingerprint(currentAddress)) {
        return { success: true, alreadyCurrent: true, message: "Diese Lieferadresse ist bereits hinterlegt." };
      }

      const validation = await validateGermanAddress({
        ...requestedAddress,
        deliveryType: "home",
      });
      const needsExplicitConfirmation = validation.applicable
        && (validation.status === "warning" || validation.status === "unavailable");
      if (needsExplicitConfirmation && input.addressValidationOverride?.confirmed !== true) {
        throw partnerAddressValidationError(validation.warnings);
      }

      if (needsExplicitConfirmation) {
        await persistAddressValidation({
          input: { ...requestedAddress, deliveryType: "home" },
          result: validation,
          context: "partner_address_update",
          overrideConfirmed: true,
          confirmedBy: `Partner ${partner.partnerNumber}`,
        });
      }

      await db.transaction(async (tx) => {
        await tx.update(partners).set({
          street: requestedAddress.street,
          houseNumber: requestedAddress.houseNumber || null,
          zip: requestedAddress.zip,
          city: requestedAddress.city,
          country: requestedAddress.country,
          updatedAt: new Date(),
        }).where(eq(partners.id, partner.id));

        // Supersede any still-open request: the portal owner has now saved a
        // newer verified address directly, so an older admin approval must not
        // overwrite it later.
        await tx.update(partnerAddressRequests).set({
          status: "rejected",
          reviewedAt: new Date(),
          reviewedBy: `partner:${partner.partnerNumber}`,
          reviewNote: "Durch die spätere direkte, validierte Partner-Adressänderung ersetzt.",
          updatedAt: new Date(),
        }).where(and(
          eq(partnerAddressRequests.partnerId, partner.id),
          eq(partnerAddressRequests.status, "open"),
        ));

        await tx.insert(partnerAddressRequests).values({
          partnerId: partner.id,
          partnerNameSnapshot: partner.name,
          partnerNumberSnapshot: partner.partnerNumber,
          partnerEmailSnapshot: partner.email || null,
          currentAddressJson: serialisePartnerAddress(currentAddress),
          requestedAddressJson: serialisePartnerAddress(requestedAddress),
          requestFingerprint: addressFingerprint(requestedAddress),
          status: "approved",
          notificationStatus: "not_required",
          reviewedAt: new Date(),
          reviewedBy: `partner:${partner.partnerNumber}`,
          reviewNote: "Direkte, durch den angemeldeten Partner bestätigte und validierte Lieferadressänderung.",
        });
      });

      return {
        success: true,
        alreadyCurrent: false,
        message: "Lieferadresse wurde geprüft und für zukünftige Partnerbestellungen gespeichert.",
      };
    }),

  // A portal partner can request, never directly overwrite, the canonical delivery address.
  portalRequestAddressChange: partnerProcedure
    .input(partnerAddressInput)
    .mutation(async ({ ctx, input }) => {
      const partner = (ctx as any).partner;
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const requestedAddress = normalisePartnerAddress(input);
      const currentAddress = {
        street: partner.street || "",
        houseNumber: partner.houseNumber || "",
        zip: partner.zip || "",
        city: partner.city || "",
        country: partner.country || "",
      };
      const fingerprint = addressFingerprint(requestedAddress);
      if (fingerprint === addressFingerprint(currentAddress)) {
        return { success: true, alreadyCurrent: true, message: "Diese Lieferadresse ist bereits hinterlegt." };
      }

      const [openRequest] = await db.select().from(partnerAddressRequests)
        .where(and(eq(partnerAddressRequests.partnerId, partner.id), eq(partnerAddressRequests.status, "open")))
        .orderBy(desc(partnerAddressRequests.updatedAt))
        .limit(1);

      let requestId: number;
      let shouldNotify = true;
      if (openRequest && openRequest.requestFingerprint === fingerprint) {
        requestId = openRequest.id;
        shouldNotify = false;
      } else if (openRequest) {
        const [updated] = await db.update(partnerAddressRequests).set({
          currentAddressJson: serialisePartnerAddress(currentAddress),
          requestedAddressJson: serialisePartnerAddress(requestedAddress),
          requestFingerprint: fingerprint,
          notificationStatus: "pending",
          notificationError: null,
          notificationSentAt: null,
          updatedAt: new Date(),
        }).where(eq(partnerAddressRequests.id, openRequest.id)).returning({ id: partnerAddressRequests.id });
        requestId = updated.id;
      } else {
        const [created] = await db.insert(partnerAddressRequests).values({
          partnerId: partner.id,
          partnerNameSnapshot: partner.name,
          partnerNumberSnapshot: partner.partnerNumber,
          partnerEmailSnapshot: partner.email || null,
          currentAddressJson: serialisePartnerAddress(currentAddress),
          requestedAddressJson: serialisePartnerAddress(requestedAddress),
          requestFingerprint: fingerprint,
          status: "open",
          notificationStatus: "pending",
        }).returning({ id: partnerAddressRequests.id });
        requestId = created.id;
      }

      let notification: { sent: boolean; error?: string } = { sent: false };
      if (shouldNotify) {
        notification = await sendPartnerAddressRequestNotification({
          id: requestId,
          partnerName: partner.name,
          partnerNumber: partner.partnerNumber,
          partnerEmail: partner.email || null,
          currentAddress,
          requestedAddress,
        });
        await db.update(partnerAddressRequests).set({
          notificationStatus: notification.sent ? "sent" : "failed",
          notificationError: notification.error || null,
          notificationSentAt: notification.sent ? new Date() : null,
          updatedAt: new Date(),
        }).where(eq(partnerAddressRequests.id, requestId));
      }

      return {
        success: true,
        requestId,
        notificationSent: notification.sent,
        message: shouldNotify
          ? "Adressänderung wurde gespeichert und zur Prüfung weitergeleitet."
          : "Der gleiche Adressantrag ist bereits zur Prüfung gespeichert.",
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
      const attributionCodes = await getPartnerAttributionCodes(partner.id, partner.code);

      // Only show paid orders
      const { inArray } = await import("drizzle-orm");
      const paidStatuses = ["bezahlt", "gepackt", "versendet", "zugestellt"] as const;
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
          partnerAttributionWhere(partner.id, attributionCodes),
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
      const paidStatuses = ["bezahlt", "gepackt", "versendet", "zugestellt"] as const;
      const attributionCodes = await getPartnerAttributionCodes(partner.id, partner.code);

      const referredOrders = await db.select({
        total: orders.total,
        subtotal: orders.subtotal,
        discount: orders.discount,
        shipping: orders.shipping,
        partnerCommission: orders.partnerCommission,
      }).from(orders)
        .where(and(
          partnerAttributionWhere(partner.id, attributionCodes),
          inArray(orders.status, paidStatuses)
        ));
      const totalOrders = referredOrders.length;
      // totalRevenue = Nettoumsatz nach Rabatten, OHNE Versand (= Basis für Provision)
      const totalRevenue = referredOrders.reduce((sum, o) => {
        const netto = Math.max(0, parseFloat(o.subtotal || "0") - parseFloat(o.discount || "0"));
        return sum + netto;
      }, 0);
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
        programKey: partner.programKey,
        commissionPercent: parseFloat(partner.commissionPercent),
        customerDiscountPercent: parseFloat(partner.customerDiscountPercent),
      };
    }),

  // ─── PARTNER PORTAL: Checkout credit redemption ────────────────

  // Partner-authenticated credit check for checkout (more secure than public checkCredit)
  portalMyCredit: partnerProcedure
    .query(async ({ ctx }) => {
      const partner = (ctx as any).partner;
      const program = await getPartnerProgram(partner.id);
      return {
        creditBalance: parseFloat(partner.creditBalance),
        partnerName: partner.name,
        partnerNumber: partner.partnerNumber,
        commissionType: partner.commissionType,
        programKey: program?.key || partner.programKey,
        creditRedeemable: Boolean(program && canRedeemShopCredit(program)),
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
      const program = await getPartnerProgram(partner.id);
      if (!program || !canRedeemShopCredit(program)) {
        throw new Error("Dieses Programm führt Provisionen als Auszahlung und hat kein Shopguthaben zur Einlösung");
      }

      const [order] = await db.select().from(orders).where(eq(orders.orderId, input.orderId)).limit(1);
      if (!order || order.partnerNumber !== partner.partnerNumber) {
        throw new Error("Bestellung gehört nicht zu diesem Partner");
      }
      if (Math.abs(parseFloat(order.creditUsed || "0") - input.amount) > 0.005) {
        throw new Error("Guthabeneinsatz stimmt nicht mit der gespeicherten Bestellung überein");
      }

      const result = await redeemPartnerCreditForOrder(input.orderId);
      return {
        success: true,
        amountRedeemed: result.redeemed,
        newBalance: result.balance,
        alreadyBooked: result.alreadyBooked,
      };
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
      const program = await getPartnerProgram(partner.id);
      if (!program || !canRedeemShopCredit(program)) {
        throw new Error("Dieses Programm führt Provisionen als Auszahlung und hat kein Shopguthaben zur Einlösung");
      }

      // Verify password
      if (!partner.passwordHash) {
        throw new Error("Kein Passwort gesetzt. Bitte wenden Sie sich an 369 Research.");
      }
      const validPw = await bcrypt.compare(input.password, partner.passwordHash);
      if (!validPw) {
        throw new Error("Falsches Passwort");
      }

      const [order] = await db.select().from(orders).where(eq(orders.orderId, input.orderId)).limit(1);
      if (!order || order.partnerNumber !== partner.partnerNumber) {
        throw new Error("Bestellung gehört nicht zu diesem Partner");
      }
      if (Math.abs(parseFloat(order.creditUsed || "0") - input.amount) > 0.005) {
        throw new Error("Guthabeneinsatz stimmt nicht mit der gespeicherten Bestellung überein");
      }

      const result = await redeemPartnerCreditForOrder(input.orderId);
      return { success: true, newBalance: result.balance, alreadyBooked: result.alreadyBooked };
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
      <p style="color:#64748b;font-size:12px;margin:16px 0 0;">Technische Hilfe: <a href="mailto:${PARTNER_TECHNICAL_CONTACT.email}" style="color:#60a5fa;">${PARTNER_TECHNICAL_CONTACT.email}</a></p>
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
            from: PARTNER_TECHNICAL_CONTACT.from,
            reply_to: PARTNER_TECHNICAL_CONTACT.replyTo,
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
      <p style="margin:4px 0 0;font-size:12px;color:#475569;">Allgemeine Partnerfragen: <a href="mailto:${PARTNER_SUPPORT_CONTACT.email}" style="color:#93c5fd;">${PARTNER_SUPPORT_CONTACT.email}</a></p>
      <p style="margin:4px 0 0;font-size:12px;color:#475569;">Technische Probleme im Partner-Portal: <a href="mailto:${PARTNER_TECHNICAL_CONTACT.email}" style="color:#93c5fd;">${PARTNER_TECHNICAL_CONTACT.email}</a></p>
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
          from: PARTNER_SUPPORT_CONTACT.from,
          reply_to: PARTNER_SUPPORT_CONTACT.replyTo,
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

  // ─── ADMIN: Reconciliation gate ────────────────────────────────────────────
  // Automatic rewriting of historical balances was removed. A reconciliation must
  // produce an order-level report and receive an explicit booking decision.
  recalcCommissions: adminProcedure
    .mutation(async () => {
      return {
        success: true,
        fixed: 0,
        log: ["Automatische historische Provisionskorrekturen sind gesperrt. Erst eine prüfbare Einzelabrechnung erstellen und dann ausdrücklich freigeben."],
      };
    }),
});
