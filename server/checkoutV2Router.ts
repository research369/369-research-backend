import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { router, publicProcedure } from "./trpc.js";
import { getDb } from "./db.js";
import { articles, orders, partners, promoCodes } from "../drizzle/schema.js";
import { getPool } from "./db.js";
import { computeBalanceFromLedger, isKwkEnabled, KWK_DISCOUNT_PERCENT } from "./kwkService.js";
import { verifyKwkToken } from "./kwkAuth.js";
import {
  calculateCheckoutV2Quote,
  CheckoutV2QuoteError,
  type CheckoutV2Benefits,
  type CheckoutV2CatalogArticle,
  type CheckoutV2Promotion,
} from "./checkoutV2Quote.js";

function assertCheckoutV2CommerceStaging(): void {
  if (process.env.CHECKOUT_V2_COMMERCE_STAGING !== "true" || process.env.FEATURE_CHECKOUT_V2_ENABLED !== "true") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Checkout V2 ist in dieser Umgebung nicht verfügbar.",
    });
  }
}

const selectionSchema = z.object({
  shopProductId: z.string().min(1).max(160),
  dosage: z.string().max(160).optional(),
  quantity: z.number().int().min(1).max(99),
  isPlugPlay: z.boolean().optional(),
  isNasalDiySet: z.boolean().optional(),
  isNasalSpray: z.boolean().optional(),
});

const quoteInputSchema = z.object({
  selections: z.array(selectionSchema).min(1).max(50),
  delivery: z.object({
    country: z.string().min(1).max(120),
    deliveryType: z.enum(["home", "packstation"]),
  }),
  customer: z.object({
    email: z.string().email().optional(),
    phone: z.string().max(80).optional(),
  }).optional(),
  /** One field in the checkout. It is resolved promo first, then partner. */
  code: z.string().trim().min(1).max(50).optional(),
  /** Derived from a recognised /r/:code link or explicitly entered by the customer. */
  kwkReferralCode: z.string().trim().min(1).max(80).optional(),
  /** A previously authenticated existing KWK session. Never a raw account ID. */
  kwkCredit: z.object({
    token: z.string().min(1),
    requested: z.number().min(0).max(100000),
  }).optional(),
});

function error(code: string, message: string): never {
  throw new CheckoutV2QuoteError(code, message);
}

function hasPaidOrderStatus(status: string | null | undefined): boolean {
  return ["bezahlt", "gepackt", "versendet", "zugestellt", "abgeholt"].includes(String(status || "").toLowerCase());
}

async function resolvePromotion(input: {
  code?: string;
  customerEmail?: string;
  estimatedSubtotal: number;
}): Promise<CheckoutV2Promotion | undefined> {
  if (!input.code) return undefined;
  const db = await getDb();
  if (!db) throw new Error("Datenbank nicht verfügbar");
  const code = input.code.trim().toUpperCase();

  // Existing precedence: general action code first, then partner code.
  const [promo] = await db.select().from(promoCodes)
    .where(and(eq(promoCodes.code, code), eq(promoCodes.isActive, 1))).limit(1);
  if (promo) {
    const now = new Date();
    if (promo.validFrom && now < promo.validFrom) error("PROMO_NOT_ACTIVE", "Dieser Vorteil ist noch nicht verfügbar.");
    if (promo.validUntil) {
      const end = new Date(promo.validUntil);
      end.setHours(23, 59, 59, 999);
      if (now > end) error("PROMO_EXPIRED", "Dieser Vorteil ist nicht mehr verfügbar.");
    }
    if (promo.maxUses && promo.maxUses > 0 && (promo.currentUses || 0) >= promo.maxUses) {
      error("PROMO_LIMIT_REACHED", "Dieser Vorteil ist nicht mehr verfügbar.");
    }
    const minimum = Number(promo.minOrder || 0);
    if (minimum > 0 && input.estimatedSubtotal < minimum) {
      error("PROMO_MINIMUM_NOT_REACHED", `Dieser Vorteil gilt ab ${minimum.toFixed(2).replace(".", ",")} € Warenwert.`);
    }
    return {
      kind: "promo",
      code,
      promo: {
        discountType: promo.discountType as "percent" | "fixed",
        percentage: Number(promo.percentage || 0),
        fixedAmount: Number(promo.fixedAmount || 0),
        description: promo.description || undefined,
      },
    };
  }

  const [partner] = await db.select().from(partners)
    .where(and(eq(partners.code, code), eq(partners.isActive, 1))).limit(1);
  if (!partner) error("CODE_NOT_FOUND", "Dieser Code ist nicht gültig.");

  // The existing partner rule is first paid order for both partner categories.
  if (!input.customerEmail?.trim()) {
    error("PARTNER_EMAIL_REQUIRED", "Bitte gib deine E-Mail-Adresse ein, damit wir den Partnervorteil prüfen können.");
  }
  const previousOrders = await db.select({ status: orders.status }).from(orders)
    .where(and(eq(orders.partnerCode, partner.code), eq(orders.email, input.customerEmail.trim().toLowerCase())));
  if (previousOrders.some((entry) => hasPaidOrderStatus(entry.status))) {
    error("PARTNER_FIRST_ORDER_ONLY", "Dieser Partnervorteil gilt nur für die erste Bestellung.");
  }

  const isSelfUse = (partner.notes || "").includes("[EIGENNUTZER]");
  if (isSelfUse && partner.email && partner.email.trim().toLowerCase() !== input.customerEmail.trim().toLowerCase()) {
    error("PARTNER_SELF_USE_LOCKED", "Dieser Partnercode ist für diese E-Mail-Adresse nicht verfügbar.");
  }

  return {
    kind: "partner",
    code: partner.code,
    percent: Number(partner.customerDiscountPercent || 0),
  };
}

async function resolveKwkBenefits(input: z.infer<typeof quoteInputSchema>): Promise<Pick<CheckoutV2Benefits, "kwkReferralCode" | "kwkReferralPercent" | "kwkCredit">> {
  const output: Pick<CheckoutV2Benefits, "kwkReferralCode" | "kwkReferralPercent" | "kwkCredit"> = {};
  if (!input.kwkReferralCode && !input.kwkCredit) return output;
  if (!(await isKwkEnabled())) error("KWK_DISABLED", "Das Kundenwerben-Kunden-Programm ist derzeit nicht verfügbar.");

  const pool = await getPool();
  if (!pool) throw new Error("Datenbank nicht verfügbar");
  if (input.kwkReferralCode) {
    const customerEmail = input.customer?.email?.trim().toLowerCase();
    const customerPhone = input.customer?.phone?.replace(/[^0-9]/g, "").replace(/^00/, "").replace(/^0/, "49");
    if (!customerEmail || !customerPhone) {
      error("KWK_CUSTOMER_IDENTITY_REQUIRED", "Bitte gib E-Mail-Adresse und Telefonnummer ein, damit wir den Empfehlungsvorteil prüfen können.");
    }
    const result = await pool.query<{ id: number; status: string; email: string | null; phone: string | null }>(
      "SELECT id, status, email, phone FROM kwk_accounts WHERE referral_code = $1 AND deleted_at IS NULL LIMIT 1",
      [input.kwkReferralCode.trim().toUpperCase()],
    );
    const referral = result.rows[0];
    if (!referral || referral.status !== "aktiv") {
      error("KWK_REFERRAL_INVALID", "Dieser Empfehlungslink ist nicht verfügbar.");
    }
    const referralEmail = String(referral.email || "").trim().toLowerCase();
    const referralPhone = String(referral.phone || "").replace(/[^0-9]/g, "").replace(/^00/, "").replace(/^0/, "49");
    if (customerEmail === referralEmail || (referralPhone && customerPhone === referralPhone)) {
      error("KWK_SELF_REFERRAL_NOT_ALLOWED", "Dieser Empfehlungsvorteil ist für diese Bestellung nicht verfügbar.");
    }
    output.kwkReferralCode = input.kwkReferralCode.trim().toUpperCase();
    output.kwkReferralPercent = KWK_DISCOUNT_PERCENT;
  }
  if (input.kwkCredit) {
    const session = verifyKwkToken(input.kwkCredit.token);
    if (!session) error("KWK_LOGIN_REQUIRED", "Bitte melde dich an, um Guthaben einzulösen.");
    const balance = await computeBalanceFromLedger(session.kwkId);
    output.kwkCredit = { requested: input.kwkCredit.requested, available: balance.available };
  }
  return output;
}

export const checkoutV2Router = router({
  /**
   * Read-only commercial quote. It never creates an order, reserves stock,
   * consumes a code, writes a ledger entry, or initiates a payment.
   */
  quote: publicProcedure.input(quoteInputSchema).query(async ({ input }) => {
    assertCheckoutV2CommerceStaging();
    const db = await getDb();
    if (!db) throw new Error("Datenbank nicht verfügbar");
    const catalog = await db.select({
      sku: articles.sku,
      shopProductId: articles.shopProductId,
      name: articles.name,
      sellingPrice: articles.sellingPrice,
      salePrice: articles.salePrice,
      variants: articles.variants,
      isActive: articles.isActive,
      shopVisible: articles.shopVisible,
      stock: articles.stock,
    }).from(articles).where(eq(articles.isActive, 1));

    // Provisional subtotal is calculated only from the catalog to validate a
    // promotion's minimum amount. The final quote is calculated from scratch.
    const preliminary = calculateCheckoutV2Quote({
      selections: input.selections,
      delivery: input.delivery,
      catalog: catalog as CheckoutV2CatalogArticle[],
    });
    const promotion = await resolvePromotion({
      code: input.code,
      customerEmail: input.customer?.email,
      estimatedSubtotal: preliminary.subtotal,
    });
    const kwk = await resolveKwkBenefits(input);
    return calculateCheckoutV2Quote({
      selections: input.selections,
      delivery: input.delivery,
      catalog: catalog as CheckoutV2CatalogArticle[],
      benefits: { promotion, ...kwk },
    });
  }),
});
