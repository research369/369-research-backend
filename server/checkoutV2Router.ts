import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { router, publicProcedure } from "./trpc.js";
import { getDb } from "./db.js";
import { articles, orders, partners, promoCodes, shopSettings } from "../drizzle/schema.js";
import { getPool } from "./db.js";
import { computeBalanceFromLedger, isKwkEnabled, KWK_DISCOUNT_PERCENT } from "./kwkService.js";
import { normalizeKwkPhone, resolveShippingRegion } from "./kwkCheckoutPricing.js";
import { verifyKwkToken } from "./kwkAuth.js";
import { createOrderForCheckoutV2 } from "./orderRouter.js";
import { getPartnerFromRequest } from "./partnerRouter.js";
import type { Request } from "express";
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
    deliveryType: z.enum(["home", "packstation", "postfiliale"]),
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
  /** Existing partner portal session is resolved server-side; no partner number is accepted here. */
  partnerCredit: z.object({
    requested: z.number().min(0).max(100000),
  }).optional(),
});

type CheckoutV2QuoteInput = z.infer<typeof quoteInputSchema>;

const checkoutV2CustomerSchema = z.object({
  firstName: z.string().trim().min(1).max(200),
  lastName: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320),
  phone: z.string().trim().min(4).max(50),
  street: z.string().trim().min(1).max(300),
  houseNumber: z.string().trim().min(1).max(100),
  zip: z.string().trim().min(1).max(30),
  city: z.string().trim().min(1).max(100),
  country: z.string().trim().min(1).max(100),
  company: z.string().trim().max(200).optional(),
  dhlPostNumber: z.string().trim().regex(/^\d{6,10}$/).optional(),
});

const checkoutV2CompleteInputSchema = quoteInputSchema.extend({
  customer: checkoutV2CustomerSchema,
  delivery: z.object({
    country: z.string().trim().min(1).max(120),
    deliveryType: z.enum(["home", "packstation", "postfiliale"]),
  }),
  paymentMethod: z.enum(["bunq", "creditCard", "wise", "SEPA", "Bar", "Kreditkarte", "PayPal", "Crypto", "Guthaben", "Sonstige"]),
  idempotencyKey: z.string().trim().min(24).max(128),
  acknowledgements: z.object({
    researchOnly: z.literal(true),
    ageConfirmed: z.literal(true),
    noReturnConfirmed: z.literal(true),
    addressConfirmed: z.literal(true),
  }),
  qrAttributionToken: z.string().length(48).regex(/^[a-f0-9]+$/).optional(),
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

async function resolveKwkBenefits(input: CheckoutV2QuoteInput): Promise<Pick<CheckoutV2Benefits, "kwkReferralCode" | "kwkReferralPercent" | "kwkCredit">> {
  const output: Pick<CheckoutV2Benefits, "kwkReferralCode" | "kwkReferralPercent" | "kwkCredit"> = {};
  if (!input.kwkReferralCode && !input.kwkCredit) return output;
  if (!(await isKwkEnabled())) error("KWK_DISABLED", "Das Kundenwerben-Kunden-Programm ist derzeit nicht verfügbar.");

  const pool = await getPool();
  if (!pool) throw new Error("Datenbank nicht verfügbar");
  if (input.kwkReferralCode) {
    const customerEmail = input.customer?.email?.trim().toLowerCase();
    const customerPhone = normalizeKwkPhone(input.customer?.phone || "");
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
    const referralPhone = normalizeKwkPhone(String(referral.phone || ""));
    if (customerEmail === referralEmail || (referralPhone && customerPhone === referralPhone)) {
      error("KWK_SELF_REFERRAL_NOT_ALLOWED", "Dieser Empfehlungsvorteil ist für diese Bestellung nicht verfügbar.");
    }
    const previousOrders = await pool.query(
      `SELECT id FROM orders WHERE LOWER(TRIM(email)) = $1 OR
        CASE
          WHEN regexp_replace(phone, '[^0-9]', '', 'g') LIKE '0049%'
            THEN '49' || regexp_replace(SUBSTRING(regexp_replace(phone, '[^0-9]', '', 'g') FROM 5), '^0+', '')
          WHEN regexp_replace(phone, '[^0-9]', '', 'g') LIKE '490%'
            THEN '49' || SUBSTRING(regexp_replace(phone, '[^0-9]', '', 'g') FROM 4)
          WHEN regexp_replace(phone, '[^0-9]', '', 'g') LIKE '49%'
            THEN regexp_replace(phone, '[^0-9]', '', 'g')
          WHEN regexp_replace(phone, '[^0-9]', '', 'g') LIKE '0%'
            THEN '49' || regexp_replace(regexp_replace(phone, '[^0-9]', '', 'g'), '^0+', '')
          ELSE regexp_replace(phone, '[^0-9]', '', 'g')
        END = $2
       LIMIT 1`,
      [customerEmail, customerPhone],
    );
    if (previousOrders.rows.length > 0) {
      error("KWK_NEW_CUSTOMER_ONLY", "Dieser Empfehlungsvorteil gilt nur für die erste Bestellung.");
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

async function resolvePartnerSelfBenefit(input: CheckoutV2QuoteInput, req?: Request): Promise<CheckoutV2Benefits["partnerSelf"]> {
  if (!input.partnerCredit) return undefined;
  if (!req) error("PARTNER_LOGIN_REQUIRED", "Bitte melde dich als Partner an, um Guthaben einzulösen.");
  const partner = await getPartnerFromRequest(req!);
  if (!partner) error("PARTNER_LOGIN_REQUIRED", "Bitte melde dich als Partner an, um Guthaben einzulösen.");
  if (partner.commissionType !== "dauerhaft") {
    error("PARTNER_CREDIT_NOT_AVAILABLE", "Für dieses Partnerkonto ist kein Guthaben verfügbar.");
  }
  return {
    partnerNumber: partner.partnerNumber,
    partnerCode: partner.code,
    discountPercent: Number(partner.customerDiscountPercent || 0),
    requestedCredit: input.partnerCredit.requested,
    availableCredit: Number(partner.creditBalance || 0),
  };
}

async function resolvePromotion2for3(): Promise<{ enabled: boolean; expiresAt?: string | null; mode: "all" | "include" | "exclude"; products: string[] }> {
  const db = await getDb();
  if (!db) throw new Error("Datenbank nicht verfügbar");
  const settings = await db.select({ key: shopSettings.key, value: shopSettings.value })
    .from(shopSettings)
    .where(inArray(shopSettings.key, [
      "promo_2for3_enabled",
      "promo_2for3_expires_at",
      "promo_2for3_mode",
      "promo_2for3_products",
    ]));
  const values = new Map(settings.map((setting) => [setting.key, setting.value || ""]));
  const expiresAt = values.get("promo_2for3_expires_at") || null;
  const parsedMode = values.get("promo_2for3_mode");
  const mode = parsedMode === "include" || parsedMode === "exclude" ? parsedMode : "all";
  let products: string[] = [];
  let configurationValid = true;
  try {
    const parsed = JSON.parse(values.get("promo_2for3_products") || "[]");
    if (!Array.isArray(parsed)) throw new Error("promo products must be an array");
    products = parsed.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  } catch {
    // Invalid configuration must never create a wider promotion.
    configurationValid = false;
  }
  return {
    enabled: values.get("promo_2for3_enabled") === "true" && configurationValid,
    expiresAt,
    mode,
    products,
  };
}

export async function resolveCheckoutV2Quote(input: CheckoutV2QuoteInput, req?: Request) {
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
    category: articles.category,
    categories: articles.categories,
  }).from(articles).where(eq(articles.isActive, 1));

  // The preliminary quote is used only for promo minimum checks. It contains no
  // promotion, no stored identity and no economic side effect.
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
  const partnerSelf = await resolvePartnerSelfBenefit(input, req);
  const promotion2for3 = await resolvePromotion2for3();
  return calculateCheckoutV2Quote({
    selections: input.selections,
    delivery: input.delivery,
    catalog: catalog as CheckoutV2CatalogArticle[],
    benefits: { promotion, partnerSelf, ...kwk },
    promotion2for3,
  });
}

export const checkoutV2Router = router({
  /**
   * Side-effect-free commercial quote. It never creates an order, reserves stock,
   * consumes a code, writes a ledger entry, or initiates a payment.
   *
   * It is intentionally a POST mutation: the quote may contain E-Mail, telephone
   * number and a customer-entered code. These values must not travel in a URL.
   */
  quote: publicProcedure.input(quoteInputSchema).mutation(async ({ input, ctx }) => {
    assertCheckoutV2CommerceStaging();
    return resolveCheckoutV2Quote(input, ctx.req);
  }),

  /**
   * Commerce-staging-only completion. Every commercial value is recomputed from
   * the leading WaWi data immediately before the canonical order transaction.
   * Payment remains deliberately outside this endpoint.
   */
  complete: publicProcedure.input(checkoutV2CompleteInputSchema).mutation(async ({ input, ctx }) => {
    assertCheckoutV2CommerceStaging();
    const sameCountry = input.customer.country.trim().toLocaleLowerCase("de-DE")
      === input.delivery.country.trim().toLocaleLowerCase("de-DE");
    if (!sameCountry) error("DELIVERY_COUNTRY_MISMATCH", "Lieferland und Adresse stimmen nicht überein.");
    if ((input.delivery.deliveryType === "packstation" || input.delivery.deliveryType === "postfiliale")
      && input.delivery.country.trim().toLocaleLowerCase("de-DE") !== "deutschland") {
      error("PICKUP_POINT_GERMANY_ONLY", "Eine DHL-Abholadresse ist nur in Deutschland verfügbar.");
    }
    if (input.delivery.deliveryType === "packstation" && !input.customer.dhlPostNumber) {
      error("PACKSTATION_POST_NUMBER_REQUIRED", "Bitte gib deine DHL-Postnummer an.");
    }

    // Recompute immediately before persistence. Browser prices, discounts, gifts,
    // shipping values and totals are intentionally not accepted in this input.
    const quote = await resolveCheckoutV2Quote(input, ctx.req);
    const partnerBenefit = quote.discountLines.find((line) => line.source === "partner_code");
    const partnerSelfBenefit = await resolvePartnerSelfBenefit(input, ctx.req);
    const kwkReferral = quote.discountLines.find((line) => line.source === "kwk_referral");
    const kwkCredit = quote.discountLines.find((line) => line.source === "kwk_credit");
    const kwkCreditSession = input.kwkCredit ? verifyKwkToken(input.kwkCredit.token) : null;
    if (input.kwkCredit && !kwkCreditSession) {
      error("KWK_LOGIN_REQUIRED", "Bitte melde dich an, um Guthaben einzulösen.");
    }

    const customer = {
      ...input.customer,
      street: input.delivery.deliveryType === "packstation"
        ? "Packstation"
        : input.delivery.deliveryType === "postfiliale"
          ? "Postfiliale"
          : input.customer.street,
      deliveryType: input.delivery.deliveryType,
      dhlPostNumber: input.delivery.deliveryType === "home" ? undefined : input.customer.dhlPostNumber,
    };
    const discountBreakdown = quote.discountLines.map((line) => ({
      source: line.source === "partner_code" ? "partner_self_discount" as const : line.source,
      label: line.label,
      amount: line.amount,
      percentage: line.percentage,
      code: line.code,
    }));
    const orderItems = [
      ...quote.lines.map((line) => ({
        name: line.name,
        dosage: line.dosage || "",
        variant: line.dosage || "",
        price: line.unitPrice,
        quantity: line.quantity,
        type: line.type,
        shopProductId: line.shopProductId,
        isNasalSpray: line.isNasalSpray,
        isNasalDiySet: line.isNasalDiySet,
        isPlugPlay: line.isPlugPlay,
        isFreeGift: false,
      })),
      ...quote.giftLines.map((line) => ({
        name: line.name,
        dosage: line.dosage || "",
        variant: line.source === "promo_2for3" ? "2-für-3 Gratis" : "Gratisbeigabe",
        price: 0,
        quantity: line.quantity,
        type: line.type,
        shopProductId: line.shopProductId,
        isNasalSpray: false,
        isNasalDiySet: false,
        isPlugPlay: false,
        isFreeGift: true,
      })),
    ];

    return createOrderForCheckoutV2({
      storeKey: "checkout-v2",
      checkoutIdempotencyKey: input.idempotencyKey,
      items: orderItems,
      customer,
      subtotal: quote.subtotal,
      discount: quote.discount,
      discountCode: quote.discountLines.find((line) => line.source === "promotion_code")?.code || null,
      discountBreakdown,
      shipping: quote.shipping,
      shippingCountry: resolveShippingRegion(input.delivery.country),
      total: quote.total,
      paymentMethod: input.paymentMethod,
      date: new Date().toISOString(),
      partnerCode: partnerSelfBenefit?.partnerCode || partnerBenefit?.code || null,
      partnerNumber: partnerSelfBenefit?.partnerNumber || null,
      partnerDiscount: quote.discountLines.find((line) => line.source === "partner_self_discount")?.amount || partnerBenefit?.amount || 0,
      creditUsed: quote.discountLines.find((line) => line.source === "partner_credit")?.amount || 0,
      kwkCode: kwkReferral?.code || null,
      kwkDiscount: kwkReferral?.amount || 0,
      kwkCreditUsed: kwkCredit?.amount || 0,
      kwkCreditKwkId: kwkCreditSession?.kwkId,
      kwkCreditToken: input.kwkCredit?.token,
      qrAttributionToken: input.qrAttributionToken,
      internalNote: "Checkout V2 · Quote unmittelbar vor Bestellabschluss serverseitig neu berechnet.",
    }, ctx);
  }),
});
