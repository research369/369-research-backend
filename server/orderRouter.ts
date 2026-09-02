/**
 * Order Router – tRPC routes for order management (WaWi)
 * Public: createOrder (from checkout)
 * Protected (admin): list, updateStatus, matchPayments, etc.
 */

import { z } from "zod";
import { eq, desc, inArray, and, or } from "drizzle-orm";
import { router, publicProcedure, adminProcedure } from "./trpc.js";
import { getDb, getPool } from "./db.js";
import { orders, orderItems, articles, stockHistory, customers, customerCommunications, promoCodes } from "../drizzle/schema.js";
import { getIncomingPayments, matchPaymentToOrder, intelligentMatch, type MatchResult } from "./bunqService.js";
import { sendOrderConfirmationEmail, sendShippingNotificationEmail, sendAdminOrderNotification, sendPackingNotificationEmail } from "./emailService.js";
import { isSubstitutionEnabled, resolveSubstitution, extractDosageMg, isSubstitutionEligible } from "./substitutionService.js";
// KWK-Modul: statischer Import (sicherer als dynamischer Import)
import { isKwkEnabled, hashAddress, calculateKwkCommission, calculateKwkCommissionBase } from "./kwkService.js";
import { partners } from "../drizzle/schema.js";
import { sql } from "drizzle-orm";
import { queueCustomerDuplicateReview } from "./customerIntegrityService.js";
import { getNasalSprayKitAvailability, getNasalSprayKitConfig, isNasalSprayKitEligible } from "./nasalDiySetConfig.js";
import { persistAddressValidation, validateGermanAddress } from "./addressValidationService.js";
import { bookPaidPartnerCommission, redeemPartnerCreditForOrder } from "./partnerCreditService.js";
import { resolveQrAttribution } from "./qrCampaignService.js";
import { withStoreSourceMarker } from "./storeSource.js";
import {
  calculateAuthoritativeKwkOrder,
  calculateAuthoritativeShipping,
  calculatePromoDiscount,
  requiresColdChainShipping,
  normalizeKwkPhone,
  roundMoney,
  resolveAuthoritativeItemPrice,
  resolveShippingRegion,
  type PromoDefinition,
} from "./kwkCheckoutPricing.js";
import { verifyKwkToken } from "./kwkAuth.js";

// Zod schemas
const discountBreakdownEntrySchema = z.object({
  source: z.enum([
    "promotion_code",
    "partner_self_discount",
    "partner_credit",
    "kwk_referral",
    "kwk_credit",
    "manual_global_percent",
    "manual_global_amount",
    "manual_line_percent",
    "manual_line_amount",
    "credit_note",
    "unattributed",
  ]),
  label: z.string().trim().min(1).max(180),
  amount: z.number().nonnegative(),
  percentage: z.number().min(0).max(100).optional(),
  code: z.string().trim().min(1).max(80).optional(),
});

const createOrderSchema = z.object({
  orderId: z.string().optional(), // now generated server-side via DB sequence
  // Zusätzliche Shopquelle. Ohne Angabe bleibt die bestehende 369-Research-Logik unverändert.
  storeKey: z.enum(["369research", "peps4pets"]).optional().default("369research"),
  // Nur Peps4pets verwendet diesen evidenzgebundenen Schlüssel. Die kanonische
  // WaWi-Nummer bleibt unabhängig davon weiterhin der interne Primärvertrag.
  checkoutIdempotencyKey: z.string().trim().min(12).max(128).optional(),
  items: z.array(z.object({
    name: z.string(),
    dosage: z.string().optional(),
    variant: z.string().optional(),
    price: z.number(),
    quantity: z.number(),
    type: z.string(),
    shopProductId: z.string().optional(), // product id from shop (e.g. '3g-triple-g')
    isNasalSpray: z.boolean().optional(), // Legacy: fertig gemischtes Nasenspray
    // DIY-Set: Vial plus BAC Wasser, Flasche, Aufziehspritze und Kanüle (+7 €).
    isNasalDiySet: z.boolean().optional(),
    isPlugPlay: z.boolean().optional(),   // Plug&Play Patrone (+15€ Aufpreis)
    isFreeGift: z.boolean().optional(),   // Gratis-Position (kein Bestandsabzug)
  })),
  customer: z.object({
    firstName: z.string(),
    lastName: z.string(),
    email: z.string().email().optional().nullable().or(z.literal("")).or(z.null()),
    phone: z.string(),
    street: z.string(),
    houseNumber: z.string(),
    zip: z.string(),
    city: z.string(),
    country: z.string(),
    company: z.string().optional(),
    // Packstation support
    deliveryType: z.enum(["home", "packstation", "postfiliale"]).optional().default("home"),
    dhlPostNumber: z.string().optional(),
  }),
  subtotal: z.number(),
  discount: z.number(),
  discountCode: z.string().nullable(),
  // Additiv: erklärt den bereits errechneten Rabatt, verändert ihn nicht.
  discountBreakdown: z.array(discountBreakdownEntrySchema).max(30).optional(),
  shipping: z.number(),
  shippingCountry: z.string(),
  total: z.number(),
  paymentMethod: z.enum(["bunq", "creditCard", "wise", "SEPA", "Bar", "Kreditkarte", "PayPal", "Crypto", "Guthaben", "Sonstige"]),
  date: z.string(),
  // Existing customer override (from KI-Erfassung manual match)
  existingCustomerId: z.number().optional(),
  internalNote: z.string().optional(),
  // Partner fields
  partnerCode: z.string().nullable().optional(),
  partnerNumber: z.string().nullable().optional(),
  partnerDiscount: z.number().optional(),
  creditUsed: z.number().optional(),
  // KWK-Felder (additiv, optional – bestehende Logik unberührt)
  kwkCode: z.string().nullable().optional(),       // KWK-Nummer des Empfehlungsgebers
  kwkDiscount: z.number().optional(),              // 10% Rabatt auf Produkte
  kwkCreditUsed: z.number().optional(),            // Eingelöstes KWK-Guthaben
  kwkCreditKwkId: z.number().optional(),           // KWK-Account-ID für Guthaben-Einlösung
  kwkCreditToken: z.string().min(20).optional(),   // Authentifiziert die Guthaben-Einlösung
  // Opaque first-party QR attribution token (30 days). No campaign IDs are trusted from the browser.
  qrAttributionToken: z.string().length(48).regex(/^[a-f0-9]+$/).optional(),
  // Ausschließlich für einen angemeldeten Master-Admin im manuellen WaWi-Verkauf.
  // Der Shop erhält hierfür nie einen gültigen Admin-Token.
  stockOverride: z.object({
    enabled: z.literal(true),
    reason: z.string().trim().min(5).max(500),
  }).optional(),
  // Eine Warnung wird nicht versteckt: Kunden und WaWi müssen sie bewusst bestätigen.
  addressValidationOverride: z.object({
    confirmed: z.literal(true),
  }).optional(),
});

const updateStatusSchema = z.object({
  orderId: z.string(),
  status: z.enum(["offen", "bezahlt", "gepackt", "versendet", "zugestellt", "abgeholt", "storniert"]),
  trackingNumber: z.string().optional(),
  trackingCarrier: z.string().optional(),
  sendShippingEmail: z.boolean().optional(),
  internalNote: z.string().optional(),
});

export const orderRouter = router({
  // PUBLIC: Create order from checkout (no auth required)
  create: publicProcedure
    .input(createOrderSchema)
        .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const qrAttribution = await resolveQrAttribution(input.qrAttributionToken);

      const requestedKwkCredit = roundMoney(input.kwkCreditUsed || 0);
      const hasKwkRequest = Boolean(input.kwkCode?.trim())
        || requestedKwkCredit > 0
        || (input.kwkDiscount || 0) > 0;

      if (hasKwkRequest) {
        const catalog = await db.select({
          sku: articles.sku,
          shopProductId: articles.shopProductId,
          name: articles.name,
          sellingPrice: articles.sellingPrice,
          salePrice: articles.salePrice,
          variants: articles.variants,
          isActive: articles.isActive,
          shopVisible: articles.shopVisible,
        }).from(articles);
        input.items = input.items.map((item) => ({
          ...item,
          price: resolveAuthoritativeItemPrice(item, catalog),
        }));
        input.subtotal = roundMoney(input.items.reduce((sum, item) => sum + item.price * item.quantity, 0));
      }

        // Kühlpflichtige Artikel dürfen niemals mit der normalen DHL-Gebühr
        // durchrutschen. Ein bereits gewährter Gratisversand (0 €) bleibt dabei
        // ausdrücklich erhalten; alle normalen Versandbeträge werden mindestens
        // auf die serverseitig berechnete Kühlversandpauschale angehoben.
        const serverBaseShipping = calculateAuthoritativeShipping({
          country: input.customer.country,
          items: [],
        });
        const serverColdShipping = calculateAuthoritativeShipping({
          country: input.customer.country,
          items: input.items,
        });
        if (
          input.items.some(requiresColdChainShipping)
          && input.shipping >= serverBaseShipping
          && input.shipping < serverColdShipping
        ) {
          input.shipping = serverColdShipping;
          input.shippingCountry = resolveShippingRegion(input.customer.country);
        }

        const lineSubtotal = roundMoney(input.items.reduce((sum, item) => sum + item.price * item.quantity, 0));
      if (!hasKwkRequest && Math.abs(lineSubtotal - roundMoney(input.subtotal)) > 0.02) {
        throw new Error("Bestellsumme stimmt nicht mit den Artikelpositionen überein");
      }

      // ── KWK: verbindliche serverseitige Geschäfts- und Summenregeln ──
      // Allgemeine Aktionscodes dürfen mit KWK kombiniert werden. Jede Form einer
      // Partnerzuordnung (Code, Nummer, Rabatt oder Guthaben) schließt KWK dagegen aus.
      let kwkReferralAccount: { id: number; email: string; phone: string } | null = null;
      let kwkCreditAccountId: number | null = null;
      if (hasKwkRequest) {
        const normalizedDiscountCode = input.discountCode?.trim().toUpperCase() || "";
        let discountCodeIsPartnerCode = false;
        if (normalizedDiscountCode) {
          const [matchingPartner] = await db.select({ id: partners.id }).from(partners)
            .where(and(sql`UPPER(TRIM(${partners.code})) = ${normalizedDiscountCode}`, eq(partners.isActive, 1)))
            .limit(1);
          discountCodeIsPartnerCode = Boolean(matchingPartner);
        }

        const hasPartnerCombination = Boolean(
          input.partnerCode?.trim()
          || input.partnerNumber?.trim()
          || (input.partnerDiscount || 0) > 0
          || (input.creditUsed || 0) > 0
          || discountCodeIsPartnerCode
        );
        if (hasPartnerCombination) {
          throw new Error("KWK_PARTNER_AUSGESCHLOSSEN: Partnercodes, Partnerbestellungen und Partnerguthaben können nicht mit KWK kombiniert werden.");
        }
        if (input.kwkCode?.trim() && requestedKwkCredit > 0) {
          throw new Error("KWK_NEUKUNDENRABATT_UND_GUTHABEN_NICHT_KOMBINIERBAR");
        }
        if (requestedKwkCredit > 0) {
          const authenticatedKwk = input.kwkCreditToken ? verifyKwkToken(input.kwkCreditToken) : null;
          if (!authenticatedKwk) {
            throw new Error("KWK_GUTHABEN_AUTHENTIFIZIERUNG_ERFORDERLICH");
          }
          kwkCreditAccountId = authenticatedKwk.kwkId;
        }

        let promoDefinition: PromoDefinition | null = null;
        if (normalizedDiscountCode) {
          const [promo] = await db.select().from(promoCodes)
            .where(and(eq(promoCodes.code, normalizedDiscountCode), eq(promoCodes.isActive, 1)))
            .limit(1);
          if (!promo) {
            throw new Error("KWK_AKTIONSCODE_UNGUELTIG: Mit KWK können ausschließlich gültige allgemeine Aktionscodes kombiniert werden.");
          }

          const now = new Date();
          const validUntil = promo.validUntil ? new Date(promo.validUntil) : null;
          if (validUntil) validUntil.setHours(23, 59, 59, 999);
          const minimumOrder = Number(promo.minOrder || 0);
          if ((promo.validFrom && now < promo.validFrom)
            || (validUntil && now > validUntil)
            || ((promo.maxUses || 0) > 0 && promo.currentUses >= (promo.maxUses || 0))
            || (minimumOrder > 0 && input.subtotal < minimumOrder)) {
            throw new Error("KWK_AKTIONSCODE_UNGUELTIG: Der allgemeine Aktionscode ist für diese Bestellung nicht gültig.");
          }

          promoDefinition = {
            discountType: promo.discountType,
            percentage: Number(promo.percentage || 0),
            fixedAmount: Number(promo.fixedAmount || 0),
            description: promo.description,
          };
        }

        if (input.kwkCode?.trim()) {
          if (!await isKwkEnabled()) {
            throw new Error("KWK_PROGRAMM_INAKTIV");
          }
          const pool = await getPool();
          if (!pool) throw new Error("Database not available");
          const referralAccountResult = await pool.query(
            `SELECT id, email, phone FROM kwk_accounts
             WHERE referral_code=$1 AND status='aktiv' AND deleted_at IS NULL LIMIT 1`,
            [input.kwkCode.trim().toUpperCase()],
          );
          if (referralAccountResult.rows.length !== 1) {
            throw new Error("KWK_CODE_UNGUELTIG");
          }
          const resolvedKwkAccount = referralAccountResult.rows[0] as { id: number; email: string; phone: string };
          kwkReferralAccount = resolvedKwkAccount;

          const customerEmail = (input.customer.email || "").trim().toLowerCase();
          const customerPhone = normalizeKwkPhone(input.customer.phone);
          const selfReferral = Boolean(
            (customerEmail && customerEmail === String(resolvedKwkAccount.email || "").trim().toLowerCase())
            || (customerPhone && customerPhone === normalizeKwkPhone(String(resolvedKwkAccount.phone || "")))
          );
          if (selfReferral) {
            throw new Error("KWK_SELBSTWERBUNG_NICHT_ERLAUBT");
          }
        }

        const promoDiscount = calculatePromoDiscount({
          subtotal: input.subtotal,
          items: input.items,
          promo: promoDefinition,
        });
        input.shipping = calculateAuthoritativeShipping({
          country: input.customer.country,
          items: input.items,
          promoDescription: promoDefinition?.description,
        });
        input.shippingCountry = resolveShippingRegion(input.customer.country);
        const authoritative = calculateAuthoritativeKwkOrder({
          subtotal: input.subtotal,
          shipping: input.shipping,
          promoDiscount,
          kwkCreditUsed: requestedKwkCredit,
          applyReferralDiscount: Boolean(kwkReferralAccount),
        });

        // Ab hier werden ausschließlich die vom Server ermittelten Geldwerte gespeichert,
        // per E-Mail versendet und für Guthaben/Provisionen verwendet.
        input.kwkDiscount = authoritative.kwkDiscount;
        input.kwkCreditUsed = authoritative.kwkCreditUsed;
        input.discount = authoritative.totalDiscount;
        input.total = authoritative.total;
      }

      const expectedTotal = roundMoney(input.subtotal - input.discount + input.shipping);
      if ([input.subtotal, input.discount, input.shipping, input.total].some((value) => !Number.isFinite(value) || value < 0)
          || input.discount > input.subtotal + 0.02
          || (input.kwkCreditUsed || 0) < 0
          || (input.kwkCreditUsed || 0) > input.discount + 0.02
          || Math.abs(expectedTotal - roundMoney(input.total)) > 0.02) {
        throw new Error("Ungültige Rabatt-, Versand- oder Gesamtberechnung");
      }
      const authoritativeKwkCredit = roundMoney(input.kwkCreditUsed || 0);
      const submittedDiscountBreakdown = (input.discountBreakdown || [])
        .filter((entry) => entry.amount > 0)
        .map((entry) => ({
          ...entry,
          amount: roundMoney(entry.amount),
          percentage: entry.percentage === undefined ? undefined : roundMoney(entry.percentage),
        }));
      const submittedDiscountBreakdownTotal = roundMoney(
        submittedDiscountBreakdown.reduce((sum, entry) => sum + entry.amount, 0),
      );
      if (submittedDiscountBreakdownTotal > roundMoney(input.discount) + 0.02) {
        throw new Error("Rabattaufschlüsselung übersteigt den Gesamtbetrag");
      }
      const remainingUnattributedDiscount = roundMoney(input.discount - submittedDiscountBreakdownTotal);
      const discountBreakdown = [
        ...submittedDiscountBreakdown,
        ...(remainingUnattributedDiscount > 0
          ? [{
              source: "unattributed" as const,
              label: input.discountCode?.trim()
                ? `Nicht aufgeschlüsselter Rest zu Rabattcode: ${input.discountCode.trim()}`
                : "Rabattursprung nicht strukturiert übermittelt",
              amount: remainingUnattributedDiscount,
              ...(input.discountCode?.trim() ? { code: input.discountCode.trim() } : {}),
            }]
          : []),
      ];

      // Bestandsoverride ist strikt an einen authentifizierten Admin gebunden.
      // Eine Shop-Bestellung besitzt keinen WaWi-Admin-Token und kann diese Prüfung nie umgehen.
      const stockOverrideRequested = input.stockOverride?.enabled === true;
      const stockOverrideAuthorized = stockOverrideRequested && ctx.user?.role === "admin";
      if (stockOverrideRequested && !stockOverrideAuthorized) {
        throw new Error("Bestandsoverride ist ausschließlich für den Master-Admin erlaubt");
      }
      if (stockOverrideRequested && !input.stockOverride?.reason?.trim()) {
        throw new Error("Für eine Bestellung trotz fehlendem Bestand ist eine Begründung erforderlich");
      }

      // Deutsche Adressplausibilität wird serverseitig erneut geprüft. Das Frontend
      // zeigt denselben Befund vorher an; diese Prüfung verhindert ein Umgehen per Request.
      const addressValidation = await validateGermanAddress(input.customer);
      const addressWarningNeedsConfirmation = addressValidation.applicable
        && (addressValidation.status === "warning" || addressValidation.status === "unavailable");
      if (addressWarningNeedsConfirmation && input.addressValidationOverride?.confirmed !== true) {
        throw new Error(`ADRESSPRUEFUNG_BESTAETIGUNG_ERFORDERLICH: ${addressValidation.warnings.map((warning) => warning.message).join(" ")}`);
      }

      // ── Hilfsfunktion: Checkout-Fehler als Backup speichern + E-Mail an Admin ──
      const saveFailedOrder = async (errorMsg: string, attemptedOrderId?: string) => {
        try {
          const pool = await getPool();
          if (pool) {
            await pool.query(`
              CREATE TABLE IF NOT EXISTS failed_orders (
                id SERIAL PRIMARY KEY,
                attempted_order_id VARCHAR(50),
                customer_name VARCHAR(200),
                customer_email VARCHAR(320),
                customer_phone VARCHAR(50),
                total DECIMAL(10,2),
                items_json TEXT,
                input_json TEXT,
                error_message TEXT,
                created_at TIMESTAMP DEFAULT NOW()
              )
            `);
            await pool.query(
              `INSERT INTO failed_orders (attempted_order_id, customer_name, customer_email, customer_phone, total, items_json, input_json, error_message)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [
                attemptedOrderId || `FEHLER-${Date.now()}`,
                `${input.customer.firstName} ${input.customer.lastName}`,
                input.customer.email || '',
                input.customer.phone || '',
                input.total,
                JSON.stringify(input.items),
                JSON.stringify({ customer: input.customer, subtotal: input.subtotal, discount: input.discount, shipping: input.shipping, total: input.total, paymentMethod: input.paymentMethod }),
                errorMsg,
              ]
            );
            console.log(`[Orders] Failed order saved to failed_orders table`);
          }
        } catch (backupErr) {
          console.error('[Orders] CRITICAL: Failed to save failed order backup:', backupErr);
        }
        // Admin-E-Mail bei Checkout-Fehler
        try {
          const { ENV } = await import('./env.js');
          if (ENV.resendApiKey) {
            await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${ENV.resendApiKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                from: 'noreply@mail.369research.eu',
                to: ['369rebackup@gmail.com'],
                subject: `⚠️ CHECKOUT FEHLER: ${input.customer.firstName} ${input.customer.lastName} | ${input.total.toFixed(2)}€`,
                html: `<h2>Checkout-Fehler</h2><p><strong>Kunde:</strong> ${input.customer.firstName} ${input.customer.lastName}</p><p><strong>E-Mail:</strong> ${input.customer.email}</p><p><strong>Telefon:</strong> ${input.customer.phone}</p><p><strong>Betrag:</strong> ${input.total.toFixed(2)}€</p><p><strong>Fehler:</strong> ${errorMsg}</p><p><strong>Artikel:</strong> ${input.items.map(i => `${i.quantity}x ${i.name} ${i.dosage || ''}`).join(', ')}</p><p><strong>Adresse:</strong> ${input.customer.street} ${input.customer.houseNumber}, ${input.customer.zip} ${input.customer.city}</p>`,
              }),
            });
          }
        } catch (emailErr) {
          console.error('[Orders] Failed to send failed-order alert email:', emailErr);
        }
      };

      const isPeps4petsOrder = input.storeKey === "peps4pets";
      const checkoutIdempotencyKey = isPeps4petsOrder ? input.checkoutIdempotencyKey : undefined;
      if (isPeps4petsOrder && !checkoutIdempotencyKey) {
        throw new Error("Peps4pets-Bestellungen benötigen einen stabilen Checkout-Schlüssel");
      }

      const existingP4pResponse = (existingOrder: typeof orders.$inferSelect) => ({
        success: true,
        orderId: existingOrder.orderId,
        externalOrderReference: existingOrder.externalOrderReference || undefined,
      });

      let p4pLockClient: any = null;
      if (isPeps4petsOrder && checkoutIdempotencyKey) {
        const [existingBeforeLock] = await db.select().from(orders)
          .where(eq(orders.checkoutIdempotencyKey, checkoutIdempotencyKey)).limit(1);
        if (existingBeforeLock) return existingP4pResponse(existingBeforeLock);

        const pool = await getPool();
        if (!pool) throw new Error("Datenbank nicht verfügbar");
        const lockClient = await pool.connect();
        const lockResult = await lockClient.query(
          "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
          [`peps4pets-checkout:${checkoutIdempotencyKey}`],
        );
        if (!lockResult.rows[0]?.locked) {
          lockClient.release();
          const [existingWhileLocked] = await db.select().from(orders)
            .where(eq(orders.checkoutIdempotencyKey, checkoutIdempotencyKey)).limit(1);
          if (existingWhileLocked) return existingP4pResponse(existingWhileLocked);
          throw new Error("Deine Bestellung wird bereits verarbeitet. Bitte warte einen Moment und versuche es erneut.");
        }
        p4pLockClient = lockClient;
      }

      try {
      if (isPeps4petsOrder && checkoutIdempotencyKey) {
        const [existingAfterLock] = await db.select().from(orders)
          .where(eq(orders.checkoutIdempotencyKey, checkoutIdempotencyKey)).limit(1);
        if (existingAfterLock) return existingP4pResponse(existingAfterLock);
      }

      // ── Generate sequential canonical WaWi order ID from DB sequence ──
      let orderId = input.orderId || `369-${Date.now()}`;
      try {
        const { sql } = await import('drizzle-orm');
        const seqResult = await db.execute(sql`SELECT next_order_id() as order_id`);
        const rows = seqResult as any;
        if (rows && rows.length > 0 && rows[0].order_id) {
          orderId = rows[0].order_id;
        } else if (rows?.rows && rows.rows.length > 0) {
          orderId = rows.rows[0].order_id;
        }
      } catch (err) {
        console.warn('[Orders] Failed to generate sequential order ID, using fallback:', err);
      }

      let externalOrderReference: string | null = null;

      // Ein bewusst übergangener Hinweis wird sofort mit der finalen Bestellnummer
      // festgeschrieben. Der Nachweis enthält keine änderbare UI-Aktion.
      if (addressWarningNeedsConfirmation) {
        await persistAddressValidation({
          input: input.customer,
          result: addressValidation,
          context: ctx.user?.role === "admin" ? "manual_order" : "checkout",
          orderId,
          overrideConfirmed: true,
          confirmedBy: ctx.user?.name || ctx.user?.username || (ctx.user?.role === "admin" ? "Master-Admin" : "Kunde"),
        });
      }

      // ── Partner logic: validate code, calculate discount & commission ──
      let partnerCode = input.partnerCode || null;
      let partnerNumber = input.partnerNumber || null;
      let partnerDiscountAmount = input.partnerDiscount || 0;
      let partnerCommissionAmount = 0;
      let creditUsed = input.creditUsed || 0;

      // Partner wird beim Checkout ausschließlich zugeordnet. Eine Gutschrift entsteht
      // erst nach bestätigtem Zahlungseingang im zentralen Partnerguthaben-Service.
      const resolvePartnerForOrder = async (partner: { id: number; code: string }, reason: string) => {
        if (!partnerCode) partnerCode = partner.code;
        console.log(`[Orders] Partner zugeordnet: ${partner.code} (${reason}); Guthaben wird erst nach Zahlung gebucht.`);
      };

      // Case 1: Partner CODE was provided (customer or partner entered the code)
      if (partnerCode) {
        const { and: andOp } = await import("drizzle-orm");
        const [partner] = await db.select().from(partners)
          .where(andOp(eq(partners.code, partnerCode.toUpperCase()), eq(partners.isActive, 1)))
          .limit(1);

        if (partner) {
          await resolvePartnerForOrder(partner, "Code");
        }
      }

      // Case 2: Partner NUMBER was provided but no code – partner ordering for themselves
      // Also book commission for the partner (they get both discount + commission)
      if (partnerNumber && !partnerCode) {
        const { and: andOp } = await import("drizzle-orm");
        const [partner] = await db.select().from(partners)
          .where(andOp(eq(partners.partnerNumber, partnerNumber), eq(partners.isActive, 1)))
          .limit(1);

        if (partner) {
          await resolvePartnerForOrder(partner, "Eigenbestellung");
        }
      }

      // Ein Guthabeneinsatz muss als eigener Wert vorliegen. Er wird erst nach
      // erfolgreichem Bestellabschluss im zentralen, idempotenten Ledger gebucht.
      if (creditUsed > 0 && !partnerNumber) {
        throw new Error("Guthabeneinlösung erfordert eine gültige Partnernummer");
      }
      if (creditUsed < 0 || creditUsed > input.discount || creditUsed > input.subtotal) {
        throw new Error("Ungültiger Guthabeneinsatz");
      }

      // ── Idempotency check: if order already exists, skip re-processing ──
      const existingOrder = isPeps4petsOrder && checkoutIdempotencyKey
        ? await db.select().from(orders).where(eq(orders.checkoutIdempotencyKey, checkoutIdempotencyKey)).limit(1)
        : await db.select().from(orders).where(eq(orders.orderId, orderId)).limit(1);
      if (existingOrder.length > 0) {
        console.warn(`[Orders] Duplicate request for order ${orderId} – completing only idempotent ledger steps`);
        if (parseFloat(existingOrder[0].creditUsed || "0") > 0) {
          await redeemPartnerCreditForOrder(orderId);
        }
        return isPeps4petsOrder ? existingP4pResponse(existingOrder[0]) : { success: true, orderId: orderId };
      }

      // Stock check, stock movement, order persistence, order items and customer link
      // form one transaction. A failure in this section cannot leave a partial P4P order.
      let customerId: number | null = null;
      let customerIntegrityTrigger: "order_customer_created" | "order_customer_changed" | null = null;
      await db.transaction(async (tx) => {
      const db = tx;

      // Das KWK-Guthaben wird innerhalb derselben Transaktion wie die Bestellung
      // geprüft und reserviert. So kann kein rabattierter Auftrag ohne Gegenbuchung
      // entstehen und die vom Browser gesendete Account-ID wird nicht vertraut.
      if (authoritativeKwkCredit > 0 && kwkCreditAccountId) {
        const lockedAccount = await db.execute(sql`
          SELECT id FROM kwk_accounts
          WHERE id=${kwkCreditAccountId} AND status='aktiv' AND deleted_at IS NULL
          FOR UPDATE
        `);
        if (lockedAccount.rows.length !== 1) {
          throw new Error("KWK_GUTHABEN_ACCOUNT_NICHT_AKTIV");
        }
        const balanceResult = await db.execute(sql`
          SELECT COALESCE(SUM(CASE
            WHEN type IN ('credit_released','redeemed','cancelled','refund','manual_correction')
             AND status='confirmed' THEN amount ELSE 0 END), 0) AS available
          FROM kwk_ledger WHERE kwk_id=${kwkCreditAccountId}
        `);
        const available = Number(balanceResult.rows[0]?.available || 0);
        if (available + 0.001 < authoritativeKwkCredit) {
          throw new Error(`KWK_GUTHABEN_NICHT_AUSREICHEND: Verfügbar ${available.toFixed(2)} €`);
        }
      }

      // KWK gilt ausschließlich für die erste Bestellung eines echten Neukunden.
      // Der Identitätsschlüssel serialisiert parallele Checkout-Versuche, damit nicht
      // zwei gleichzeitige Erstbestellungen denselben 10%-Rabatt erhalten können.
      if (kwkReferralAccount) {
        const normalizedEmail = (input.customer.email || "").trim().toLowerCase();
        const normalizedPhone = normalizeKwkPhone(input.customer.phone);
        // E-Mail und Telefon werden getrennt gesperrt. Ein Kunde kann sonst zwei
        // parallele Requests mit gleicher E-Mail, aber unterschiedlichen Telefonnummern
        // senden und beide könnten denselben Erstbestellungsrabatt erhalten.
        if (normalizedEmail) {
          await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`kwk-new-customer-email:${normalizedEmail}`}))`);
        }
        if (normalizedPhone) {
          await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`kwk-new-customer-phone:${normalizedPhone}`}))`);
        }

        const previousOrderConditions = [];
        if (normalizedEmail) {
          previousOrderConditions.push(sql`LOWER(TRIM(${orders.email})) = ${normalizedEmail}`);
        }
        if (normalizedPhone) {
          previousOrderConditions.push(sql`
            CASE
              WHEN regexp_replace(${orders.phone}, '[^0-9]', '', 'g') LIKE '0049%'
                THEN '49' || regexp_replace(SUBSTRING(regexp_replace(${orders.phone}, '[^0-9]', '', 'g') FROM 5), '^0+', '')
              WHEN regexp_replace(${orders.phone}, '[^0-9]', '', 'g') LIKE '490%'
                THEN '49' || SUBSTRING(regexp_replace(${orders.phone}, '[^0-9]', '', 'g') FROM 4)
              WHEN regexp_replace(${orders.phone}, '[^0-9]', '', 'g') LIKE '49%'
                THEN regexp_replace(${orders.phone}, '[^0-9]', '', 'g')
              WHEN regexp_replace(${orders.phone}, '[^0-9]', '', 'g') LIKE '0%'
                THEN '49' || regexp_replace(regexp_replace(${orders.phone}, '[^0-9]', '', 'g'), '^0+', '')
              ELSE regexp_replace(${orders.phone}, '[^0-9]', '', 'g')
            END = ${normalizedPhone}
          `);
        }
        const previousOrders = previousOrderConditions.length > 0
          ? await db.select({ id: orders.id }).from(orders)
            .where(or(...previousOrderConditions))
            .limit(1)
          : [];
        if (previousOrders.length > 0) {
          throw new Error("KWK_NUR_NEUKUNDEN: Der 10%-Empfehlungsrabatt gilt ausschließlich für die erste Bestellung.");
        }
      }

            // ── Stock check: verify all peptide items are in stock before creating order ──
      const allArticlesForCheck = await db.select().from(articles).where(eq(articles.isActive, 1));
      const outOfStockItems: string[] = [];

      // Smart Substitution: prüfen ob Feature aktiv ist
      const substitutionActive = await isSubstitutionEnabled();

      // Helper: find articles matching a shop item by shopProductId + dosage
      // Fallback: wenn keine shopProductId, suche nach Name + Dosage (für manuelle WaWi-Bestellungen)
      const findMatchingArticles = (item: { name: string; dosage?: string; shopProductId?: string }, allArts: typeof allArticlesForCheck) => {
        const dosageNorm = (item.dosage || '').toLowerCase().trim();
        const itemShopId = (item.shopProductId || '').toLowerCase().trim();
        
        // Primary: shopProductId + dosage match (Online-Checkout)
        if (itemShopId) {
          return allArts.filter(a => {
            if (!a.shopProductId) return false;
            if (a.shopProductId.toLowerCase() !== itemShopId) return false;
            if (!dosageNorm) return true; // keine Dosage – alle Varianten
            const parenMatch = a.name.match(/\(([^)]+)\)\s*$/);
            const noParenMatch = a.name.match(/\b(\d+(?:\.\d+)?\s*(?:mg|IU|ml|mcg|iu))\s*$/i);
            const nameDosage = parenMatch ? parenMatch[1].trim().toLowerCase() : noParenMatch ? noParenMatch[1].trim().toLowerCase() : '';
            const skuDosage = extractDosageMg(a.sku);
            const articleDosage = nameDosage || (skuDosage !== null ? String(skuDosage) + ' mg' : '');
            return articleDosage === dosageNorm;
          });
        }
        
        // Fallback: Name + Dosage match (manuelle WaWi-Bestellungen ohne shopProductId)
        const itemNameNorm = item.name.replace(/\s*\[.*?\]\s*/g, '').trim().toLowerCase();
        return allArts.filter(a => {
          const artNameBase = a.name.replace(/\s*\(.*?\)\s*$/, '').trim().toLowerCase();
          if (!artNameBase.includes(itemNameNorm) && !itemNameNorm.includes(artNameBase)) return false;
          if (!dosageNorm) return true;
          const parenMatch = a.name.match(/\(([^)]+)\)\s*$/);
          const noParenMatch = a.name.match(/\b(\d+(?:\.\d+)?\s*(?:mg|IU|ml|mcg|iu))\s*$/i);
          const nameDosage = parenMatch ? parenMatch[1].trim().toLowerCase() : noParenMatch ? noParenMatch[1].trim().toLowerCase() : '';
          const skuDosage = extractDosageMg(a.sku);
          const articleDosage = nameDosage || (skuDosage !== null ? String(skuDosage) + ' mg' : '');
          return articleDosage === dosageNorm;
        });
      };

      // Map: item-Index → SubstitutionResult (für späteren Bestandsabzug)
      const substitutionMap = new Map<number, import('./substitutionService.js').SubstitutionResult>();

      for (let itemIdx = 0; itemIdx < input.items.length; itemIdx++) {
        const item = input.items[itemIdx];
        if (item.type !== 'peptide') continue;
        const matchingArticles = findMatchingArticles(item, allArticlesForCheck);
        if (matchingArticles.length > 0) {
          const totalStock = matchingArticles.reduce((sum, a) => sum + (a.stock ?? 0), 0);
          if (totalStock < item.quantity) {
            // Variante nicht auf Lager – Smart Substitution versuchen?
            // Smart Sub greift auch ohne shopProductId (manuelle Bestellungen) – dann shopProductId aus matchingArticle nehmen
            const effectiveShopProductId = item.shopProductId || matchingArticles[0]?.shopProductId;
            if (substitutionActive && effectiveShopProductId && isSubstitutionEligible(matchingArticles[0]?.category)) {
              const dosageMg = extractDosageMg(item.dosage || item.name);
              if (dosageMg !== null) {
                const sub = resolveSubstitution(
                  effectiveShopProductId,
                  dosageMg,
                  item.quantity,
                  allArticlesForCheck.map(a => ({
                    id: a.id,
                    name: a.name,
                    sku: a.sku,
                    stock: a.stock,
                    shopProductId: a.shopProductId,
                    category: a.category,
                  }))
                );
                if (sub.possible) {
                  substitutionMap.set(itemIdx, sub);
                  console.log(`[Orders] Smart Substitution: ${sub.internalNote} (order ${orderId})`);
                } else {
                  outOfStockItems.push(`${item.name}${item.dosage ? ` (${item.dosage})` : ''} (Bestand: ${totalStock}, keine Substitution möglich)`);
                }
              } else {
                outOfStockItems.push(`${item.name}${item.dosage ? ` (${item.dosage})` : ''} (Bestand: ${totalStock})`);
              }
            } else {
              outOfStockItems.push(`${item.name}${item.dosage ? ` (${item.dosage})` : ''} (Bestand: ${totalStock})`);
            }
          }
        }
      }
      if (outOfStockItems.length > 0) {
        if (stockOverrideAuthorized) {
          const overrideReason = input.stockOverride!.reason.trim();
          (input as any)._stockOverrideNote = `MASTER-ADMIN BESTANDSOVERRIDE – Fehlbestand bei: ${outOfStockItems.join(", ")}. Begründung: ${overrideReason}. Bestellung bleibt offen bis zur Warenverfügbarkeit.`;
          console.warn(`[Orders] Master-Admin stock override for order ${orderId}:`, { outOfStockItems, admin: ctx.user?.username, reason: overrideReason });
        } else {
          const errMsg = `Folgende Artikel sind nicht mehr verfügbar: ${outOfStockItems.join(', ')}. Bitte entferne sie aus dem Warenkorb.`;
          console.warn(`[Orders] Stock check failed for order ${orderId}:`, outOfStockItems);
          await saveFailedOrder(errMsg, orderId);
          throw new Error(errMsg);
        }
      }

      // Nasenspray Kit: ausschließlich serverseitig konfigurierte Produkte und
      // ausreichend vorhandenes BAC Wasser 10 ml. Der Browser kann weder die
      // Freigabe noch den Lieferumfang oder die Verfügbarkeit manipulieren.
      const nasalSprayKitItems = input.items.filter((item) => item.isNasalDiySet === true);
      const nasalSprayKitConfig = await getNasalSprayKitConfig();
      const nasalSprayKitAvailability = await getNasalSprayKitAvailability(nasalSprayKitConfig);
      const requestedKitUnits = nasalSprayKitItems.reduce((sum, item) => sum + item.quantity, 0);
      for (const item of nasalSprayKitItems) {
        if (!isNasalSprayKitEligible(nasalSprayKitConfig, item.shopProductId)) {
          throw new Error(`Nasenspray Kit ist für ${item.name} nicht verfügbar`);
        }
        if (!item.shopProductId || !item.dosage) {
          throw new Error("Nasenspray Kit benötigt eine eindeutige Produkt- und Variantenangabe");
        }

        const [kitProduct] = await db
          .select({ variants: articles.variants, sellingPrice: articles.sellingPrice, salePrice: articles.salePrice })
          .from(articles)
          .where(and(eq(articles.isActive, 1), eq(articles.shopProductId, item.shopProductId)))
          .limit(1);
        const configuredVariants = Array.isArray(kitProduct?.variants)
          ? kitProduct.variants as Array<{ dosage?: unknown; price?: unknown; hidden?: unknown }>
          : [];
        const configuredVariant = configuredVariants.find((variant) =>
          variant.hidden !== true
          && typeof variant.dosage === "string"
          && variant.dosage.trim().toLowerCase() === item.dosage!.trim().toLowerCase(),
        );
        const configuredBasePrice = Number(configuredVariant?.price ?? kitProduct?.sellingPrice);
        const configuredSalePrice = Number(kitProduct?.salePrice);
        // Muss die öffentliche Preiswahl von ProductCard/ProductModal exakt spiegeln:
        // Ein positiver Angebotswert gilt produktweit, sonst der gewählte Variantenpreis.
        const basePrice = Number.isFinite(configuredSalePrice) && configuredSalePrice > 0
          ? configuredSalePrice
          : configuredBasePrice;
        const expectedKitPrice = roundMoney(basePrice + nasalSprayKitConfig.surcharge);
        if (!Number.isFinite(basePrice) || basePrice < 0 || Math.abs(roundMoney(item.price) - expectedKitPrice) > 0.02) {
          throw new Error(`Nasenspray Kit Preis für ${item.name} ist nicht gültig`);
        }
      }
      if (requestedKitUnits > 0 && (!nasalSprayKitAvailability.kitAvailable || nasalSprayKitAvailability.availableUnits < requestedKitUnits)) {
        throw new Error("Nasenspray Kit ist aktuell nicht verfügbar: BAC Wasser 10 ml reicht nicht aus");
      }

      // P4P receives an additional customer-facing reference only once the stock
      // check succeeded. It never replaces the canonical WaWi order ID.
      if (isPeps4petsOrder) {
        const p4pSequence = await db.execute(sql`SELECT nextval('peps4pets_order_reference_seq') AS reference_number`);
        const p4pRows = p4pSequence as any;
        const referenceNumber = p4pRows?.[0]?.reference_number ?? p4pRows?.rows?.[0]?.reference_number;
        if (referenceNumber === undefined || referenceNumber === null) {
          throw new Error("Die Peps4pets-Bestellreferenz konnte nicht erzeugt werden");
        }
        externalOrderReference = `P4P-${String(referenceNumber)}`;
      }

      // ── Stock deduction: reduce stock for all ordered peptide items ──
      // Bei Substitution: Bestand der Ersatz-Varianten abziehen, nicht der bestellten Variante
      for (let itemIdx = 0; itemIdx < input.items.length; itemIdx++) {
        const item = input.items[itemIdx];
        if (item.type !== 'peptide') continue;

        const sub = substitutionMap.get(itemIdx);
        if (sub && sub.possible) {
          // Substitution: Bestand der Ersatz-Varianten abziehen
          for (const comp of sub.components) {
            const article = allArticlesForCheck.find(a => a.id === comp.articleId);
            if (!article) continue;
            const newStock = (article.stock ?? 0) - comp.quantity;
            await db.update(articles).set({ stock: newStock, updatedAt: new Date() }).where(eq(articles.id, article.id));
            await db.insert(stockHistory).values({
              articleId: article.id,
              quantityChange: -comp.quantity,
              changeType: 'verkauf',
              quantityBefore: article.stock ?? 0,
              quantityAfter: newStock,
              reason: `Smart Substitution für Bestellung ${orderId}: ${sub.internalNote}`,
              orderId: orderId,
              userName: 'system',
            });
            console.log(`[Orders] Smart Substitution deducted: ${article.name} ${article.stock} → ${newStock} (order ${orderId})`);
          }
        } else {
          // Normal: Bestand der bestellten Variante abziehen
          const matchingArticles = findMatchingArticles(item, allArticlesForCheck);
          let remainingToDeduct = item.quantity;
          for (const article of matchingArticles) {
            if (remainingToDeduct <= 0) break;
            const deduct = Math.min(remainingToDeduct, article.stock ?? 0);
            if (deduct > 0) {
              const newStock = (article.stock ?? 0) - deduct;
              await db.update(articles).set({ stock: newStock, updatedAt: new Date() }).where(eq(articles.id, article.id));
              await db.insert(stockHistory).values({
                articleId: article.id,
                quantityChange: -deduct,
                changeType: 'verkauf',
                quantityBefore: article.stock ?? 0,
                quantityAfter: newStock,
                reason: `Bestandsabzug für Bestellung ${orderId}`,
                orderId: orderId,
                userName: 'system',
              });
              remainingToDeduct -= deduct;
              console.log(`[Orders] Stock deducted: ${article.name} ${article.stock} → ${newStock} (order ${orderId})`);
            }
          }
        }
      }

      // ── Substitutions-Notiz in Bestellnotiz speichern (intern, für WaWi) ──
      const substitutionNotes = Array.from(substitutionMap.values())
        .filter(s => s.possible)
        .map(s => s.internalNote);
      if (substitutionNotes.length > 0) {
        // Wird später in internalNote der Bestellung gespeichert
        (input as any)._substitutionNotes = substitutionNotes.join(' | ');
      }

      // Insert order
      await db.insert(orders).values({
        orderId: orderId,
        storeKey: input.storeKey,
        externalOrderReference,
        checkoutIdempotencyKey: checkoutIdempotencyKey || null,
        firstName: input.customer.firstName,
        lastName: input.customer.lastName,
        // Leerer Wert statt einer künstlichen Platzhalteradresse, wenn keine E-Mail erfasst wurde.
        email: input.customer.email || "",
        phone: input.customer.phone,
        street: input.customer.street,
        houseNumber: input.customer.houseNumber,
        zip: (input.customer.zip ?? "").trim(), // trim() verhindert DHL-Fehler
        city: input.customer.city,
        country: input.customer.country,
        // Bei DHL-Abholorten: company NICHT mit Postnummer befüllen
        company: input.customer.deliveryType === "packstation" || input.customer.deliveryType === "postfiliale" ? null : (input.customer.company || null),
        deliveryType: input.customer.deliveryType || "home",
        dhlPostNumber: input.customer.dhlPostNumber || null,
        subtotal: input.subtotal.toFixed(2),
        discount: input.discount.toFixed(2),
        discountCode: input.discountCode,
        discountBreakdown,
        shipping: input.shipping.toFixed(2),
        shippingCountry: input.shippingCountry,
        total: input.total.toFixed(2),
        paymentMethod: input.paymentMethod,
        status: "offen",
        orderDate: new Date(input.date),
        partnerCode: partnerCode ? partnerCode.toUpperCase() : null,
        partnerNumber: partnerNumber || null,
        partnerDiscount: partnerDiscountAmount.toFixed(2),
        partnerCommission: partnerCommissionAmount.toFixed(2),
        creditUsed: creditUsed.toFixed(2),
        kwkCreditUsed: (input.kwkCreditUsed || 0).toFixed(2),
        kwkCreditRequested: (input.kwkCreditUsed || 0).toFixed(2),
        qrCampaignId: qrAttribution?.campaignId ?? null,
        qrAttributionToken: qrAttribution?.attributionToken ?? null,
        qrCode: qrAttribution?.shortCode ?? null,
        qrCampaignName: qrAttribution?.campaignName ?? null,
        qrCampaignMedium: qrAttribution?.medium ?? null,
        qrCampaignLocation: qrAttribution?.locationPartner ?? null,
        // Substitutions-Notiz intern speichern (nur für WaWi sichtbar)
        internalNote: withStoreSourceMarker(input.storeKey, [
          input.internalNote,
          (input as any)._stockOverrideNote,
          (input as any)._substitutionNotes,
        ]),
      });

      if (authoritativeKwkCredit > 0 && kwkCreditAccountId) {
        await db.execute(sql`
          INSERT INTO kwk_ledger (kwk_id, order_id, amount, type, status, note, created_by)
          VALUES (${kwkCreditAccountId}, ${orderId}, ${(-authoritativeKwkCredit).toFixed(2)},
                  'redeemed', 'confirmed', ${`Guthaben eingelöst bei Bestellung ${orderId}`}, 'system')
        `);
        await db.execute(sql`
          UPDATE kwk_accounts
          SET credit_available = (
                SELECT COALESCE(SUM(CASE
                  WHEN type IN ('credit_released','redeemed','cancelled','refund','manual_correction')
                   AND status='confirmed' THEN amount ELSE 0 END), 0)
                FROM kwk_ledger WHERE kwk_id=${kwkCreditAccountId}
              ),
              credit_redeemed = (
                SELECT COALESCE(SUM(ABS(amount)), 0) FROM kwk_ledger
                WHERE kwk_id=${kwkCreditAccountId} AND type='redeemed' AND status='confirmed'
              ),
              updated_at=NOW()
          WHERE id=${kwkCreditAccountId}
        `);
      }

      // Insert order items. If a client omitted the selected dosage, recover it
      // generically from the persisted product variants and the exact selected unit price.
      // This changes only the display metadata; price, stock and substitution logic remain untouched.
      const resolveDisplayDosage = async (item: typeof input.items[number]): Promise<string | null> => {
        const supplied = item.dosage?.trim();
        if (supplied) return supplied;
        if (item.type !== 'peptide' || !item.shopProductId) return null;
        const [product] = await db.select().from(articles)
          .where(and(eq(articles.isActive, 1), eq(articles.shopProductId, item.shopProductId)))
          .limit(1);
        const variants = Array.isArray(product?.variants)
          ? product.variants as Array<{ dosage?: unknown; price?: unknown }>
          : [];
        const selected = variants.find((variant) => Number(variant.price) === Number(item.price));
        return typeof selected?.dosage === 'string' && selected.dosage.trim() ? selected.dosage.trim() : null;
      };

      for (const item of input.items) {
        const displayDosage = await resolveDisplayDosage(item);
        await db.insert(orderItems).values({
          orderId: orderId,
          name: item.name,
          dosage: displayDosage,
          variant: item.variant || null,
          type: item.type,
          price: item.price.toFixed(2),
          quantity: item.quantity,
          // Nasenspray- und Plug&Play-Flag speichern (für WaWi-Anzeige)
          isNasalSpray: item.isNasalSpray === true ||
            item.name.toLowerCase().includes('[nasenspray]') ||
            item.name.toLowerCase().includes('nasenspray'),
          isNasalDiySet: item.isNasalDiySet === true,
          isPlugPlay: item.isPlugPlay === true ||
            item.name.toLowerCase().includes('[plug&play') ||
            item.name.toLowerCase().includes('plug&play patrone'),
        });
      }

      // ── Nasenspray: automatisch BAC Wasser 10ml (0€) hinzufügen und Bestand abziehen ──
      // Erkennung über isNasalSpray-Flag (primär) oder Name-Fallback (Legacy)
      const nasalSprayCount = input.items.filter(i =>
        i.isNasalDiySet !== true && (
          i.isNasalSpray === true ||
          i.name.toLowerCase().includes('[nasenspray]') ||
          i.name.toLowerCase().includes('nasenspray')
        )
      ).length;
      if (nasalSprayCount > 0) {
        const [bacWasser10ml] = await db.select().from(articles)
          .where(eq(articles.shopProductId, 'bac-wasser'))
          .limit(1);
        const bacArticleId = bacWasser10ml?.id ?? null;
        // Als 0€-Position in die Bestellung einfügen
        await db.insert(orderItems).values({
          orderId: orderId,
          name: 'BAC Wasser 10ml (GRATIS)',
          dosage: null,
          variant: '10ml',
          type: 'accessory',
          price: '0.00',
          quantity: nasalSprayCount,
          articleId: bacArticleId,
        });
        // Bestand abziehen
        if (bacWasser10ml && (bacWasser10ml.stock ?? 0) > 0) {
          const deduct = Math.min(nasalSprayCount, bacWasser10ml.stock ?? 0);
          const newStock = (bacWasser10ml.stock ?? 0) - deduct;
          await db.update(articles).set({ stock: newStock, updatedAt: new Date() }).where(eq(articles.id, bacWasser10ml.id));
          await db.insert(stockHistory).values({
            articleId: bacWasser10ml.id,
            quantityChange: -deduct,
            changeType: 'verkauf',
            quantityBefore: bacWasser10ml.stock ?? 0,
            quantityAfter: newStock,
            reason: `Automatischer Abzug: Nasenspray-Bestellung ${orderId}`,
            orderId: orderId,
            userName: 'system',
          });
          console.log(`[Orders] BAC Wasser 10ml Bestand abgezogen: ${bacWasser10ml.stock} → ${newStock} (${nasalSprayCount}x Nasenspray, order ${orderId})`);
        } else {
          console.warn(`[Orders] BAC Wasser 10ml nicht gefunden oder kein Bestand für Nasenspray-Bestellung ${orderId}`);
        }
      }

      // ── Nasenspray Kit: transparente Zubehörpositionen und BAC-Bestandsabzug ──
      // BAC Wasser 10 ml ist die einzige bestandsgeführte Komponente. Flasche und
      // Aufziehspritze/Kanüle gehören zum Lieferumfang, aber erhalten bewusst keine
      // erfundene WaWi-Lagerzeile.
      for (const item of nasalSprayKitItems) {
        for (const component of nasalSprayKitConfig.components) {
          let componentArticle: typeof articles.$inferSelect | undefined;
          if (component.inventoryTracked && component.articleShopProductId) {
            [componentArticle] = await db.select().from(articles)
              .where(and(eq(articles.shopProductId, component.articleShopProductId), eq(articles.isActive, 1)))
              .limit(1);
          }
          const componentQuantity = item.quantity * component.quantityPerKit;
          await db.insert(orderItems).values({
            orderId,
            name: component.name,
            dosage: null,
            variant: component.variant,
            type: "accessory",
            price: "0.00",
            quantity: componentQuantity,
            articleId: componentArticle?.id ?? null,
            isNasalDiySet: true,
          });

          if (componentArticle) {
            const newStock = (componentArticle.stock ?? 0) - componentQuantity;
            await db.update(articles).set({ stock: newStock, updatedAt: new Date() }).where(eq(articles.id, componentArticle.id));
            await db.insert(stockHistory).values({
              articleId: componentArticle.id,
              quantityChange: -componentQuantity,
              changeType: "verkauf",
              quantityBefore: componentArticle.stock ?? 0,
              quantityAfter: newStock,
              reason: `Nasenspray Kit für Bestellung ${orderId}`,
              orderId,
              userName: "system",
            });
          }
        }
      }

      // KWK-Zuordnung und Pending-Guthaben werden in derselben DB-Transaktion wie
      // Bestellung und Bestand geschrieben. Ein KWK-Fehler darf keinen rabattierten
      // Auftrag ohne Werberzuordnung hinterlassen.
      if (kwkReferralAccount) {
        const kwkId = kwkReferralAccount.id;
        const addressHash = hashAddress(input.customer.street, input.customer.zip, input.customer.city);
        const fraudFlags = { sameEmail: false, samePhone: false, sameAddress: false };
        const commissionBase = calculateKwkCommissionBase({
          subtotal: input.subtotal,
          totalDiscount: input.discount,
          partnerCreditUsed: 0,
          kwkCreditUsed: 0,
        });
        const commissionAmount = calculateKwkCommission(commissionBase);

        await db.execute(sql`
          INSERT INTO kwk_referrals
            (kwk_id, order_id, customer_email, customer_phone, customer_address_hash,
             discount_applied, commission_base, commission_amount, fraud_flags, status)
          VALUES
            (${kwkId}, ${orderId}, ${(input.customer.email || "").trim().toLowerCase()},
             ${input.customer.phone}, ${addressHash}, ${(input.kwkDiscount || 0).toFixed(2)},
             ${commissionBase.toFixed(2)}, ${commissionAmount.toFixed(2)},
             ${JSON.stringify(fraudFlags)}::jsonb, 'pending')
        `);

        if (commissionAmount > 0) {
          await db.execute(sql`
            INSERT INTO kwk_ledger (kwk_id, order_id, amount, type, status, note, created_by)
            VALUES (${kwkId}, ${orderId}, ${commissionAmount.toFixed(2)}, 'pending_credit', 'pending',
                    ${`Pending-Gutschrift für Bestellung ${orderId}`}, 'system')
          `);
          await db.execute(sql`
            UPDATE kwk_accounts
            SET credit_pending = (
                  SELECT COALESCE(SUM(amount), 0) FROM kwk_ledger
                  WHERE kwk_id=${kwkId} AND type='pending_credit' AND status='pending'
                ),
                updated_at=NOW()
            WHERE id=${kwkId}
          `);
        }
        console.log(`[KWK] Atomare Neukundenempfehlung ${orderId} → KWK-${kwkId}, pending ${commissionAmount.toFixed(2)}€`);
      }

      // ── Auto-create or link customer ──
      try {
        const customerEmail = (input.customer.email || "").toLowerCase().trim();
        const customerPhone = input.customer.phone.trim();
        const fullName = `${input.customer.firstName} ${input.customer.lastName}`;

        // If existingCustomerId is provided (from KI-Erfassung manual match), use it directly
        let existingCustomer: any = null;
        if (input.existingCustomerId) {
          const [found] = await db.select().from(customers).where(eq(customers.id, input.existingCustomerId));
          if (found) {
            existingCustomer = found;
            console.log(`[Customers] Using manually matched customer ID=${input.existingCustomerId} (${found.name})`);
          }
        }

        if (!existingCustomer) {
          // Try to find existing customer by email or phone
          const allCustomers = await db.select().from(customers);
          // Normalize phone for comparison
          const normalizePhone = (p: string) => p.replace(/[\s\-\.\(\)]/g, '');
          const normPhone = normalizePhone(customerPhone);
          const PLACEHOLDER_EMAILS_MATCH = new Set(['keine@angabe.de', 'noemail@noemail.de', 'no@email.de', 'otc@369research.eu', '']);
          const emailUsableForMatch = customerEmail && !PLACEHOLDER_EMAILS_MATCH.has(customerEmail.toLowerCase());
          // Phone matching: only use if the number is UNIQUE (exactly one customer has it)
          // This prevents false positives when multiple customers share the same phone number
          const phoneMatchCandidates = normPhone.length >= 8
            ? allCustomers.filter(c => c.phone && normalizePhone(c.phone) === normPhone)
            : [];
          const phoneIsUnique = phoneMatchCandidates.length === 1;
          existingCustomer = allCustomers.find(c =>
            (emailUsableForMatch && c.email && c.email.toLowerCase() === customerEmail) ||
            (phoneIsUnique && c.phone && normalizePhone(c.phone) === normPhone && normPhone.length >= 8)
          );
          if (!phoneIsUnique && phoneMatchCandidates.length > 1) {
            console.warn(`[Customers] Phone ${normPhone} matches ${phoneMatchCandidates.length} customers – skipping phone-based match to avoid false assignment`);
          }
        }

        if (existingCustomer) {
          // Update existing customer with latest data
          customerId = existingCustomer.id;
          const identityChanged = [
            existingCustomer.name !== fullName,
            (existingCustomer.phone || "") !== (customerPhone || existingCustomer.phone || ""),
            (existingCustomer.email || "").toLowerCase() !== (customerEmail || existingCustomer.email || "").toLowerCase(),
            (existingCustomer.street || "") !== (input.customer.street || ""),
            (existingCustomer.houseNumber || "") !== (input.customer.houseNumber || ""),
            (existingCustomer.zip || "") !== ((input.customer.zip ?? "").trim()),
            (existingCustomer.city || "") !== (input.customer.city || ""),
            (existingCustomer.country || "") !== (input.customer.country || ""),
          ].some(Boolean);
          const newTotalOrders = existingCustomer.totalOrders + 1;
          const newTotalSpent = parseFloat(existingCustomer.totalSpent) + input.total;

          await db.update(customers).set({
            name: fullName,
            firstName: input.customer.firstName,
            lastName: input.customer.lastName,
            phone: customerPhone || existingCustomer.phone,
            email: customerEmail || existingCustomer.email,
            // Bei Packstation: company NICHT mit Postnummer überschreiben
            company: input.customer.deliveryType === "packstation" ? existingCustomer.company : (input.customer.company || existingCustomer.company),
            street: input.customer.street,
            houseNumber: input.customer.houseNumber,
            zip: (input.customer.zip ?? "").trim(),
            city: input.customer.city,
            country: input.customer.country,
            totalOrders: newTotalOrders,
            totalSpent: newTotalSpent.toFixed(2),
            lastOrderDate: new Date(),
            updatedAt: new Date(),
          }).where(eq(customers.id, existingCustomer.id));

          customerIntegrityTrigger = identityChanged ? "order_customer_changed" : null;
          console.log(`[Customers] Linked order ${orderId} to existing customer #${existingCustomer.customerNumber} (${fullName})`);
        } else {
          // Generate next customer number (starting at 1210)
          const maxResult = await db.execute(sql`SELECT COALESCE(MAX(CAST(customer_number AS INTEGER)), 1209) as max_num FROM customers WHERE customer_number ~ '^[0-9]+$'`);
          const rows = maxResult as any;
          let nextNum = 1210;
          if (rows && rows.length > 0 && rows[0].max_num) {
            nextNum = parseInt(rows[0].max_num) + 1;
          } else if (rows?.rows && rows.rows.length > 0) {
            nextNum = parseInt(rows.rows[0].max_num) + 1;
          }
          if (nextNum < 1210) nextNum = 1210;

          // Determine acquisition source
          const acquiredBy = partnerCode ? "partner" as const : "shop" as const;
          let acquiredByPartnerId: number | null = null;
          if (partnerCode) {
            const [assignedPartner] = await db.select({ id: partners.id }).from(partners)
              .where(and(eq(partners.code, partnerCode.toUpperCase()), eq(partners.isActive, 1)))
              .limit(1);
            acquiredByPartnerId = assignedPartner?.id ?? null;
          }

          const [newCustomer] = await db.insert(customers).values({
            customerNumber: String(nextNum),
            name: fullName,
            firstName: input.customer.firstName,
            lastName: input.customer.lastName,
            phone: customerPhone || null,
            email: customerEmail || null,
            // Bei Packstation: company NICHT mit Postnummer befüllen
            company: input.customer.deliveryType === "packstation" ? null : (input.customer.company || null),
            street: input.customer.street,
            houseNumber: input.customer.houseNumber,
            zip: (input.customer.zip ?? "").trim(),
            city: input.customer.city,
            country: input.customer.country,
            source: "shop",
            acquiredBy,
            acquiredByPartnerId,
            totalOrders: 1,
            totalSpent: input.total.toFixed(2),
            firstOrderDate: new Date(),
            lastOrderDate: new Date(),
          }).returning();

          customerId = newCustomer.id;
          customerIntegrityTrigger = "order_customer_created";
          console.log(`[Customers] Created new customer #${nextNum} (${fullName}) for order ${orderId}`);
        }

        // Link order to customer
        if (customerId) {
          await db.update(orders).set({ customerId }).where(eq(orders.orderId, orderId));
          if (customerIntegrityTrigger) {
            try {
              await queueCustomerDuplicateReview(customerId, customerIntegrityTrigger, "order.create");
            } catch (error) {
              console.warn("[Customer Integrity] Prüfung nach Bestell-Kundenabgleich fehlgeschlagen (nicht blockierend):", error);
            }
          }
        }

        // NOTE: Communication log is written AFTER successful email send (see below)
        // Do NOT log here to avoid false-positive idempotency check
      } catch (err) {
        console.warn("[Customers] Failed to auto-create/link customer:", err);
      }

      });

      // Nach Kundenverknüpfung wird der bereits gesicherte Nachweis zusätzlich der
      // Kundenakte zugeordnet, ohne seinen Inhalt oder seine Bestätigung zu verändern.
      if (customerId && addressWarningNeedsConfirmation) {
        try {
          const pool = await getPool();
          await pool?.query("UPDATE address_validation_records SET customer_id = $1 WHERE order_id = $2 AND customer_id IS NULL", [customerId, orderId]);
        } catch (error) {
          console.error(`[AddressValidation] Kundenverknüpfung für Nachweis ${orderId} konnte nicht ergänzt werden:`, error);
        }
      }

      // Der Guthabeneinsatz wird erst nach vollständiger Bestellpersistenz gebucht.
      // Der zentrale Service sperrt den Partnerdatensatz und verhindert Doppelbuchungen.
      if (creditUsed > 0) {
        await redeemPartnerCreditForOrder(orderId);
      }

      // Log new order
      const { generateSKUFromName: _logSku } = await import("./articleCodes.js");
      const itemList = input.items.map(i => `${i.quantity}x ${_logSku(i.name, i.dosage || i.variant)}`).join(", ");
      console.log(`[Orders] New order: ${orderId} – ${input.total.toFixed(2)} EUR – ${input.customer.firstName} ${input.customer.lastName} – ${itemList}`);

      // The shared CRM service sends, archives and protects the confirmation with
      // a Resend idempotency key. Do not add a second order-router log entry here.
      try {
        const emailSent = await sendOrderConfirmationEmail({
          orderId: orderId,
          storeKey: input.storeKey,
          externalOrderReference,
          customer: input.customer,
          items: input.items.map(i => ({ ...i, dosage: i.dosage || null, variant: i.variant || null })),
          subtotal: input.subtotal,
          discount: input.discount,
          discountCode: input.discountCode,
          shipping: input.shipping,
          total: input.total,
          paymentMethod: input.paymentMethod,
        });
        if (!emailSent) {
          console.warn(`[Orders] Confirmation email was not accepted for ${orderId}; failure is stored in the CRM communication record`);
        }
      } catch (err) {
        console.warn("[Orders] Failed to send confirmation email:", err);
      }

      // Admin-Benachrichtigung deaktiviert:
      // Pakko erhält bereits eine BCC-Kopie der Bestellbestätigung (mit IBAN/Zahlungsinfos).
      // Eine zusätzliche interne Mail wäre redundant und führt zu 4 Mails pro Bestellung.
      // sendAdminOrderNotification wurde hier entfernt.

      return {
        success: true,
        orderId,
        externalOrderReference: externalOrderReference || undefined,
        subtotal: input.subtotal,
        discount: input.discount,
        kwkDiscount: input.kwkDiscount || 0,
        kwkCreditUsed: input.kwkCreditUsed || 0,
        shipping: input.shipping,
        total: input.total,
      };
      } finally {
        if (p4pLockClient) {
          try {
            await p4pLockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [`peps4pets-checkout:${checkoutIdempotencyKey}`]);
          } finally {
            p4pLockClient.release();
          }
        }
      }
    }),

  // ADMIN: List all orders with items
  list: adminProcedure
    .input(z.object({
      status: z.enum(["alle", "offen", "bezahlt", "gepackt", "versendet", "zugestellt", "abgeholt", "storniert"]).optional(),
      search: z.string().optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Build WHERE conditions directly in DB – avoids loading all rows into JS
      const conditions: any[] = [];
      if (input?.status && input.status !== "alle") {
        conditions.push(eq(orders.status, input.status as any));
      }
      if (input?.search) {
        const s = `%${input.search.toLowerCase()}%`;
        conditions.push(
          sql`(LOWER(${orders.orderId}) LIKE ${s} OR LOWER(${orders.externalOrderReference}) LIKE ${s} OR LOWER(${orders.firstName}) LIKE ${s} OR LOWER(${orders.lastName}) LIKE ${s} OR LOWER(${orders.email}) LIKE ${s})`
        );
      }

      const filteredOrders = conditions.length > 0
        ? await db.select().from(orders).where(and(...conditions)).orderBy(desc(orders.orderDate))
        : await db.select().from(orders).orderBy(desc(orders.orderDate));

      // Get items for all returned orders in a single query
      const orderIds = filteredOrders.map(o => o.orderId);
      let items: any[] = [];
      if (orderIds.length > 0) {
        items = await db.select().from(orderItems).where(
          inArray(orderItems.orderId, orderIds)
        );
      }

      // Combine
      const result = filteredOrders.map(o => ({
        ...o,
        subtotal: parseFloat(o.subtotal),
        discount: parseFloat(o.discount),
        discountBreakdown: o.discountBreakdown || [],
        shipping: parseFloat(o.shipping),
        total: parseFloat(o.total),
        partnerDiscount: parseFloat(o.partnerDiscount ?? "0"),
        partnerCommission: parseFloat(o.partnerCommission ?? "0"),
        creditUsed: parseFloat(o.creditUsed ?? "0"),
        kwkCreditUsed: parseFloat(o.kwkCreditUsed ?? "0"),
        kwkCreditRequested: parseFloat(o.kwkCreditRequested ?? "0"),
        items: items
          .filter(i => i.orderId === o.orderId)
          .map(i => ({
            ...i,
            price: parseFloat(i.price),
          })),
      }));

      return result;
    }),

  // ADMIN: Get single order with items
  get: adminProcedure
    .input(z.object({ orderId: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [order] = await db.select().from(orders).where(or(
        eq(orders.orderId, input.orderId),
        eq(orders.externalOrderReference, input.orderId),
      )).limit(1);
      if (!order) throw new Error("Order not found");

      const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.orderId));

      return {
        ...order,
        subtotal: parseFloat(order.subtotal),
        discount: parseFloat(order.discount),
        discountBreakdown: order.discountBreakdown || [],
        shipping: parseFloat(order.shipping),
        total: parseFloat(order.total),
        partnerDiscount: parseFloat(order.partnerDiscount ?? "0"),
        partnerCommission: parseFloat(order.partnerCommission ?? "0"),
        creditUsed: parseFloat(order.creditUsed ?? "0"),
        kwkCreditUsed: parseFloat(order.kwkCreditUsed ?? "0"),
        kwkCreditRequested: parseFloat(order.kwkCreditRequested ?? "0"),
        items: items.map(i => ({ ...i, price: parseFloat(i.price) })),
      };
    }),

  // ADMIN: Update order status
  updateStatus: adminProcedure
    .input(updateStatusSchema)
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const updateData: Record<string, any> = {
        status: input.status,
      };

      // Set timestamps based on status
      const now = new Date();
      if (input.status === "bezahlt") updateData.paidAt = now;
      if (input.status === "gepackt") updateData.packedAt = now;
      if (input.status === "versendet") {
        updateData.shippedAt = now;
        if (input.trackingNumber) updateData.trackingNumber = input.trackingNumber;
        if (input.trackingCarrier) updateData.trackingCarrier = input.trackingCarrier;
      }
      if (input.status === "zugestellt") updateData.deliveredAt = now;
      if (input.status === "abgeholt") updateData.deliveredAt = now; // Abholung = final wie zugestellt
      if (input.status === "storniert") updateData.cancelledAt = now;
      if (input.internalNote !== undefined) updateData.internalNote = input.internalNote;

      await db.update(orders).set(updateData).where(eq(orders.orderId, input.orderId));

      // Partnerguthaben ist strikt zahlungsgebunden. Wiederholte Klicks sind idempotent.
      if (input.status === "bezahlt") {
        const creditResult = await bookPaidPartnerCommission(input.orderId);
        console.log(`[Partners] Zahlungsgebundene Gutschrift ${input.orderId}: ${creditResult.reason} (${creditResult.amount.toFixed(2)} €)`);
      }

      // KWK-Guthaben ist wie Partnerguthaben strikt zahlungsgebunden.
      // Wiederholte Zahlungsereignisse sind im KWK-Service idempotent.
      if (input.status === "bezahlt") {
        try {
          const { releaseCredit } = await import('./kwkService.js');
          await releaseCredit(input.orderId);
        } catch (kwkErr) {
          console.warn('[KWK] releaseCredit failed (non-fatal):', kwkErr);
        }
      }
      // KWK-Guthaben entfernen bei Storno
      if (input.status === "storniert") {
        try {
          const { cancelCredit } = await import('./kwkService.js');
          await cancelCredit(input.orderId);
        } catch (kwkErr) {
          console.warn('[KWK] cancelCredit failed (non-fatal):', kwkErr);
        }
      }

      // Send shipping notification email when status changes to "versendet"
      let emailResult: { sent: boolean; error?: string } = { sent: false };
      if (input.status === "versendet" && input.sendShippingEmail !== false) {
        try {
          const [order] = await db.select().from(orders).where(eq(orders.orderId, input.orderId)).limit(1);
          if (order) {
            emailResult = await sendShippingNotificationEmail({
              orderId: input.orderId,
              customerEmail: order.email,
              customerName: order.firstName,
              trackingNumber: input.trackingNumber,
              trackingCarrier: input.trackingCarrier,
            });
          }
        } catch (err: any) {
          emailResult = { sent: false, error: err?.message || "Unbekannter Fehler" };
          console.warn("[Orders] Failed to send shipping notification:", err);
        }
      }

      return {
        success: true,
        emailSent: emailResult.sent,
        emailError: emailResult.error,
      };
    }),

  // ADMIN: Get order statistics
  stats: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const allOrders = await db.select().from(orders);

    const stats = {
      total: allOrders.length,
      offen: allOrders.filter(o => o.status === "offen").length,
      bezahlt: allOrders.filter(o => o.status === "bezahlt").length,
      gepackt: allOrders.filter(o => o.status === "gepackt").length,
      versendet: allOrders.filter(o => o.status === "versendet").length,
      zugestellt: allOrders.filter(o => o.status === "zugestellt").length,
      storniert: allOrders.filter(o => o.status === "storniert").length,
      umsatzBezahlt: allOrders
        .filter(o => ["bezahlt", "gepackt", "versendet", "zugestellt"].includes(o.status))
        .reduce((sum, o) => sum + parseFloat(o.total), 0),
      umsatzOffen: allOrders
        .filter(o => o.status === "offen")
        .reduce((sum, o) => sum + parseFloat(o.total), 0),
    };

    return stats;
  }),

  // ADMIN: Bunq payment matching (intelligent)
  matchBunqPayments: adminProcedure.mutation(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    // Get today's date range (start of day to now)
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get ALL recent orders (not just open ones):
    // - Open orders (need matching)
    // - Today's paid orders (for display)
    // - Orders without bunq match (bunqPaymentId is null)
    const allOrders = await db.select().from(orders).orderBy(desc(orders.orderDate));
    
    // Filter: open orders + today's bezahlt orders + any order without bunq match
    const relevantOrders = allOrders.filter(o => {
      const isOpen = o.status === "offen";
      const isTodayPaid = o.status === "bezahlt" && o.orderDate && new Date(o.orderDate) >= today;
      const isUnmatched = !o.bunqPaymentId && ["offen", "bezahlt"].includes(o.status);
      return isOpen || isTodayPaid || isUnmatched;
    });

    if (relevantOrders.length === 0) {
      return { 
        matched: 0, 
        results: [],
        totalPaymentsChecked: 0,
        message: "Keine relevanten Bestellungen vorhanden." 
      };
    }

    // Get incoming payments from Bunq
    const payments = await getIncomingPayments(200);

    let autoMatchedCount = 0;
    const results: Array<{
      orderId: string;
      customerName: string;
      orderTotal: number;
      orderStatus: string;
      orderDate: string;
      matchType: string;
      confidence: string;
      amountMatch: boolean;
      nameMatch: boolean;
      orderNumberMatch: boolean;
      paymentId: number | null;
      paymentAmount: string | null;
      paymentSender: string | null;
      paymentDescription: string | null;
      paymentDate: string | null;
      autoMatched: boolean;
      alreadyPaid: boolean;
    }> = [];

    // Track which payments have been used for matching
    const usedPaymentIds = new Set<number>();

    for (const order of relevantOrders) {
      const alreadyPaid = order.status === "bezahlt";
      const alreadyBunqMatched = !!order.bunqPaymentId;

      // Run intelligent matching
        const match = intelligentMatch(
          {
            orderId: order.orderId,
            externalOrderReference: order.externalOrderReference,
            firstName: order.firstName,
          lastName: order.lastName,
          total: order.total,
        },
        // Exclude already-used payments
        payments.filter(p => !usedPaymentIds.has(p.id))
      );

      let autoMatched = false;

      // Auto-match only for open orders with high confidence + amount match
      if (
        order.status === "offen" &&
        match.confidence === "high" &&
        match.amountMatch &&
        match.matchedPayment &&
        !usedPaymentIds.has(match.matchedPayment.id)
      ) {
        // Auto-mark as paid
        await db.update(orders).set({
          status: "bezahlt",
          paidAt: new Date(),
          bunqPaymentId: String(match.matchedPayment.id),
          bunqMatchedAt: new Date(),
        }).where(eq(orders.orderId, order.orderId));

        const creditResult = await bookPaidPartnerCommission(order.orderId);
        console.log(`[Partners] Zahlungsgebundene Gutschrift ${order.orderId}: ${creditResult.reason} (${creditResult.amount.toFixed(2)} €)`);

        usedPaymentIds.add(match.matchedPayment.id);
        autoMatchedCount++;
        autoMatched = true;
      }

      // If already bunq-matched, find the original payment for display
      let displayPayment = match.matchedPayment;
      if (alreadyBunqMatched && order.bunqPaymentId) {
        const existingPayment = payments.find(p => String(p.id) === order.bunqPaymentId);
        if (existingPayment) displayPayment = existingPayment;
      }

      results.push({
        orderId: order.orderId,
        customerName: `${order.firstName} ${order.lastName}`,
        orderTotal: parseFloat(order.total),
        orderStatus: autoMatched ? "bezahlt" : order.status,
        orderDate: order.orderDate ? new Date(order.orderDate).toISOString() : "",
        matchType: alreadyBunqMatched ? "alreadyMatched" : match.matchType,
        confidence: alreadyBunqMatched ? "high" : match.confidence,
        amountMatch: match.amountMatch,
        nameMatch: match.nameMatch,
        orderNumberMatch: match.orderNumberMatch,
        paymentId: displayPayment?.id || null,
        paymentAmount: displayPayment?.amount.value || null,
        paymentSender: displayPayment?.counterpartyAlias.name || null,
        paymentDescription: displayPayment?.description || null,
        paymentDate: displayPayment?.created || null,
        autoMatched,
        alreadyPaid: alreadyPaid || alreadyBunqMatched,
      });
    }

    // Collect unmatched payments (not used by any order, not already assigned)
    const allAssignedPaymentIds = new Set<number>();
    // Add IDs from auto-matched
    for (const id of usedPaymentIds) allAssignedPaymentIds.add(id);
    // Add IDs from already-matched orders in DB
    for (const o of allOrders) {
      if (o.bunqPaymentId) allAssignedPaymentIds.add(parseInt(o.bunqPaymentId));
    }
    // Add IDs from results that have a payment match
    for (const r of results) {
      if (r.paymentId) allAssignedPaymentIds.add(r.paymentId);
    }

    // Recent unmatched payments (last 7 days, not assigned to any order)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const unmatchedPayments = payments
      .filter(p => {
        if (allAssignedPaymentIds.has(p.id)) return false;
        const pDate = new Date(p.created);
        return pDate >= sevenDaysAgo;
      })
      .map(p => ({
        id: p.id,
        amount: p.amount.value,
        currency: p.amount.currency,
        sender: p.counterpartyAlias.name || "Unbekannt",
        description: p.description || "",
        date: p.created,
        iban: (p.counterpartyAlias as any).iban || "",
      }));

    return {
      matched: autoMatchedCount,
      results,
      unmatchedPayments,
      totalPaymentsChecked: payments.length,
      message: autoMatchedCount > 0
        ? `${autoMatchedCount} Bestellung(en) automatisch als bezahlt markiert!`
        : "Keine automatischen Matches gefunden. Prüfe die Details unten.",
    };
  }),

  // ADMIN: Manually assign a Bunq payment to an order
  assignBunqPayment: adminProcedure
    .input(z.object({
      orderId: z.string(),
      paymentId: z.number(),
      paymentAmount: z.string(),
      markAsPaid: z.boolean().default(true),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [order] = await db.select().from(orders).where(eq(orders.orderId, input.orderId)).limit(1);
      if (!order) throw new Error("Bestellung nicht gefunden");

      const updateData: Record<string, any> = {
        bunqPaymentId: String(input.paymentId),
        bunqMatchedAt: new Date(),
      };

      if (input.markAsPaid && order.status === "offen") {
        updateData.status = "bezahlt";
        updateData.paidAt = new Date();
      }

      await db.update(orders).set(updateData).where(eq(orders.orderId, input.orderId));

      if (input.markAsPaid && order.status === "offen") {
        const creditResult = await bookPaidPartnerCommission(input.orderId);
        console.log(`[Partners] Zahlungsgebundene Gutschrift ${input.orderId}: ${creditResult.reason} (${creditResult.amount.toFixed(2)} €)`);
      }

      console.log(`[Bunq] Manual assignment: Payment ${input.paymentId} (${input.paymentAmount} EUR) -> Order ${input.orderId}`);

      return { success: true, markedAsPaid: input.markAsPaid && order.status === "offen" };
    }),

  // ADMIN: Get recent Bunq payments (for manual review)
  bunqPayments: adminProcedure
    .input(z.object({ count: z.number().optional() }).optional())
    .query(async ({ input }) => {
      const payments = await getIncomingPayments(input?.count || 50);
      return payments;
    }),

  // ADMIN: Migrate payment_method enum to add new values
  migratePaymentEnum: adminProcedure
    .mutation(async () => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const newValues = ["SEPA", "Bar", "Kreditkarte", "PayPal", "Crypto", "Guthaben", "Sonstige"];
      const results: string[] = [];

      for (const val of newValues) {
        try {
          await db.execute(`ALTER TYPE payment_method ADD VALUE IF NOT EXISTS '${val}'`);
          results.push(`Added: ${val}`);
        } catch (err: any) {
          results.push(`Skipped ${val}: ${err.message}`);
        }
      }

      return { success: true, results };
    }),

  // ADMIN: Delete order WITHOUT stock restoration (items vanish, no restock)
  deleteNoRestock: adminProcedure
    .input(z.object({ orderId: z.string() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const [order] = await db.select().from(orders).where(eq(orders.orderId, input.orderId)).limit(1);
      if (!order) throw new Error("Bestellung nicht gefunden");
      await db.delete(orderItems).where(eq(orderItems.orderId, input.orderId));
      await db.delete(orders).where(eq(orders.orderId, input.orderId));
      console.log(`[Orders] Deleted order ${input.orderId} WITHOUT stock restoration`);
      return { success: true };
    }),

  // ADMIN: Delete order with stock restoration
  delete: adminProcedure
    .input(z.object({ orderId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Get the order
      const [order] = await db.select().from(orders).where(eq(orders.orderId, input.orderId)).limit(1);
      if (!order) throw new Error("Bestellung nicht gefunden");

      // Get order items
      const items = await db.select().from(orderItems).where(eq(orderItems.orderId, input.orderId));

      // Restore stock for each item that has an articleId
      for (const item of items) {
        if (item.articleId) {
          const [article] = await db.select().from(articles).where(eq(articles.id, item.articleId)).limit(1);
          if (article) {
            const newStock = article.stock + item.quantity;
            await db.update(articles).set({ stock: newStock }).where(eq(articles.id, item.articleId));

            // Log stock restoration
            await db.insert(stockHistory).values({
              articleId: item.articleId,
              changeType: "retoure",
              quantityBefore: article.stock,
              quantityChange: item.quantity,
              quantityAfter: newStock,
              reason: `Bestellung ${input.orderId} gel\u00f6scht`,
              orderId: input.orderId,
              userName: ctx.user?.name || "Admin",
            });
          }
        }
      }

      // Delete order items first
      await db.delete(orderItems).where(eq(orderItems.orderId, input.orderId));

      // Delete the order
      await db.delete(orders).where(eq(orders.orderId, input.orderId));

      console.log(`[Orders] Deleted order ${input.orderId} with stock restoration`);

      return { success: true, restoredItems: items.length };
    }),

  // ADMIN: Add internal note
  addNote: adminProcedure
    .input(z.object({
      orderId: z.string(),
      note: z.string(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      await db.update(orders).set({
        internalNote: input.note,
      }).where(eq(orders.orderId, input.orderId));

      return { success: true };
    }),

  // ADMIN: Update order (edit items, discount, shipping, total)
  update: adminProcedure
    .input(z.object({
      orderId: z.string(),
      items: z.array(z.object({
        name: z.string(),
        dosage: z.string().optional(),
        variant: z.string().optional(),
        price: z.number(),
        quantity: z.number(),
        type: z.string(),
        articleId: z.number().optional(),
      })),
      subtotal: z.number(),
      discount: z.number(),
      discountCode: z.string().nullable().optional(),
      discountBreakdown: z.array(discountBreakdownEntrySchema).max(30).optional(),
      shipping: z.number(),
      total: z.number(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Check order exists
      const [order] = await db.select().from(orders).where(eq(orders.orderId, input.orderId)).limit(1);
      if (!order) throw new Error("Bestellung nicht gefunden");

      // Update order financials
      await db.update(orders).set({
        subtotal: input.subtotal.toFixed(2),
        discount: input.discount.toFixed(2),
        discountCode: input.discountCode || null,
        ...(input.discountBreakdown !== undefined ? { discountBreakdown: input.discountBreakdown } : {}),
        shipping: input.shipping.toFixed(2),
        total: input.total.toFixed(2),
        updatedAt: new Date(),
      }).where(eq(orders.orderId, input.orderId));

      // Delete old items
      await db.delete(orderItems).where(eq(orderItems.orderId, input.orderId));

      // Insert new items
      for (const item of input.items) {
        await db.insert(orderItems).values({
          orderId: input.orderId,
          name: item.name,
          dosage: item.dosage || null,
          variant: item.variant || null,
          type: item.type,
          price: item.price.toFixed(2),
          quantity: item.quantity,
          articleId: item.articleId || null,
        });
      }

      console.log(`[Orders] Updated order ${input.orderId} – ${input.total.toFixed(2)} EUR – ${input.items.length} items`);

      return { success: true };
    }),

  // Send packing notification to customer (WhatsApp link + Email)
  sendPackingNotification: adminProcedure
    .input(z.object({
      orderId: z.string(),
      sendEmail: z.boolean().default(true),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Bestellung laden
      const [order] = await db.select().from(orders).where(eq(orders.orderId, input.orderId)).limit(1);
      if (!order) throw new Error("Bestellung nicht gefunden");

      const customerName = `${order.firstName} ${order.lastName}`.trim();
      const results: { channel: string; success: boolean; error?: string }[] = [];

      // E-Mail senden
      if (input.sendEmail && order.email) {
        const emailResult = await sendPackingNotificationEmail({
          orderId: order.orderId,
          customerEmail: order.email,
          customerName,
        });
        results.push({ channel: "email", success: emailResult.sent, error: emailResult.error });

        // The shared CRM service already stores the complete message, its sender
        // identity and the Resend status. Do not create a second summary record here.
      } else if (input.sendEmail && !order.email) {
        results.push({ channel: "email", success: false, error: "Keine E-Mail-Adresse hinterlegt" });
      }

      // WhatsApp-Nachricht generieren (Vorschau für Frontend)
      const phone = order.phone || "";
      const waMessage = `Hallo ${customerName} \ud83d\udc4b\n\ndein Paket f\u00fcr Bestellung *${order.orderId}* wird gerade gepackt und f\u00fcr den Versand vorbereitet! \ud83d\udce6\ud83d\udd2c\n\nSobald dein Paket auf dem Weg zu dir ist, bekommst du von uns eine weitere Nachricht mit deiner Sendungsnummer. \ud83d\ude9a\ud83d\udcec\n\nVielen Dank f\u00fcr dein Vertrauen! \ud83d\ude4f\n\n369 Research \ud83d\udd2c`;

      console.log(`[Orders] Packing notification for ${order.orderId}: email=${input.sendEmail}, phone=${phone}`);
      return {
        success: true,
        results,
        whatsappPhone: phone,
        whatsappMessage: waMessage,
        customerName,
        orderId: order.orderId,
      };
    }),

  // Reassign order to a different customer (admin only)
  reassignCustomer: adminProcedure
    .input(z.object({
      orderId: z.string(),
      newCustomerId: z.number(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const [order] = await db.select().from(orders).where(eq(orders.orderId, input.orderId)).limit(1);
      if (!order) throw new Error("Bestellung nicht gefunden");
      const oldCustomerId = order.customerId;
      await db.update(orders)
        .set({ customerId: input.newCustomerId, updatedAt: new Date() })
        .where(eq(orders.orderId, input.orderId));
      // Rebuild stats for both affected customers
      for (const cid of [oldCustomerId, input.newCustomerId] as number[]) {
        if (!cid) continue;
        const custOrders = await db.select().from(orders).where(sql`${orders.customerId} = ${cid}`);
        const totalOrders = custOrders.length;
        const totalSpent = custOrders.reduce((s, o) => s + parseFloat(o.total), 0);
        const dates = custOrders.map(o => o.orderDate).filter(Boolean) as Date[];
        const firstOrderDate = dates.length > 0 ? new Date(Math.min(...dates.map(d => d.getTime()))) : null;
        const lastOrderDate = dates.length > 0 ? new Date(Math.max(...dates.map(d => d.getTime()))) : null;
        await db.update(customers).set({ totalOrders, totalSpent: totalSpent.toFixed(2), firstOrderDate, lastOrderDate, updatedAt: new Date() }).where(sql`${customers.id} = ${cid}`);
      }
      console.log(`[Orders] Reassigned order ${input.orderId} from customer ${oldCustomerId} to ${input.newCustomerId}`);
      return { success: true, oldCustomerId, newCustomerId: input.newCustomerId };
    }),
});
