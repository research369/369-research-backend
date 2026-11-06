import { checkoutFingerprint, readCheckoutReceipt, lockCheckoutIntent, persistCheckoutReceipt, queueOrderTask, runOrderTask, resultRows, getOrderIntegrityIssues } from './priorityOrderIntegrity.js';
import { lockOrder, returnOrderStock, recordOrderAction, deleteOrderAtomically, assertOrderFinanciallyEditable } from './orderStockReturnService.js';
import { reverseOrderFinancesInTransaction } from './priorityOrderFinancialAdapter.js';
import {nextCustomerNumber} from './customerNumberService.js';
import {checkCustomerCreationMaintenance} from './customerCreationMaintenance.js';
import { publicCodeCommissionPreview } from "./partnerCommissionPreview.js";
import { hasOtherPaidCodeOrder, partnerPaidCodeContactKey } from "./partnerCodeHistory.js";
/**
 * Order Router – tRPC routes for order management (WaWi)
 * Public: createOrder (from checkout)
 * Protected (admin): list, updateStatus, matchPayments, etc.
 */

import {assertKwkNewCustomer,assertKwkCreditAvailable} from './kwkCheckoutEligibility.js';
import { z } from "zod";
import { assertManualSaleRole } from "./manualSaleAuthorization.js";
import { reassignOrderCustomer } from "./orderCustomerAssignmentService.js";
import {applyStockMovement} from "./stockMovementService.js";
import {orderHash} from "./jarvyOrderContract.js";
import { eq, desc, inArray, and, or, getTableColumns } from "drizzle-orm";
import { router, publicProcedure, adminProcedure } from "./trpc.js";
import { getDb, getPool } from "./db.js";
import { orders, orderItems, articles, stockHistory, customers, customerCommunications, promoCodes } from "../drizzle/schema.js";
import { getIncomingPayments, matchPaymentToOrder, intelligentMatch, type MatchResult } from "./bunqService.js";
import { sendOrderConfirmationEmail, sendShippingNotificationEmail, sendAdminOrderNotification, sendPackingNotificationEmail } from "./emailService.js";
import { getReleasedBankTransferInstructions } from "./paymentInstructionsConfig.js";
import { isSubstitutionEnabled, resolveSubstitution, extractDosageMg, isSubstitutionEligible } from "./substitutionService.js";
// KWK-Modul: statischer Import (sicherer als dynamischer Import)
import { isKwkEnabled, hashAddress, calculateKwkCommission, calculateKwkCommissionBase, redeemCreditInTransaction } from "./kwkService.js";
import { partners } from "../drizzle/schema.js";
import { sql } from "drizzle-orm";
import { queueCustomerDuplicateReview } from "./customerIntegrityService.js";
import { NASAL_DIY_SET_COMPONENTS, isNasalDiySetEligible } from "./nasalDiySetConfig.js";
import { persistAddressValidation, validateGermanAddress } from "./addressValidationService.js";
import {
  bookPaidPartnerCommission,
  redeemPartnerCreditForOrder,
  redeemPartnerCreditInTransaction,
  reversePartnerFinancialEntriesForCancelledOrder,
} from "./partnerCreditService.js";
import { createPartnerCreditTransactionQueryClient } from "./partnerCreditTransactionQuery.js";
import { resolveQrAttribution } from "./qrCampaignService.js";
import { withStoreSourceMarker } from "./storeSource.js";
import {
  calculateAuthoritativeKwkOrder,
  calculateAuthoritativeShipping,
  calculateAutomaticGlobalDiscount,
  calculatePromoDiscount,
  requiresColdChainShipping,
  normalizeKwkPhone,
  roundMoney,
  resolveShippingRegion,
  type PromoDefinition,
} from "./kwkCheckoutPricing.js";
import { getAuthenticatedKwkFromToken } from "./kwkAuth.js";
import {
  getActiveGlobalAutomaticDiscountFromDb,
  resolveGlobalAutomaticDiscountBenefits,
} from "./globalAutomaticDiscountConfig.js";
import { calculateAuthoritativeWawiManualOrder, normalizeDiscountCodeForOrderSource } from "./manualWawiPricing.js";
import { calculateAuthoritativeShopCheckoutPricing } from "./shopCheckoutPricing.js";
import { shouldSendOrderConfirmation } from "./orderConfirmationPolicy.js";
import { resolveSubstitutionProductFamily } from "./orderItemIdentity.js";
import { serializeKwkFraudFlags } from "./kwkReferralPayload.js";
import { getAuthenticatedPartnerFromRequest } from "./partnerAuth.js";
import { isPromoCodeExpired } from "./promoCodeRouter.js";
import {
  calculatePublicPartnerCustomerDiscount,
  calculateProgramDiscount,
  assertNoMixedPartnerOrderInput,
  assertPartnerShopCreditAvailable,
  resolveSelfOrderTerms,
  getPartnerProgram,
  isDiscountAllowedForProgram,
  isRepeatCodeUseAllowed,
  resolveActivePartnerCode,
  type PartnerProgram,
  type ResolvedPartnerCode,
} from "./partnerProgramService.js";
import { isFinanciallyPaidStatus } from "./paidFinancialStatus.js";
import { reconcileFreeBacWaterForShopOrder } from "./freeBacWaterService.js";
import { refreshCustomerOrderMetrics } from "./customerMetricsService.js";
import { isCommercialOrder, isCompletedCommercialOrder } from "./commercialOrderMetrics.js";
import { shouldKeepClientDiscountBreakdownSource } from "./discountBreakdownRules.js";
import {
  assertPromotionMinimumOrder,
  repricePublicCheckoutItems,
} from "./publicCheckoutPricing.js";
import { assertNoActiveCheckoutBlock, CUSTOMER_ORDER_BLOCKED_CODE, findActiveCheckoutBlock } from "./customerOrderBlockService.js";
import {
  getPersonalPromoAssignmentsForOrderIds,
} from "./customerPromoAssignmentService.js";
import {
  CUSTOMER_DATA_CHANGE_RECONFIRMATION_CODE,
  consumeCustomerDataChangeConfirmation,
  getChangedCustomerDataFields,
  persistConfirmedCustomerDataChange,
  resolveCheckoutCustomerDataChange,
  resolveAddressBoundOptionalFields,
  toCustomerDataSnapshot,
  type CheckoutCustomerDataChangeResolution,
} from "./customerDataChangeService.js";
import { normalizeCommunicationLanguage } from "./communicationLanguageService.js";
import { buildPackingWhatsAppMessage } from "./packingWhatsAppMessage.js";
import { getDhlLabelLifecycleForOrders } from "./dhlLabelLifecycleSummary.js";
import {
  clearOrderCommunicationPhoneOverride,
  getEffectiveCommunicationPhone,
  getEffectiveCommunicationPhonesForOrders,
  setOrderCommunicationPhoneOverride,
} from "./orderCommunicationPhoneService.js";

/**
 * Releases a pending KWK referral only after an order is known to be paid.
 * The ledger service is idempotent, so this deliberately runs on every later
 * paid-status transition as a recovery path for an interrupted earlier event.
 */
async function releaseKwkCreditForPaidOrder(orderId: string): Promise<void> {
  const { releaseCredit } = await import("./kwkService.js");
  await releaseCredit(orderId);
  console.log(`[KWK] Zahlungsgebundene Freigabe geprüft: ${orderId}`);
}

// Die WaWi-Liste benötigt nur die Information, ob ein Label vorliegt. Die großen
// Base64-/Legacy-Labeldaten bleiben ausschließlich für den gezielten, geschützten Abruf.
const {
  shippingLabelContent: _shippingLabelContent,
  shippingLabelUrl: _shippingLabelUrl,
  ...orderListColumns
} = getTableColumns(orders);
const orderListColumnsWithLabelPresence = {
  ...orderListColumns,
  hasShippingLabel: sql<boolean>`CASE WHEN ${orders.shippingLabelUrl} IS NOT NULL THEN TRUE ELSE FALSE END`.as("has_shipping_label"),
};

// Zod schemas
const discountBreakdownEntrySchema = z.object({
  source: z.enum([
    "promotion_code",
    "partner_self_discount",
    "partner_credit",
    "kwk_referral",
    "kwk_credit",
    "automatic_global_percent",
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
  // Der öffentliche Shop bleibt der Standard. Der WaWi-Herkunftsmarker wird
  // ausschließlich für eine bereits authentifizierte interne Sitzung akzeptiert.
  orderSource: z.enum(["shop", "wawi_manual"]).optional().default("shop"),
  // The checkout explicitly chooses the language for all automatic customer messages.
  communicationLanguage: z.enum(["de", "en"]).optional().default("de"),
  // Nur für manuelle WaWi-Aufträge: eine Kunden-Bestellbestätigung wird
  // ausschließlich nach sichtbarer, expliziter Freigabe versendet. Shop-Checkout
  // bleibt davon bewusst unberührt und weiterhin vollständig automatisch.
  sendOrderConfirmation: z.boolean().optional(),
  // Zusätzliche Shopquelle. Ohne Angabe bleibt die bestehende 369-Research-Logik unverändert.
  storeKey: z.enum(["369research", "peps4pets"]).optional().default("369research"),
  // Additive stable intent key; legacy callers may omit it. The canonical
  // WaWi-Nummer bleibt unabhängig davon weiterhin der interne Primärvertrag.
  checkoutIdempotencyKey: z.string().trim().min(12).max(128).optional(),
  items: z.array(z.object({
    name: z.string(),
    dosage: z.string().optional(),
    variant: z.string().optional(),
    price: z.number(),
    quantity: z.number().int().positive(),
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
  // Nur für authentifizierte WaWi-Aufträge: optionaler Kühlversand für
  // temperaturempfindliche Sendungen ohne Plug&Play- oder Nasenspray-Pflicht.
  coldShippingRequested: z.boolean().optional(),
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
  // Kurzlebiger, serverseitig gespeicherter Nachweis aus der Checkout-Vorschau.
  // Er ist nur bei einem eindeutigen Kontaktmatch mit abweichenden Daten nötig.
  customerDataChangeConfirmationToken: z.string().min(32).max(128).optional(),
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
      // Reject foreign public-code terms before lookup, pricing or any writes.
      assertNoMixedPartnerOrderInput(input);
      assertManualSaleRole(input.orderSource, ctx.user);
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const normalCheckoutKey = input.storeKey === '369research' && !ctx.jarvyOrder ? input.checkoutIdempotencyKey : undefined;
      if (normalCheckoutKey && !/^[a-f0-9]{64}$/.test(normalCheckoutKey)) throw Error('CHECKOUT_INTENT_KEY_INVALID');
      const normalFingerprint = normalCheckoutKey ? checkoutFingerprint(input) : undefined;
      if (normalCheckoutKey) {
        const receipt = await readCheckoutReceipt(db,normalCheckoutKey,normalFingerprint!);
        if (receipt) return receipt;
      }
      await checkCustomerCreationMaintenance('order.create','mutation',await getPool());
      const communicationLanguage = normalizeCommunicationLanguage(input.communicationLanguage);

      const isRequestedWawiManualSale = input.orderSource === "wawi_manual";
      const isAuthenticatedWawiManualSale = isRequestedWawiManualSale && Boolean(ctx.user);
      // The manual workflow records discounts in discountBreakdown; labels such
      // as "25%" or "Kostenloser Versand" must never enter promo-code lookup.
      input.discountCode = normalizeDiscountCodeForOrderSource(input.orderSource, input.discountCode);

      // Public checkout may only attach to a customer through one unique, real
      // contact identifier. No name or address is ever used as an identity key.
      // The resolution is repeated and locked inside the order transaction
      // before an existing customer profile can be updated.
      const checkoutCustomerDataChangeResolution: CheckoutCustomerDataChangeResolution | null = !isAuthenticatedWawiManualSale
        && input.orderSource === "shop"
        ? resolveCheckoutCustomerDataChange(
          await db.select().from(customers),
          {
            ...input.customer,
            dhlPostNumber: input.customer.dhlPostNumber || null,
          },
        )
        : null;

      const qrAttribution = await resolveQrAttribution(input.qrAttributionToken);

      const requestedKwkCredit = roundMoney(input.kwkCreditUsed || 0);
      const hasKwkRequest = Boolean(input.kwkCode?.trim())
        || requestedKwkCredit > 0
        || (input.kwkDiscount || 0) > 0;
      const configuredGlobalDiscount = await getActiveGlobalAutomaticDiscountFromDb();

      // A public Creator/Partner code is a server-authoritative commercial term.
      // Its customer discount is never accepted from the browser. Creator codes
      // are reusable by policy; exact terms are snapshotted with the new order.
      let resolvedPublicPartnerCode: ResolvedPartnerCode | null = null;
      let publicPartnerDiscountEligible = false;
      if (input.partnerCode?.trim() && !input.partnerNumber?.trim()) {
        resolvedPublicPartnerCode = await resolveActivePartnerCode(input.partnerCode);
        if (!resolvedPublicPartnerCode) throw new Error("PARTNER_CODE_UNGUELTIG");
        input.partnerCode = resolvedPublicPartnerCode.partnerCode;
        publicPartnerDiscountEligible = isDiscountAllowedForProgram(
          resolvedPublicPartnerCode.program,
          input.customer.email,
          resolvedPublicPartnerCode.partnerEmail,
        );
        const normalizedCustomerEmail = input.customer.email?.trim().toLowerCase() || "";
        if (resolvedPublicPartnerCode.program.customerDiscountPolicy === 'first_paid_code_use'
          || resolvedPublicPartnerCode.program.commissionPolicy === 'first_paid_code_order') {
          partnerPaidCodeContactKey(resolvedPublicPartnerCode.partnerCode, normalizedCustomerEmail);
        }
        if (publicPartnerDiscountEligible && normalizedCustomerEmail && !isRepeatCodeUseAllowed(resolvedPublicPartnerCode.program)) {
          const pool = await getPool();
          if (!pool) throw new Error("Database not available");
          publicPartnerDiscountEligible = !(await hasOtherPaidCodeOrder(
            (text, values) => pool.query(text, values), resolvedPublicPartnerCode.partnerCode, normalizedCustomerEmail,
          ));
        }
      }

      // A general promo code, including an individual Follow-up code, is also
      // resolved server-side. It stacks sequentially with an independently
      // supplied public Creator/Partner code: catalogue/sale price -> automatic
      // shop discount -> promo code -> public partner code. Shipping is never
      // discounted by the partner code. The browser cannot choose a rate.
      let resolvedPromoCode: PromoDefinition | null = null;
      let resolvedPromoCodeRecord: { id: number; code: string; minimumOrder: number } | null = null;
      const normalizedPromotionCode = input.discountCode?.trim().toUpperCase() || "";
      if (normalizedPromotionCode) {
        if (resolvedPublicPartnerCode && normalizedPromotionCode === resolvedPublicPartnerCode.partnerCode.replace(/\s+/g, "").toUpperCase()) {
          throw new Error("AKTIONSCODE_ENTSPRICHT_PARTNERCODE");
        }
        const [promo] = await db.select().from(promoCodes)
          .where(and(eq(promoCodes.code, normalizedPromotionCode), eq(promoCodes.isActive, 1)))
          .limit(1);
        if (!promo) throw new Error("AKTIONSCODE_UNGUELTIG");

        const now = new Date();
        if ((promo.validFrom && now < promo.validFrom)
          || isPromoCodeExpired(promo, now)
          || ((promo.maxUses || 0) > 0 && promo.currentUses >= (promo.maxUses || 0))) {
          throw new Error("AKTIONSCODE_UNGUELTIG");
        }
        resolvedPromoCode = {
          discountType: promo.discountType,
          percentage: Number(promo.percentage || 0),
          fixedAmount: Number(promo.fixedAmount || 0),
          description: promo.description,
        };
        resolvedPromoCodeRecord = {
          id: promo.id,
          code: promo.code,
          minimumOrder: Number(promo.minOrder || 0),
        };
        input.discountCode = promo.code;
      }

      // A partner number identifies an authenticated self-order. Its monetary
      // terms are resolved below from the session-owned partner row; a public
      // code or any browser-provided percentage can never authorize this route.
      const requiresPartnerSession = Boolean(input.partnerNumber?.trim()) || (input.creditUsed || 0) > 0;
      const authenticatedPartner = requiresPartnerSession
        ? ctx.operationsPreview?.partnerId
          ? (await db.select().from(partners).where(and(eq(partners.id,ctx.operationsPreview.partnerId),eq(partners.isActive,1))).limit(1))[0]??null
          : await getAuthenticatedPartnerFromRequest(ctx.req)
        : null;
      if (requiresPartnerSession && !authenticatedPartner) {
        throw new Error("PARTNER_GUTHABEN_AUTHENTIFIZIERUNG_ERFORDERLICH");
      }
      if (authenticatedPartner && input.partnerNumber && input.partnerNumber !== authenticatedPartner.partnerNumber) {
        throw new Error("PARTNER_GUTHABEN_PARTNER_MISMATCH");
      }

      let selfOrderDiscountPercent: number | null = null;
      let authenticatedSelfOrderProgram: PartnerProgram | null = null;
      let authenticatedSelfOrderTerms: ReturnType<typeof resolveSelfOrderTerms> | null = null;
      if (authenticatedPartner) {
        const normalizedPartnerEmail = (authenticatedPartner.email || "").trim().toLowerCase();
        const normalizedOrderEmail = (input.customer.email || "").trim().toLowerCase();
        if (normalizedPartnerEmail && normalizedOrderEmail !== normalizedPartnerEmail) {
          throw new Error("PARTNER_SELBSTBESTELLUNG_EMAIL_MISMATCH");
        }
        const normalizeAddressPart = (value: string | null | undefined) => String(value || "")
          .trim().toLocaleLowerCase("de-DE").replace(/\s+/g, " ");
        const partnerHasDeliveryAddress = Boolean(
          authenticatedPartner.street && authenticatedPartner.zip && authenticatedPartner.city,
        );
        if (partnerHasDeliveryAddress && (
          normalizeAddressPart(input.customer.street) !== normalizeAddressPart(authenticatedPartner.street)
          || normalizeAddressPart(input.customer.houseNumber) !== normalizeAddressPart(authenticatedPartner.houseNumber)
          || normalizeAddressPart(input.customer.zip) !== normalizeAddressPart(authenticatedPartner.zip)
          || normalizeAddressPart(input.customer.city) !== normalizeAddressPart(authenticatedPartner.city)
          || normalizeAddressPart(input.customer.country) !== normalizeAddressPart(authenticatedPartner.country)
        )) {
          throw new Error("PARTNER_SELBSTBESTELLUNG_ADRESS_MISMATCH");
        }
        authenticatedSelfOrderProgram = await getPartnerProgram(authenticatedPartner.id);
        if (!authenticatedSelfOrderProgram?.active) throw new Error("PARTNER_PROGRAMM_NICHT_VERFUEGBAR");
        authenticatedSelfOrderTerms = resolveSelfOrderTerms(
          authenticatedSelfOrderProgram,
          Number(authenticatedPartner.customerDiscountPercent || 0),
          Number(authenticatedPartner.commissionPercent || 0),
        );
        selfOrderDiscountPercent = authenticatedSelfOrderTerms.discountPercent;
      }

      // Shared real/preview preflight, before pricing can clamp a requested
      // amount and before order numbers, stock or customer writes. A balance
      // alone never authorizes redemption; final locked ledger checks remain.
      assertPartnerShopCreditAvailable(
        authenticatedSelfOrderProgram,
        input.creditUsed || 0,
        Number(authenticatedPartner?.creditBalance || 0),
      );

      // Im öffentlichen Shop werden Preise für KWK und den aktiven Dauerrabatt
      // zwingend aus dem aktuellen Katalog rekonstruiert. Eine WaWi-Anlage ist
      // dagegen ein bewusst manuell bepreister Geschäftsprozess: Preis und Menge
      // dieser Positionen dürfen dort niemals durch den Katalogpreis überschrieben
      // werden. Der Marker allein genügt aus Sicherheitsgründen nicht; er benötigt
      // zwingend eine gültige WaWi-Sitzung. So kann ein öffentlicher Request nie
      // manuelle Preise erzwingen und eine fehlende Sitzung nie still zu einer
      // Preisüberschreibung führen.
      if (authenticatedPartner && resolvedPromoCode) {
        throw new Error("PARTNER_AKTIONSCODE_AUSGESCHLOSSEN: Partnerbestellungen können nur den zentralen Shop-Dauerrabatt kombinieren.");
      }
      // The browser may show a free 3 ml BAC line for qualifying peptide vials,
      // but it must never create one for cosmetics or other non-vial products.
      // Rebuild that one generated gift from the catalogue before every public
      // checkout is priced, stocked or persisted. Manual WaWi lines remain a
      // separate, explicitly controlled workflow.
      if (!isAuthenticatedWawiManualSale) {
        const bacEligibilityCatalog = await db.select({
          sku: articles.sku,
          shopProductId: articles.shopProductId,
          category: articles.category,
          categories: articles.categories,
        }).from(articles);
        input.items = reconcileFreeBacWaterForShopOrder(input.items, bacEligibilityCatalog);
      }
      const coldShippingRequestedByWawi = isAuthenticatedWawiManualSale
        && input.coldShippingRequested === true;
      // Der Shop-Checkout versendet wie bisher automatisch. Im manuellen
      // WaWi-Workflow ist Versand an den Kunden eine bewusste Einzelfreigabe;
      // der Browserwert ist erst nach erfolgreicher WaWi-Authentifizierung
      // wirksam und kann deshalb nicht den öffentlichen Checkout beeinflussen.
      const shouldSendConfirmation = shouldSendOrderConfirmation({
        isAuthenticatedWawiManualSale,
        sendOrderConfirmation: input.sendOrderConfirmation,
      });
      // Every public checkout is rebuilt from the current catalog before any
      // commercial term is evaluated. The authenticated manual WaWi workflow is
      // intentionally excluded because its manually entered prices have a
      // separate, server-authorized business process.
      if (!isAuthenticatedWawiManualSale) {
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
        const repriced = repricePublicCheckoutItems(input.items, catalog);
        input.items = repriced.items;
        input.subtotal = repriced.subtotal;
      }
      // A standalone public code's minimum order is evaluated only after the
      // server owns every item price and the pre-discount merchandise subtotal.
      // KWK retains its dedicated validation and customer-facing error below.
      if (!isAuthenticatedWawiManualSale && resolvedPromoCodeRecord && !hasKwkRequest) {
        assertPromotionMinimumOrder(
          resolvedPromoCodeRecord.minimumOrder,
          input.subtotal,
        );
      }

      // Kombinationen werden erst entschieden, nachdem gültige Codes und deren
      // serverseitige Gegenstücke aufgelöst sind. Ein nicht stackbarer Code bleibt
      // gültig; ausschließlich beide globalen Vorteile entfallen.
      const globalBenefitResolution = resolveGlobalAutomaticDiscountBenefits(
        configuredGlobalDiscount,
        {
          merchandiseSubtotal: input.subtotal,
          shippingRegion: resolveShippingRegion(input.customer.country),
          hasPromotionCode: Boolean(resolvedPromoCode),
          hasPartnerCreatorCode: Boolean(resolvedPublicPartnerCode || authenticatedPartner),
          hasKwk: hasKwkRequest,
        },
      );
      const activeGlobalDiscount = configuredGlobalDiscount;
      const automaticGlobalDiscountAmount = globalBenefitResolution.globalDiscountApplies && activeGlobalDiscount
        ? calculateAutomaticGlobalDiscount(input.subtotal, activeGlobalDiscount.percentage)
        : 0;
      // Browserwerte für Versand sind niemals maßgeblich. Jeder öffentliche
      // Checkout startet mit der kanonischen Länder-/Positionsberechnung;
      // erst ein serverseitig freigegebener Promo- oder Dauervorteil darf sie
      // auf null setzen. Das verhindert kostenlose Versandwege durch eine
      // manipulierte Checkout-Payload.
      if (!isAuthenticatedWawiManualSale) {
        input.shipping = calculateAuthoritativeShipping({
          country: input.customer.country,
          items: input.items,
          promoDescription: resolvedPromoCode?.description,
        });
        input.shippingCountry = resolveShippingRegion(input.customer.country);
      } else if (resolvedPromoCode) {
        const [promo] = await db.select({ minOrder: promoCodes.minOrder })
          .from(promoCodes)
          .where(eq(promoCodes.id, resolvedPromoCodeRecord!.id))
          .limit(1);
        if (!promo) {
          throw new Error("AKTIONSCODE_UNGUELTIG");
        }
        assertPromotionMinimumOrder(Number(promo.minOrder || 0), input.subtotal);
        input.shipping = calculateAuthoritativeShipping({
          country: input.customer.country,
          items: input.items,
          promoDescription: resolvedPromoCode.description,
          coldChainRequested: coldShippingRequestedByWawi,
        });
        input.shippingCountry = resolveShippingRegion(input.customer.country);
      }
      if (globalBenefitResolution.globalFreeShippingApplies) {
        input.shipping = 0;
        input.shippingCountry = resolveShippingRegion(input.customer.country);
      }
      // The catalog-backed subtotal is available now. Every public shop term is
      // rebuilt here from its server-owned source; an old browser preview must
      // never change the payable amount. An authenticated partner's own discount
      // and separately entered shop credit are intentionally both retained.
      const authoritativePromoDiscount = resolvedPromoCode
        ? calculatePromoDiscount({
            subtotal: input.subtotal,
            items: input.items,
            promo: resolvedPromoCode,
            precedingProductDiscount: automaticGlobalDiscountAmount,
          })
        : 0;
      const authoritativePartnerDiscount = resolvedPublicPartnerCode
        ? calculatePublicPartnerCustomerDiscount({
            subtotal: input.subtotal,
            priorProductDiscount: automaticGlobalDiscountAmount + authoritativePromoDiscount,
            percentage: publicPartnerDiscountEligible ? resolvedPublicPartnerCode.customerDiscountPercent : 0,
            isAuthenticatedWawiManualSale,
          })
        : authenticatedPartner
          ? calculateProgramDiscount(
              input.subtotal,
              automaticGlobalDiscountAmount,
              selfOrderDiscountPercent || 0,
            )
          : 0;
      input.partnerDiscount = resolvedPublicPartnerCode || authenticatedPartner
        ? authoritativePartnerDiscount
        : 0;
      if (!isAuthenticatedWawiManualSale && !hasKwkRequest) {
        const authoritativeShopPricing = calculateAuthoritativeShopCheckoutPricing({
          subtotal: input.subtotal,
          shipping: input.shipping,
          automaticGlobalDiscount: automaticGlobalDiscountAmount,
          promotionDiscount: authoritativePromoDiscount,
          partnerDiscount: authoritativePartnerDiscount,
          partnerCreditUsed: authenticatedPartner ? roundMoney(input.creditUsed || 0) : 0,
        });
        input.creditUsed = authoritativeShopPricing.partnerCreditUsed;
        input.discount = authoritativeShopPricing.totalDiscount;
        input.total = authoritativeShopPricing.total;
      }
      const submittedAutomaticGlobalDiscount = roundMoney((input.discountBreakdown || [])
        .filter((entry) => entry.source === "automatic_global_percent")
        .reduce((sum, entry) => sum + entry.amount, 0));
      // Der automatische Dauerrabatt ist immer serverautoritativ. Eine alte
      // Browser- oder WaWi-Preisvorschau darf keinen Verkauf blockieren; der
      // mitgesendete Betrag wird ausschließlich dazu genutzt, die übrigen
      // bewusst gewährten Rabattanteile unverändert zu isolieren.

        // Kühlversand darf nur einmal pro Auftrag berechnet werden. Plug&Play
        // und fertig gemischte Nasensprays aktivieren ihn verpflichtend; ein
        // authentifizierter WaWi-Auftrag kann ihn für andere Sendungen bewusst
        // ergänzen. Ein bereits gewährter Gratisversand (0 €) bleibt erhalten.
        const hasColdShippingService = coldShippingRequestedByWawi
          || input.items.some(requiresColdChainShipping);
        if (hasColdShippingService) {
          (input as any)._coldShippingNote = coldShippingRequestedByWawi
            ? "Kühlversand aktiv (manuell gewählt oder Plug&Play)"
            : "Kühlversand aktiv (pflichtig durch Plug&Play/Nasenspray)";
        }
        const serverBaseShipping = calculateAuthoritativeShipping({
          country: input.customer.country,
          items: [],
        });
        const serverColdShipping = calculateAuthoritativeShipping({
          country: input.customer.country,
          items: input.items,
          coldChainRequested: coldShippingRequestedByWawi,
        });
        if (
          hasColdShippingService
          && input.shipping >= serverBaseShipping
          && Math.abs(input.shipping - serverColdShipping) > 0.02
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
      let kwkSessionVersion: number | null = null;
      if (hasKwkRequest) {
        const normalizedDiscountCode = input.discountCode?.trim().toUpperCase() || "";
        let discountCodeIsPartnerCode = false;
        if (normalizedDiscountCode) {
          discountCodeIsPartnerCode = Boolean(await resolveActivePartnerCode(normalizedDiscountCode));
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
          // Trusted synthetic preview returns before every real write below.
          const authenticatedKwk = ctx.operationsPreview?.kwkCreditAccountId
            ? { kwkId: ctx.operationsPreview.kwkCreditAccountId, sessionVersion: null }
            : input.kwkCreditToken ? await getAuthenticatedKwkFromToken(input.kwkCreditToken) : null;
          if (!authenticatedKwk) {
            throw new Error("KWK_GUTHABEN_AUTHENTIFIZIERUNG_ERFORDERLICH");
          }
          kwkCreditAccountId = authenticatedKwk.kwkId;
          kwkSessionVersion = authenticatedKwk.sessionVersion;
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
          if ((promo.validFrom && now < promo.validFrom)
            || (validUntil && now > validUntil)
            || ((promo.maxUses || 0) > 0 && promo.currentUses >= (promo.maxUses || 0))) {
            throw new Error("KWK_AKTIONSCODE_UNGUELTIG: Der allgemeine Aktionscode ist für diese Bestellung nicht gültig.");
          }
          assertPromotionMinimumOrder(
            Number(promo.minOrder || 0),
            input.subtotal,
            "KWK_AKTIONSCODE_UNGUELTIG: Der allgemeine Aktionscode ist für diese Bestellung nicht gültig.",
          );

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
          precedingProductDiscount: automaticGlobalDiscountAmount,
        });
        input.shipping = calculateAuthoritativeShipping({
          country: input.customer.country,
          items: input.items,
          promoDescription: promoDefinition?.description,
          coldChainRequested: coldShippingRequestedByWawi,
        });
        if (globalBenefitResolution.globalFreeShippingApplies) {
          input.shipping = 0;
        }
        input.shippingCountry = resolveShippingRegion(input.customer.country);
        const authoritative = calculateAuthoritativeKwkOrder({
          subtotal: input.subtotal,
          shipping: input.shipping,
          globalDiscount: automaticGlobalDiscountAmount,
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

      // Diese Korrektur gehört ausschließlich in den authentifizierten WaWi-
      // Verkaufsprozess. Shop-Checkouts wurden oben bereits vollständig aus
      // serverautoritativen Rabattquellen aufgebaut und dürfen hier nicht noch
      // einmal aus einer alten Browseraufschlüsselung überschrieben werden.
      if (isAuthenticatedWawiManualSale && !hasKwkRequest) {
        const authoritativeWawiPricing = calculateAuthoritativeWawiManualOrder({
          subtotal: input.subtotal,
          shipping: input.shipping,
          submittedDiscount: input.discount,
          submittedAutomaticGlobalDiscount,
          authoritativeAutomaticGlobalDiscount: automaticGlobalDiscountAmount,
        });
        input.discount = authoritativeWawiPricing.totalDiscount;
        input.total = authoritativeWawiPricing.total;
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
      // Die globale Aktion wird nie aus dem Browser übernommen. Ihre Zeile wird
      // aus der aktiven DB-Konfiguration neu aufgebaut und ist damit in jeder
      // Bestellung sauber von Aktionscodes, Partnern und Guthaben getrennt.
      const submittedDiscountBreakdown = (input.discountBreakdown || [])
        .filter((entry) => entry.amount > 0
          && shouldKeepClientDiscountBreakdownSource(entry.source, {
            hasResolvedPromotionCode: Boolean(resolvedPromoCode),
            hasResolvedPublicPartnerCode: Boolean(resolvedPublicPartnerCode),
            hasAuthenticatedPartnerSelfOrder: Boolean(authenticatedPartner),
          }))
        .map((entry) => ({
          ...entry,
          amount: roundMoney(entry.amount),
          percentage: entry.percentage === undefined ? undefined : roundMoney(entry.percentage),
        }));
      if (automaticGlobalDiscountAmount > 0 && activeGlobalDiscount) {
        submittedDiscountBreakdown.unshift({
          source: "automatic_global_percent" as const,
          label: activeGlobalDiscount.labelDe,
          amount: automaticGlobalDiscountAmount,
          percentage: activeGlobalDiscount.percentage,
        });
      }
      if (resolvedPromoCode) {
        const authoritativePromoDiscount = calculatePromoDiscount({
          subtotal: input.subtotal,
          items: input.items,
          promo: resolvedPromoCode,
          precedingProductDiscount: automaticGlobalDiscountAmount,
        });
        if (authoritativePromoDiscount > 0) {
          submittedDiscountBreakdown.push({
            source: "promotion_code" as const,
            label: `Aktionscode: ${resolvedPromoCodeRecord?.code || normalizedPromotionCode}`,
            amount: authoritativePromoDiscount,
            percentage: resolvedPromoCode.discountType === "percent" ? resolvedPromoCode.percentage : undefined,
            code: resolvedPromoCodeRecord?.code || normalizedPromotionCode,
          });
        }
      }
      const authoritativePartnerDiscountForBreakdown = roundMoney(input.partnerDiscount || 0);
      if ((resolvedPublicPartnerCode || authenticatedPartner) && authoritativePartnerDiscountForBreakdown > 0) {
        const isCreatorSelfOrder = Boolean(authenticatedPartner && authenticatedSelfOrderProgram?.key === "creator");
        const partnerDiscountPercent = selfOrderDiscountPercent
          ?? resolvedPublicPartnerCode?.customerDiscountPercent
          ?? 0;
        submittedDiscountBreakdown.push({
          source: "partner_self_discount" as const,
          label: authenticatedPartner
            ? (isCreatorSelfOrder
                ? `Creator-Eigenbestellung (${partnerDiscountPercent}%)`
                : `Partnereigenbestellung (${partnerDiscountPercent}%)`)
            : (resolvedPublicPartnerCode?.program.key === "creator"
                ? `Creator-Code ${resolvedPublicPartnerCode.partnerCode} (${partnerDiscountPercent}%)`
                : `Partner-Code ${resolvedPublicPartnerCode?.partnerCode} (${partnerDiscountPercent}%)`),
          amount: authoritativePartnerDiscountForBreakdown,
          percentage: partnerDiscountPercent,
          ...(resolvedPublicPartnerCode ? { code: resolvedPublicPartnerCode.partnerCode } : {}),
        });
      }
      const authoritativePartnerCredit = roundMoney(authenticatedPartner ? input.creditUsed || 0 : 0);
      if (authenticatedPartner && authoritativePartnerCredit > 0) {
        submittedDiscountBreakdown.push({
          source: "partner_credit" as const,
          label: "Partnerguthaben eingelöst",
          amount: authoritativePartnerCredit,
          percentage: undefined,
        });
      }
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
      if(ctx.operationsPreview){
        if(await findActiveCheckoutBlock(input.customer))throw Error(CUSTOMER_ORDER_BLOCKED_CODE);
        if(kwkReferralAccount)await assertKwkNewCustomer(db,input.customer);
        if((input.kwkCreditUsed||0)>0&&kwkCreditAccountId)await assertKwkCreditAvailable(db,kwkCreditAccountId,input.kwkCreditUsed||0);
        let partnerCustomerCheck;
        if (resolvedPublicPartnerCode) {
          const pool = await getPool();
          if (!pool) throw new Error("Database not available");
          const previousPaid = resolvedPublicPartnerCode.program.commissionPolicy === 'first_paid_code_order' && input.customer.email
            ? await hasOtherPaidCodeOrder((text, values) => pool.query(text, values), resolvedPublicPartnerCode.partnerCode, input.customer.email) : false;
          partnerCustomerCheck = {
            ...publicCodeCommissionPreview(resolvedPublicPartnerCode, {
              subtotal: input.subtotal, discount: input.discount,
              creditUsed: (input.creditUsed || 0) + (input.kwkCreditUsed || 0), email: input.customer.email || null,
            }, previousPaid),
            customerDiscountEligible: publicPartnerDiscountEligible,
            appliedCustomerDiscount: authoritativePartnerDiscount,
          };
        }
        return {operationsPreview:{partnerCustomerCheck,subtotal:input.subtotal,shipping:input.shipping,discount:input.discount,total:input.total,discountBreakdown,items:input.items.map(i=>({shopProductId:i.shopProductId,name:i.name,dosage:i.dosage,quantity:i.quantity,price:i.price})),addressChecked:true,addressValidation:await validateGermanAddress(input.customer)}};
      }
      const addressValidation = await validateGermanAddress(input.customer);
      const addressWarningNeedsConfirmation = addressValidation.applicable
        && (addressValidation.status === "warning" || addressValidation.status === "unavailable");
      if (addressWarningNeedsConfirmation && input.addressValidationOverride?.confirmed !== true) {
        throw new Error(`ADRESSPRUEFUNG_BESTAETIGUNG_ERFORDERLICH: ${addressValidation.warnings.map((warning) => warning.message).join(" ")}`);
      }

      // ── Hilfsfunktion: Checkout-Fehler als Backup speichern + E-Mail an Admin ──
      const saveFailedOrder = async (errorMsg: string, attemptedOrderId?: string) => {
        if(ctx.jarvyOrder)return;
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

      // Fast failure before any order number, stock movement or payment process.
      // The transaction below repeats this check under the same advisory locks so
      // an operator activating a block cannot race an in-flight checkout.
      if (await findActiveCheckoutBlock(input.customer)) {
        throw new Error(CUSTOMER_ORDER_BLOCKED_CODE);
      }

      // The dedicated Jarvy endpoint uses this same validation/pricing path.
      // Preview stops before sequence allocation, stock/order writes and messages.
      if (ctx.jarvyOrder) {
        if (!isAuthenticatedWawiManualSale || !ctx.user || input.stockOverride || input.partnerCode || input.partnerNumber || input.kwkCode || input.qrAttributionToken || input.storeKey !== '369research') throw new Error('JARVY_ORDER_SCOPE');
        const preview={input,discountBreakdown};
        if(ctx.jarvyOrder.mode==='preview') return {jarvyPreview:preview,hash:orderHash(preview)};
        if(ctx.jarvyOrder.expectedHash!==orderHash(preview))throw new Error('JARVY_ORDER_CHANGED');
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

      // ── Partner logic: validate attribution and financial authorization ──
      let partnerCode = input.partnerCode || null;
      let partnerNumber = input.partnerNumber || null;
      let partnerDiscountAmount = roundMoney(input.partnerDiscount || 0);
      let partnerCommissionAmount = 0;
      let creditUsed = input.creditUsed || 0;
      let partnerSourceId: number | null = resolvedPublicPartnerCode?.partnerId || null;
      let partnerCodeIdSnapshot: number | null = resolvedPublicPartnerCode?.codeId || null;
      let partnerProgram: PartnerProgram | null = resolvedPublicPartnerCode?.program || null;
      let partnerCommissionPercentSnapshot: number | null = resolvedPublicPartnerCode?.commissionPercent || null;
      let partnerCommissionBaseSnapshot: number | null = null;

      if (authenticatedPartner) {
        if (partnerNumber && partnerNumber !== authenticatedPartner.partnerNumber) {
          throw new Error("PARTNER_GUTHABEN_PARTNER_MISMATCH");
        }
        partnerNumber = authenticatedPartner.partnerNumber;
        // A self-order is attributed through the authenticated partner number,
        // never by copying the legacy CSV code mirror onto the order.
        partnerCode = null;
      }

      // Partner wird beim Checkout ausschließlich zugeordnet. Eine Gutschrift entsteht
      // erst nach bestätigtem Zahlungseingang im zentralen Partnerguthaben-Service.
      const resolvePartnerForOrder = async (partner: { id: number; code?: string | null }, reason: string) => {
        if (!partnerCode && partner.code) partnerCode = partner.code;
        partnerSourceId = partner.id;
        console.log(`[Orders] Partner zugeordnet: ${partner.code || authenticatedPartner?.partnerNumber || partner.id} (${reason}); Guthaben wird erst nach Zahlung gebucht.`);
      };

      // Case 1: Partner CODE was provided (customer or partner entered the code)
      if (partnerCode && resolvedPublicPartnerCode) {
        partnerCode = resolvedPublicPartnerCode.partnerCode;
        partnerSourceId = resolvedPublicPartnerCode.partnerId;
        partnerCodeIdSnapshot = resolvedPublicPartnerCode.codeId;
        partnerProgram = resolvedPublicPartnerCode.program;
        partnerCommissionPercentSnapshot = resolvedPublicPartnerCode.commissionPercent;
        await resolvePartnerForOrder({ id: resolvedPublicPartnerCode.partnerId, code: resolvedPublicPartnerCode.partnerCode }, "Code");
      }

      // Case 2: authenticated partner self-order. The session-owned partner is
      // the only authority for both direct discount and commission snapshots.
      if (partnerNumber && authenticatedPartner) {
        await resolvePartnerForOrder({ id: authenticatedPartner.id, code: null }, "Eigenbestellung");
        partnerProgram = authenticatedSelfOrderProgram;
        // Actual payout Creator conversion earns zero; explicit shop-credit
        // programs retain their separate commission, even with a Creator key.
        partnerCommissionPercentSnapshot = authenticatedSelfOrderTerms?.commissionPercent ?? 0;
      }

      if (partnerProgram) {
        // Both Partner- and KWK-credit are payment methods, not discounts. The
        // commission base therefore restores them after the client total has
        // combined all discount and payment reductions into `input.discount`.
        partnerCommissionBaseSnapshot = roundMoney(Math.max(
          0,
          input.subtotal - input.discount + creditUsed + (input.kwkCreditUsed || 0),
        ));
        partnerCommissionAmount = roundMoney(partnerCommissionBaseSnapshot * (partnerCommissionPercentSnapshot || 0) / 100);
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
        if (normalCheckoutKey) throw Error('ORDER_REFERENCE_CONFLICT');
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
      const transactionResponse = await db.transaction(async (tx) => {
      const db = tx;
      if (normalCheckoutKey) {
        await lockCheckoutIntent(tx,normalCheckoutKey);
        const receipt = await readCheckoutReceipt(tx,normalCheckoutKey,normalFingerprint!);
        if (receipt) return receipt;
      }
      if(ctx.jarvyOrder?.mode==='execute') {
        const actor=await db.execute(sql`SELECT id FROM users WHERE id=${ctx.user!.id} AND role='admin' FOR SHARE`);
        if(!actor.rows.length)throw new Error('JARVY_ACTOR_REVOKED');
        const receipt=await db.execute(sql`UPDATE jarvy_order_receipts SET order_id=${orderId},state='succeeded' WHERE id=${ctx.jarvyOrder.receiptId} AND state='executing' AND payload_hash=${ctx.jarvyOrder.expectedHash} AND order_id IS NULL RETURNING id`);
        if(!(receipt as any).rows?.length && !(Array.isArray(receipt)&&receipt.length))throw new Error('JARVY_ORDER_ALREADY_CLAIMED');
        await db.execute(sql`SELECT id FROM customers WHERE id=${input.existingCustomerId!} FOR UPDATE`);
        const fresh=await db.select().from(customers).where(eq(customers.id,input.existingCustomerId!)).limit(1);
        const c=fresh[0];
        if(!c||['firstName','lastName','email','phone','street','houseNumber','zip','city','country','company'].some(k=>String((c as any)[k]??'')!==String((input.customer as any)[k]??'')))throw new Error('JARVY_CUSTOMER_CHANGED');
      }

      let transactionCustomerDataChangeResolution = checkoutCustomerDataChangeResolution;

      // Contact-based only: neither name nor address can ever trigger this.
      // The error is intentionally neutral and mapped to customer-facing copy
      // in the shop; no reason or internal record is disclosed.
      await assertNoActiveCheckoutBlock(db, input.customer);

      // Repeat the public-checkout match while holding the affected customer
      // row. A token cannot be replayed for a changed record or used to update
      // a different customer after a concurrent profile edit.
      if (transactionCustomerDataChangeResolution?.kind === "matched") {
        await db.execute(sql`LOCK TABLE customers IN SHARE MODE`);
        await db.execute(sql`
          SELECT id FROM customers
          WHERE id = ${transactionCustomerDataChangeResolution.customer.id}
          FOR UPDATE
        `);
        const [currentCustomer] = await db.select().from(customers)
          .where(eq(customers.id, transactionCustomerDataChangeResolution.customer.id))
          .limit(1);
        const freshResolution = currentCustomer
          ? resolveCheckoutCustomerDataChange(await db.select().from(customers), {
            ...input.customer,
            dhlPostNumber: input.customer.dhlPostNumber || null,
          })
          : null;
        if (freshResolution?.kind !== "matched" || freshResolution.customer.id !== transactionCustomerDataChangeResolution.customer.id) {
          throw new Error(CUSTOMER_DATA_CHANGE_RECONFIRMATION_CODE);
        }
        transactionCustomerDataChangeResolution = freshResolution;
        await consumeCustomerDataChangeConfirmation(
          db,
          input.customerDataChangeConfirmationToken,
          freshResolution,
        );
      }

      // Das KWK-Guthaben wird innerhalb derselben Transaktion wie die Bestellung
      // geprüft und reserviert. So kann kein rabattierter Auftrag ohne Gegenbuchung
      // entstehen und die vom Browser gesendete Account-ID wird nicht vertraut.
      if (authoritativeKwkCredit > 0 && kwkCreditAccountId) {
        await assertKwkCreditAvailable(db,kwkCreditAccountId,authoritativeKwkCredit,true);
        // Re-run the exact shared auth query AFTER the owner lock: reset/logout
        // may have revoked the session since preflight. Never trust client IDs.
        const lockedAuth = input.kwkCreditToken
          ? await getAuthenticatedKwkFromToken(input.kwkCreditToken, createPartnerCreditTransactionQueryClient(query => tx.execute(query)))
          : null;
        if (!lockedAuth || lockedAuth.kwkId !== kwkCreditAccountId || lockedAuth.sessionVersion !== kwkSessionVersion) {
          throw new Error("KWK_GUTHABEN_SESSION_WIDERRUFEN");
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

        await assertKwkNewCustomer(db,input.customer);
      }

            // ── Stock check: verify all peptide items are in stock before creating order ──
      if(ctx.jarvyOrder)await db.select({id:articles.id}).from(articles).where(inArray(articles.sku,input.items.map(i=>i.shopProductId!))).orderBy(articles.id).for('update');
      const allArticlesForCheck = await db.select().from(articles).where(eq(articles.isActive, 1));
      if (!isAuthenticatedWawiManualSale) {
        for (const item of input.items) {
          const family = allArticlesForCheck.filter(a => a.sku.toLowerCase() === item.shopProductId?.toLowerCase() || a.shopProductId?.toLowerCase() === item.shopProductId?.toLowerCase());
          const categories = family.flatMap(a => [a.category || '',...(Array.isArray(a.categories) ? a.categories : [])]);
          // Existing vial families are stock-led, regardless of the client type.
          if (categories.some(c => /^(peptide|peptide.*|vials)$/i.test(c.trim()))) item.type = 'peptide';
        }
      }
      const outOfStockItems: string[] = [];
      const ambiguousVariantItems: string[] = [];

      // Smart Substitution: prüfen ob Feature aktiv ist
      const substitutionActive = !ctx.jarvyOrder && await isSubstitutionEnabled();

      // Helper: find articles matching a shop item by direct variant SKU or canonical
      // shop product ID plus dosage. Bundle items carry the selected variant SKU; it must
      // take precedence so stock and display metadata remain exact.
      const getArticleDosage = (article: typeof allArticlesForCheck[number]): string => {
        const parenMatch = article.name.match(/\(([^)]+)\)\s*$/);
        const noParenMatch = article.name.match(/\b(\d+(?:\.\d+)?\s*(?:mg|IU|ml|mcg|iu))\s*$/i);
        const nameDosage = parenMatch ? parenMatch[1].trim().toLowerCase() : noParenMatch ? noParenMatch[1].trim().toLowerCase() : '';
        const skuDosage = extractDosageMg(article.sku);
        return nameDosage || (skuDosage !== null ? `${skuDosage} mg` : '');
      };
      const dosageMatches = (article: typeof allArticlesForCheck[number], dosageNorm: string): boolean =>
        !dosageNorm || getArticleDosage(article) === dosageNorm;
      const findMatchingArticles = (item: { name: string; dosage?: string; shopProductId?: string }, allArts: typeof allArticlesForCheck) => {
        if(ctx.jarvyOrder) {
          const exact=allArts.filter(a=>a.sku===item.shopProductId);
          if(exact.length!==1||exact[0].name!==item.name)throw new Error('JARVY_ARTICLE_CHANGED');
          return exact;
        }
        const dosageNorm = (item.dosage || '').toLowerCase().trim();
        const itemShopId = (item.shopProductId || '').toLowerCase().trim();

        if (itemShopId) {
          // A selected bundle variant is submitted as its inventory SKU (for example
          // RETATRUTIDE-5MG), while all 3G records share the canonical shopProductId.
          // Resolve that exact SKU first; never broaden a missing dosage to every variant.
          const directVariantMatches = allArts.filter(article =>
            article.sku.toLowerCase() === itemShopId && dosageMatches(article, dosageNorm)
          );
          if (directVariantMatches.length > 0) return directVariantMatches;

          return allArts.filter(article =>
            Boolean(article.shopProductId) &&
            article.shopProductId!.toLowerCase() === itemShopId &&
            dosageMatches(article, dosageNorm)
          );
        }

        // Fallback: Name + Dosage match (manuelle WaWi-Bestellungen ohne shopProductId)
        const itemNameNorm = item.name.replace(/\s*\[.*?\]\s*/g, '').trim().toLowerCase();
        return allArts.filter(article => {
          const articleNameBase = article.name.replace(/\s*\(.*?\)\s*$/, '').trim().toLowerCase();
          return (articleNameBase.includes(itemNameNorm) || itemNameNorm.includes(articleNameBase)) &&
            dosageMatches(article, dosageNorm);
        });
      };

      // Map: item-Index → SubstitutionResult (für späteren Bestandsabzug)
      const substitutionMap = new Map<number, import('./substitutionService.js').SubstitutionResult>();

      for (let itemIdx = 0; itemIdx < input.items.length; itemIdx++) {
        const item = input.items[itemIdx];
        if (item.type !== 'peptide') continue;
        const matchingArticles = findMatchingArticles(item, allArticlesForCheck);
        // Ein leerer Stärkenwert ist bei einer Variantenfamilie fachlich nicht
        // bestimmbar. Die Bestellung wird abgebrochen, statt Bestand über alle
        // Varianten zu aggregieren und eine unbrauchbare WaWi-Position zu speichern.
        if (!item.dosage?.trim() && matchingArticles.length > 1) {
          ambiguousVariantItems.push(item.name);
          continue;
        }
        if (matchingArticles.length > 0) {
          const totalStock = matchingArticles.reduce((sum, a) => sum + (a.stock ?? 0), 0);
          if (totalStock < item.quantity) {
            // Variante nicht auf Lager – Smart Substitution versuchen?
            // Smart Sub greift auch ohne shopProductId (manuelle Bestellungen).
            // Alte Bundle-Warenkörbe können noch die konkrete Varianten-SKU in
            // shopProductId führen; für die Substitution wird daraus gezielt
            // die kanonische Produktfamilie gewonnen.
            const effectiveShopProductId = resolveSubstitutionProductFamily(item.shopProductId, matchingArticles);
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
      if (ambiguousVariantItems.length > 0) {
        throw new Error(`Bitte wähle für folgende Variantenprodukte eine Stärke: ${ambiguousVariantItems.join(', ')}`);
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

      // DIY-Nasenspray-Set darf nur für die zentral freigegebenen Produkte bestellt werden.
      // Der Checkout kann die Bestands- oder Produktfreigabe nicht über Namen manipulieren.
      const diyNasalItems = input.items.filter((item) => item.isNasalDiySet === true);
      for (const item of diyNasalItems) {
        if (!isNasalDiySetEligible(item.shopProductId)) {
          throw new Error(`DIY-Nasenspray-Set ist für ${item.name} nicht verfügbar`);
        }
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

      // Lock only the actual inventory plan, consistently by article id, including
      // substitution and already catalogued BAC/DIY components. No whole-shop lock.
      const plannedIds=new Set<number>();
      input.items.forEach((item,index) => {
        if (item.type === 'peptide') {
          const sub=substitutionMap.get(index);
          if(sub?.possible)sub.components.forEach(c => plannedIds.add(c.articleId));
          else findMatchingArticles(item,allArticlesForCheck).forEach(a => plannedIds.add(a.id));
        }
        if(item.isNasalSpray || item.isNasalDiySet) {
          allArticlesForCheck.filter(a => a.shopProductId === 'bac-wasser' || NASAL_DIY_SET_COMPONENTS.some(c => c.inventoryTracked && a.shopProductId === c.articleShopProductId)).forEach(a => plannedIds.add(a.id));
        }
      });
      const lockedInventory=plannedIds.size ? await db.select().from(articles).where(inArray(articles.id,[...plannedIds].sort((a,b)=>a-b))).orderBy(articles.id).for('update') : [];
      lockedInventory.forEach(fresh => {const a=allArticlesForCheck.find(a=>a.id===fresh.id);if(a)a.stock=fresh.stock;});
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
            if (!article) throw Error('ORDER_STOCK_COMPONENT_MISSING');
            const newStock = (article.stock ?? 0) - comp.quantity;
            await applyStockMovement(db,{articleId:article.id,sku:article.sku,expectedStock:article.stock??0,change:-comp.quantity,type:'verkauf',reason:`Smart Substitution für Bestellung ${orderId}: ${sub.internalNote}`,orderId,actor:'system'});

            article.stock=newStock;
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
              await applyStockMovement(db,{articleId:article.id,sku:article.sku,expectedStock:article.stock??0,change:-deduct,type:'verkauf',reason:`Bestandsabzug für Bestellung ${orderId}`,orderId,actor:'system',...(ctx.jarvyOrder?{expectedPrice:item.price}:{})});
              article.stock=newStock;
              remainingToDeduct -= deduct;
              console.log(`[Orders] Stock deducted: ${article.name} ${newStock+deduct} → ${newStock} (order ${orderId})`);
            }
          }
          if (remainingToDeduct > 0 && !stockOverrideAuthorized) throw Error('ORDER_STOCK_DEMAND_NOT_COVERED');
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
        communicationLanguage,
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
        partnerSourceId,
        partnerCodeIdSnapshot,
        partnerNumber: partnerNumber || null,
        partnerDiscount: partnerDiscountAmount.toFixed(2),
        partnerCommission: partnerCommissionAmount.toFixed(2),
        partnerProgramSnapshot: partnerProgram?.key || null,
        partnerSettlementMethodSnapshot: partnerProgram?.settlementMethod || null,
        partnerCommissionPolicySnapshot: partnerProgram?.commissionPolicy || null,
        partnerCustomerDiscountPolicySnapshot: partnerProgram?.customerDiscountPolicy || null,
        partnerCommissionPercentSnapshot: partnerCommissionPercentSnapshot?.toFixed(2) || null,
        partnerCustomerDiscountPercentSnapshot: (selfOrderDiscountPercent ?? resolvedPublicPartnerCode?.customerDiscountPercent)?.toFixed(2) || null,
        partnerCommissionBaseSnapshot: partnerCommissionBaseSnapshot?.toFixed(2) || null,
        creditUsed: creditUsed.toFixed(2),
        kwkCreditUsed: (input.kwkCreditUsed || 0).toFixed(2),
        kwkCreditRequested: (input.kwkCreditUsed || 0).toFixed(2),
        kwkCreditOwnerId: authoritativeKwkCredit > 0 ? kwkCreditAccountId : null,
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
          (input as any)._coldShippingNote,
        ]),
      });

      // Consume the code in the same transaction as the order. The guarded
      // update makes a single-use Follow-up code race-safe and prevents the
      // previous browser-side post-order increment from double counting.
      if (resolvedPromoCodeRecord) {
        const consumed = await db.update(promoCodes)
          .set({
            currentUses: sql`${promoCodes.currentUses} + 1`,
            updatedAt: new Date(),
          })
          .where(and(
            eq(promoCodes.id, resolvedPromoCodeRecord.id),
            eq(promoCodes.isActive, 1),
            or(
              eq(promoCodes.maxUses, 0),
              sql`${promoCodes.currentUses} < ${promoCodes.maxUses}`,
            ),
          ))
          .returning({ id: promoCodes.id });
        if (consumed.length !== 1) {
          throw new Error("AKTIONSCODE_UNGUELTIG");
        }
      }

      if (authoritativeKwkCredit > 0 && kwkCreditAccountId) {
        await redeemCreditInTransaction(
          kwkCreditAccountId, orderId, authoritativeKwkCredit,
          createPartnerCreditTransactionQueryClient(query => tx.execute(query)),
        );
      }

      // Insert order items. If a client omitted the selected dosage, recover it first
      // from the submitted variant SKU, then (only as a legacy fallback) from canonical
      // product variants and an exact price. Bundle discounts make price-only recovery
      // ambiguous, whereas an inventory SKU remains deterministic.
      const resolveDisplayDosage = async (item: typeof input.items[number]): Promise<string | null> => {
        const supplied = item.dosage?.trim();
        if (supplied) return supplied;
        if (item.type !== 'peptide' || !item.shopProductId) return null;

        const [selectedArticle] = await db.select().from(articles)
          .where(and(eq(articles.isActive, 1), eq(articles.sku, item.shopProductId)))
          .limit(1);
        const selectedSkuDosage = selectedArticle ? extractDosageMg(selectedArticle.sku) : null;
        if (selectedSkuDosage !== null) return `${selectedSkuDosage} mg`;

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
      ).reduce((sum,i) => sum+i.quantity,0);
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
        // Full stock demand or rollback; never silently commit partial component demand.
        if ((!bacWasser10ml || (bacWasser10ml.stock ?? 0) < nasalSprayCount) && !stockOverrideAuthorized) throw Error('ORDER_STOCK_DEMAND_NOT_COVERED');
        if (bacWasser10ml && (bacWasser10ml.stock ?? 0) > 0) {
          const deduct = Math.min(nasalSprayCount, bacWasser10ml.stock ?? 0);
          const newStock = (bacWasser10ml.stock ?? 0) - deduct;
            await applyStockMovement(db,{articleId:bacWasser10ml.id,sku:bacWasser10ml.sku,expectedStock:bacWasser10ml.stock??0,change:-deduct,type:'verkauf',reason:`Automatischer Abzug: Nasenspray-Bestellung ${orderId}`,orderId,actor:'system'});

          console.log(`[Orders] BAC Wasser 10ml Bestand abgezogen: ${bacWasser10ml.stock} → ${newStock} (${nasalSprayCount}x Nasenspray, order ${orderId})`);
        } else {
          console.warn(`[Orders] BAC Wasser 10ml nicht gefunden oder kein Bestand für Nasenspray-Bestellung ${orderId}`);
        }
      }

      // ── DIY-Nasenspray-Set: enthaltene Komponenten als transparente Bestellpositionen ──
      // BAC Wasser 10 ml ist bestandsgeführt; die weiteren Komponenten sind sichtbar,
      // bis sie als eigene WaWi-Artikel mit SKU und Bestand angelegt werden.
      for (const item of diyNasalItems) {
        for (const component of NASAL_DIY_SET_COMPONENTS) {
          let componentArticle: typeof articles.$inferSelect | undefined;
          if (component.inventoryTracked) {
            [componentArticle] = await db.select().from(articles)
              .where(eq(articles.shopProductId, component.articleShopProductId))
              .limit(1);
          }
          await db.insert(orderItems).values({
            orderId,
            name: component.name,
            dosage: null,
            variant: component.variant,
            type: "accessory",
            price: "0.00",
            quantity: item.quantity,
            articleId: componentArticle?.id ?? null,
            isNasalDiySet: true,
          });

          if (component.inventoryTracked && (!componentArticle || (componentArticle.stock ?? 0) < item.quantity) && !stockOverrideAuthorized) throw Error('ORDER_STOCK_DEMAND_NOT_COVERED');
          if (componentArticle && (componentArticle.stock ?? 0) > 0) {
            const deduct = Math.min(item.quantity, componentArticle.stock ?? 0);
            const newStock = (componentArticle.stock ?? 0) - deduct;
            await applyStockMovement(db,{articleId:componentArticle.id,sku:componentArticle.sku,expectedStock:componentArticle.stock??0,change:-deduct,type:'verkauf',reason:`DIY-Nasenspray-Set für Bestellung ${orderId}`,orderId,actor:'system'});

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
             ${serializeKwkFraudFlags(fraudFlags)}, 'pending')
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
      // Shop orders use the preflighted public resolution only. This forbids
      // a name/address match, conflicts and ambiguous contacts from silently
      // changing or attaching an unrelated existing customer.
      const customerEmail = (input.customer.email || "").toLowerCase().trim();
      const customerPhone = input.customer.phone.trim();
      const fullName = `${input.customer.firstName} ${input.customer.lastName}`.trim();
      let existingCustomer: any = null;

      if (isAuthenticatedWawiManualSale && input.existingCustomerId) {
        const [found] = await db.select().from(customers).where(eq(customers.id, input.existingCustomerId));
        if (!found) throw new Error("Kunde nicht gefunden");
        if (found) {
          existingCustomer = found;
          console.log(`[Customers] Using manually matched customer ID=${input.existingCustomerId} (${found.name})`);
        }
      } else if (transactionCustomerDataChangeResolution?.kind === "matched") {
        existingCustomer = transactionCustomerDataChangeResolution.customer;
      }

      if (!existingCustomer && isAuthenticatedWawiManualSale) {
        // Manual WaWi orders retain their established unique-contact fallback.
        // It uses the same strict resolver, but never turns a name or address
        // into a customer identity.
        const manualResolution = resolveCheckoutCustomerDataChange(
          await db.select().from(customers),
          { ...input.customer, dhlPostNumber: input.customer.dhlPostNumber || null },
        );
        if (manualResolution.kind === "matched") existingCustomer = manualResolution.customer;
      }

      if (existingCustomer) {
        customerId = existingCustomer.id;
        const confirmedPublicChange = transactionCustomerDataChangeResolution?.kind === "matched"
          && transactionCustomerDataChangeResolution.customer.id === existingCustomer.id
          && transactionCustomerDataChangeResolution.requiresConfirmation
          ? transactionCustomerDataChangeResolution
          : null;
        if (confirmedPublicChange) {
          // A guest confirmation proves only consent to this order snapshot.
          // Knowledge of an email/phone is never profile-write authorization.
          await persistConfirmedCustomerDataChange(db, {
            customerId: existingCustomer.id,
            orderId,
            matchedBy: confirmedPublicChange.matchedBy,
            previousSnapshot: confirmedPublicChange.previousSnapshot,
            submittedSnapshot: confirmedPublicChange.submittedSnapshot,
            changedFields: confirmedPublicChange.changedFields,
          });
          console.log(`[CustomerDataChange] Confirmed order snapshot recorded in order ${orderId}; profile unchanged`);
        } else if (isAuthenticatedWawiManualSale && !ctx.jarvyOrder) {
          // The established authenticated WaWi workflow remains unchanged. The
          // public shop path above is deliberately the only changed behavior.
          const addressBoundOptionalFields = resolveAddressBoundOptionalFields(existingCustomer, input.customer);
          const manuallyChanged = getChangedCustomerDataFields(
            toCustomerDataSnapshot(existingCustomer),
            toCustomerDataSnapshot({ ...input.customer, ...addressBoundOptionalFields }),
          ).length > 0;
          await db.update(customers).set({
            name: fullName,
            firstName: input.customer.firstName,
            lastName: input.customer.lastName,
            phone: customerPhone || existingCustomer.phone,
            email: customerEmail || existingCustomer.email,
            company: input.customer.deliveryType === "packstation" || input.customer.deliveryType === "postfiliale"
              ? null : (addressBoundOptionalFields.company || null),
            street: input.customer.street,
            houseNumber: input.customer.houseNumber,
            zip: (input.customer.zip ?? "").trim(),
            city: input.customer.city,
            country: input.customer.country,
            dhlPostNumber: addressBoundOptionalFields.dhlPostNumber || null,
            communicationLanguage,
            updatedAt: new Date(),
          }).where(eq(customers.id, existingCustomer.id));
          customerIntegrityTrigger = manuallyChanged ? "order_customer_changed" : null;
        } else {
          // Guest language/address preferences belong to the new order only.
          // Even a no-change checkout cannot alter an existing profile.
        }
        console.log(`[Customers] Linked order ${orderId} to existing customer #${existingCustomer.customerNumber} (${fullName})`);
      } else {
          // Generate next customer number (starting at 1210)
          const nextNum = await nextCustomerNumber(db);

          // Determine acquisition source
          const acquiredBy = partnerSourceId ? "partner" as const : "shop" as const;
          // Attribution was already resolved server-side from the exact public
          // code or authenticated partner number. Never re-resolve against the
          // legacy comma-separated mirror here.
          const acquiredByPartnerId = partnerSourceId;

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
            dhlPostNumber: input.customer.dhlPostNumber || null,
            communicationLanguage,
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

      }

      // NOTE: Communication log is written AFTER successful email send (see below)
      // Do NOT log here to avoid false-positive idempotency check

      // Final locked entitlement/balance check and redemption share the order,
      // stock and customer transaction. Any rejection rolls all of them back.
      if (creditUsed > 0) {
        await redeemPartnerCreditInTransaction(
          orderId,
          createPartnerCreditTransactionQueryClient(query => tx.execute(query)),
        );
      }

      const response = {
        success:true,orderId,paymentInstructions:null,externalOrderReference:externalOrderReference || undefined,
        subtotal:input.subtotal,discount:input.discount,kwkDiscount:input.kwkDiscount || 0,
        kwkCreditUsed:input.kwkCreditUsed || 0,shipping:input.shipping,total:input.total,
      };
      if (normalCheckoutKey) await persistCheckoutReceipt(tx,normalCheckoutKey,normalFingerprint!,response);
      await queueOrderTask(tx,orderId,'customer_metrics');
      if (customerIntegrityTrigger) await queueOrderTask(tx,orderId,'customer_duplicate_review');
      await queueOrderTask(tx,orderId,'payment_instructions');
      if (shouldSendConfirmation) await queueOrderTask(tx,orderId,'order_confirmation');
      return response;
      });
      // Another concurrent attempt committed the receipt: no second communication.
      if (transactionResponse.orderId !== orderId) return transactionResponse;
      await runOrderTask(db,orderId,'customer_metrics',async () => {
        if (customerId) await refreshCustomerOrderMetrics(customerId);
      });
      await runOrderTask(db,orderId,'customer_duplicate_review',async () => {
        if (customerId && customerIntegrityTrigger) await queueCustomerDuplicateReview(customerId,customerIntegrityTrigger,'order.create');
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

      // Only the durable claim holder invokes the normal automatic shop confirmation.
      if (shouldSendConfirmation) await runOrderTask(db,orderId,'order_confirmation',async () => {
        const accepted = await sendOrderConfirmationEmail({
          orderId,communicationLanguage,storeKey:input.storeKey,externalOrderReference,
          customer:input.customer,items:input.items.map(i => ({...i,dosage:i.dosage || null,variant:i.variant || null})),
          subtotal:input.subtotal,discount:input.discount,discountCode:input.discountCode,
          shipping:input.shipping,total:input.total,paymentMethod:input.paymentMethod,
        });
        if (!accepted) throw Error('ORDER_CONFIRMATION_NOT_ACCEPTED');
      },true);

      // Admin-Benachrichtigung deaktiviert:
      // Pakko erhält bereits eine BCC-Kopie der Bestellbestätigung (mit IBAN/Zahlungsinfos).
      // Eine zusätzliche interne Mail wäre redundant und führt zu 4 Mails pro Bestellung.
      // sendAdminOrderNotification wurde hier entfernt.

      // Bank transfer is always returned after a successful order, including
      // optional direct/card payments. It is the reliable fallback if a payment
      // link or card transaction cannot be processed.
      const paymentInstructions = await runOrderTask(db,orderId,'payment_instructions',getReleasedBankTransferInstructions);
      return { ...transactionResponse, paymentInstructions };
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
        ? await db.select(orderListColumnsWithLabelPresence).from(orders).where(and(...conditions)).orderBy(desc(orders.orderDate))
        : await db.select(orderListColumnsWithLabelPresence).from(orders).orderBy(desc(orders.orderDate));

      // Get items for all returned orders in a single query
      const orderIds = filteredOrders.map(o => o.orderId);
      let items: any[] = [];
      if (orderIds.length > 0) {
        items = await db.select().from(orderItems).where(
          inArray(orderItems.orderId, orderIds)
        );
      }
      const personalPromoAssignments = await getPersonalPromoAssignmentsForOrderIds(orderIds);
      const communicationPhones = await getEffectiveCommunicationPhonesForOrders(
        filteredOrders.map((order) => ({ orderId: order.orderId, phone: order.phone })),
      );
      const dhlLabelLifecycle = await getDhlLabelLifecycleForOrders(filteredOrders
        .filter((order) => order.trackingCarrier === "DHL" || order.trackingCarrier === "DHL_PENDING")
        .map((order) => order.orderId));

      // Combine. Die Datenbankabfrage schließt große Labeldaten vollständig aus.
      // Für vorhandene DHL-Labels wird nur eine kurze, geschützte Abrufroute geliefert.
      const integrityIssues = await getOrderIntegrityIssues(db, orderIds);
      const result = filteredOrders.map(o => ({
        ...o,
        integrityIssues: integrityIssues.get(o.orderId) ?? [],
        dhlLabelLifecycle: dhlLabelLifecycle.get(o.orderId) ?? null,
        // Labels werden ausschließlich über eine kurze, geschützte Abrufroute
        // geliefert. Das gilt für DHL-PDFs und extern hochgeladene Labels gleich.
        shippingLabelUrl: o.hasShippingLabel
          ? `/api/shipping/label/${encodeURIComponent(o.orderId)}`
          : null,
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
        effectiveCommunicationPhone: communicationPhones.get(o.orderId)?.effectivePhone || o.phone,
        communicationPhoneSource: communicationPhones.get(o.orderId)?.source || "order_snapshot",
        communicationPhoneLatestEventId: communicationPhones.get(o.orderId)?.latestEventId ?? null,
        personalPromoCodes: personalPromoAssignments.get(o.orderId) ?? [],
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
      const personalPromoAssignments = await getPersonalPromoAssignmentsForOrderIds([order.orderId]);
      const communicationPhone = await getEffectiveCommunicationPhone(order.orderId);
      const dhlLabelLifecycle = await getDhlLabelLifecycleForOrders(
        order.trackingCarrier === "DHL" || order.trackingCarrier === "DHL_PENDING" ? [order.orderId] : [],
      );

      return {
        ...order,
        integrityIssues: (await getOrderIntegrityIssues(db, [order.orderId])).get(order.orderId) ?? [],
        dhlLabelLifecycle: dhlLabelLifecycle.get(order.orderId) ?? null,
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
        effectiveCommunicationPhone: communicationPhone.effectivePhone,
        communicationPhoneSource: communicationPhone.source,
        communicationPhoneLatestEventId: communicationPhone.latestEventId,
        personalPromoCodes: personalPromoAssignments.get(order.orderId) ?? [],
        items: items.map(i => ({ ...i, price: parseFloat(i.price) })),
      };
    }),

  checkoutStatus: publicProcedure.input(z.object({
    checkoutIdempotencyKey:z.string().regex(/^[a-f0-9]{64}$/),
    payloadFingerprint:z.string().regex(/^[a-f0-9]{64}$/),
  })).query(async ({input}) => {
    const db=await getDb(); if(!db) throw Error('Database not available');
    const [receipt]=resultRows(await db.execute(sql`SELECT order_id FROM priority_checkout_receipts WHERE intent_key=${input.checkoutIdempotencyKey} AND payload_fingerprint=${input.payloadFingerprint}`));
    return receipt ? {state:'committed' as const,orderId:receipt.order_id} : {state:'not_found' as const};
  }),
  cancel: adminProcedure.input(z.object({orderId:z.string(),restock:z.boolean(),reason:z.string().trim().min(5).max(500)}))
    .mutation(async ({input,ctx}) => {
      const db=await getDb(); if(!db) throw Error('Database not available');
      return db.transaction(async tx => {
        const order=await lockOrder(tx,input.orderId);
        const units=input.restock ? await returnOrderStock(tx,order,input.reason,ctx.user?.username || 'Admin') : 0;
        await tx.update(orders).set({status:'storniert',cancelledAt:order.cancelledAt || new Date(),updatedAt:new Date()}).where(eq(orders.orderId,input.orderId));
        const finances=await reverseOrderFinancesInTransaction(tx,input.orderId);
        await recordOrderAction(tx,input.orderId,input.restock ? 'cancel_restock' : 'cancel_no_restock',input.reason,ctx.user?.username || 'Admin',units);
        return {success:true,restoredStock:units,financialRepairRequired:finances.repairRequired};
      });
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

      let financialRepairRequired = await db.transaction(async tx => {
        const previous=await lockOrder(tx,input.orderId);
        if (previous.status === 'storniert' && input.status !== 'storniert') {
          const [obligation]=resultRows(await tx.execute(sql`SELECT EXISTS(SELECT 1 FROM priority_stock_returns WHERE order_id=${input.orderId}) OR EXISTS(SELECT 1 FROM priority_order_tasks WHERE order_id=${input.orderId} AND task='financial_cancellation') OR EXISTS(SELECT 1 FROM partner_transactions WHERE order_id=${input.orderId}) OR EXISTS(SELECT 1 FROM kwk_ledger WHERE order_id=${input.orderId}) AS blocked`));
          if(obligation?.blocked) throw Error('ORDER_CANCELLED_REOPEN_REVIEW_REQUIRED');
        }
        // Preserve immutable event timestamps on repeated status confirmation.
        if (previous.paidAt && input.status === 'bezahlt') updateData.paidAt=previous.paidAt;
        if (previous.shippedAt && input.status === 'versendet') updateData.shippedAt=previous.shippedAt;
        if (previous.cancelledAt && input.status === 'storniert') updateData.cancelledAt=previous.cancelledAt;
        await tx.update(orders).set(updateData).where(eq(orders.orderId,input.orderId));
        if (input.status === 'storniert') return (await reverseOrderFinancesInTransaction(tx,input.orderId)).repairRequired;
        if (isFinanciallyPaidStatus(input.status)) await queueOrderTask(tx,input.orderId,`financial_status_${input.status}`);
        return false;
      });

      // Partnerprovision benötigt bestätigte Zahlung UND Versand; KWK bleibt zahlungsgebunden.
      // Jeder spätere Versand-/Zustellstatus wiederholt die idempotente Prüfung.
      if (isFinanciallyPaidStatus(input.status)) {
        const completed = await runOrderTask(db,input.orderId,`financial_status_${input.status}`,async () => {
          const [order] = await db.select({paidAt:orders.paidAt}).from(orders).where(eq(orders.orderId,input.orderId));
          if (order?.paidAt) {
            await bookPaidPartnerCommission(input.orderId);
            await releaseKwkCreditForPaidOrder(input.orderId);
          }
          return true;
        });
        // Receipt remains truthful even if post-commit financial work fails.
        if (completed !== true) {
          const [task] = resultRows(await db.execute(sql`SELECT state FROM priority_order_tasks WHERE order_id=${input.orderId} AND task=${`financial_status_${input.status}`}`));
          financialRepairRequired = task?.state !== 'done';
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
              communicationLanguage: normalizeCommunicationLanguage(order.communicationLanguage),
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
        financialRepairRequired,
        emailSent: emailResult.sent,
        emailError: emailResult.error,
      };
    }),

  // ADMIN: Get order statistics
  stats: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const allOrders = await db.select().from(orders);

    const commercialOrders = allOrders.filter(isCommercialOrder);
    const stats = {
      total: commercialOrders.length,
      offen: commercialOrders.filter(o => o.status === "offen").length,
      bezahlt: commercialOrders.filter(o => o.status === "bezahlt").length,
      gepackt: commercialOrders.filter(o => o.status === "gepackt").length,
      versendet: commercialOrders.filter(o => o.status === "versendet").length,
      zugestellt: commercialOrders.filter(o => o.status === "zugestellt").length,
      storniert: allOrders.filter(o => o.status === "storniert").length,
      umsatzBezahlt: commercialOrders
        .filter(isCompletedCommercialOrder)
        .reduce((sum, o) => sum + parseFloat(o.total), 0),
      umsatzOffen: commercialOrders
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
        console.log(`[Partners] Prüfung Zahlung und Versand ${order.orderId}: ${creditResult.reason} (${creditResult.amount.toFixed(2)} €)`);
        await releaseKwkCreditForPaidOrder(order.orderId);

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
        console.log(`[Partners] Prüfung Zahlung und Versand ${input.orderId}: ${creditResult.reason} (${creditResult.amount.toFixed(2)} €)`);
        await releaseKwkCreditForPaidOrder(input.orderId);
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

  // Both deletion paths preserve audit and are atomic; financial/shipping links require review.
  deleteNoRestock: adminProcedure.input(z.object({orderId:z.string()})).mutation(async ({input,ctx}) => {
    const db=await getDb(); if(!db) throw Error('Database not available');
    return deleteOrderAtomically(db,input.orderId,false,ctx.user?.username || 'Admin');
  }),
  delete: adminProcedure.input(z.object({orderId:z.string()})).mutation(async ({input,ctx}) => {
    const db=await getDb(); if(!db) throw Error('Database not available');
    return deleteOrderAtomically(db,input.orderId,true,ctx.user?.username || 'Admin');
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
        id: z.number().int().positive().optional(),
        name: z.string(),
        dosage: z.string().optional(),
        variant: z.string().optional(),
        price: z.number(),
        quantity: z.number().int().positive(),
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

      return db.transaction(async tx => {
      const db=tx;
      const order=await lockOrder(tx,input.orderId);
      await assertOrderFinanciallyEditable(tx,order);
      if (order.status === 'storniert') throw Error('ORDER_CANCELLED_EDIT_REVIEW_REQUIRED');
      const oldItems=await tx.select().from(orderItems).where(eq(orderItems.orderId,input.orderId));
      const history=await tx.select().from(stockHistory).where(eq(stockHistory.orderId,input.orderId));
      if (input.items.some(i => i.id && !oldItems.some(old => old.id === i.id))) throw Error('ORDER_ITEM_ID_CONFLICT');
      const returns=resultRows(await tx.execute(sql`SELECT original_movement_id,return_movement_id FROM priority_stock_returns WHERE order_id=${input.orderId}`));
      const reversedOriginals=new Set(returns.map(r=>r.original_movement_id));
      const returnMovements=new Set(returns.map(r=>r.return_movement_id));
      const activeSales=history.filter(h=>h.quantityChange<0 && h.changeType==='verkauf' && !reversedOriginals.has(h.id));
      const unresolvedHistory=history.filter(h=>!reversedOriginals.has(h.id) && !returnMovements.has(h.id));
      const stockShape=(items:any[]) => JSON.stringify(items.map(i => ({name:i.name,dosage:i.dosage || '',variant:i.variant || '',type:i.type,quantity:i.quantity,articleId:i.articleId || null})).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
      // Unproven historical positions are not reconstructed from names. Monetary-only
      // unpaid/unlinked edits remain available; item changes require explicit article IDs.
      if (stockShape(oldItems) !== stockShape(input.items)) {
        if (oldItems.some(i => !i.articleId) || input.items.some(i => !i.articleId) || unresolvedHistory.some(h => h.changeType !== 'verkauf' || h.quantityChange >= 0)) throw Error('ORDER_ITEM_STOCK_EDIT_REVIEW_REQUIRED');
        const demand=(items:any[]) => {const m=new Map<number,number>(); for(const i of items)m.set(i.articleId,(m.get(i.articleId) || 0)+i.quantity);return m;};
        const before=demand(oldItems),after=demand(input.items);
        const sold=new Map<number,number>(); for(const h of activeSales)sold.set(h.articleId,(sold.get(h.articleId) || 0)-h.quantityChange);
        if ([...before].some(([id,qty]) => sold.get(id)!==qty) || [...sold].some(([id,qty]) => before.get(id)!==qty)) throw Error('ORDER_ITEM_STOCK_EDIT_REVIEW_REQUIRED');
        const ids=[...new Set([...before.keys(),...after.keys()])].sort((a,b)=>a-b);
        const catalog=ids.length ? await tx.select().from(articles).where(inArray(articles.id,ids)).orderBy(articles.id).for('update') : [];
        // Reverse original movements, then record a replacement sale plan. A later
        // cancellation sees only unreturned originals, even for removed positions.
        await returnOrderStock(tx,order,'Explicit unpaid order item edit','Admin');
        for(const id of ids) {
          const [article]=await tx.select().from(articles).where(eq(articles.id,id));
          if(!article)throw Error('ORDER_ITEM_STOCK_EDIT_REVIEW_REQUIRED');
          const qty=after.get(id) || 0;
          if(qty)await applyStockMovement(tx,{articleId:id,sku:article.sku,expectedStock:article.stock,change:-qty,type:'verkauf',reason:'Explicit unpaid order item edit',orderId:input.orderId,actor:'Admin'});
        }
      }
      if (!Number.isFinite(input.total) || input.total < 0 || input.subtotal < 0 || input.discount < 0 || input.shipping < 0 || Math.abs(input.total-(input.subtotal-input.discount+input.shipping)) > 0.011 || Math.abs(input.subtotal-input.items.reduce((sum,i)=>sum+i.price*i.quantity,0)) > 0.011) throw Error('ORDER_EDIT_AMOUNTS_INVALID');

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
          isNasalSpray: (oldItems.find(old => old.id === item.id) || oldItems.find(old => stockShape([old])===stockShape([item])))?.isNasalSpray || false,
          isNasalDiySet: (oldItems.find(old => old.id === item.id) || oldItems.find(old => stockShape([old])===stockShape([item])))?.isNasalDiySet || false,
          isPlugPlay: (oldItems.find(old => old.id === item.id) || oldItems.find(old => stockShape([old])===stockShape([item])))?.isPlugPlay || false,
        });
      }

      console.log(`[Orders] Updated order ${input.orderId} – ${input.total.toFixed(2)} EUR – ${input.items.length} items`);

      return { success: true };
      });
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
          communicationLanguage: normalizeCommunicationLanguage(order.communicationLanguage),
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
      const communicationPhone = await getEffectiveCommunicationPhone(order.orderId);
      const phone = communicationPhone.effectivePhone || "";
      const waMessage = buildPackingWhatsAppMessage({
        customerName,
        orderId: order.orderId,
        communicationLanguage: order.communicationLanguage,
      });

      console.log(`[Orders] Packing notification for ${order.orderId}: email=${input.sendEmail}, phone=${phone}`);
      return {
        success: true,
        results,
        whatsappPhone: phone,
        communicationPhoneSource: communicationPhone.source,
        whatsappMessage: waMessage,
        customerName,
        orderId: order.orderId,
      };
    }),

  // ADMIN: A WhatsApp contact correction belongs to exactly one order. The
  // historical customer/order snapshots, invoices, delivery data and DHL data
  // are deliberately never updated here.
  getCommunicationPhone: adminProcedure
    .input(z.object({ orderId: z.string().trim().min(1).max(32) }))
    .query(async ({ input }) => getEffectiveCommunicationPhone(input.orderId)),

  setCommunicationPhoneOverride: adminProcedure
    .input(z.object({
      orderId: z.string().trim().min(1).max(32),
      phone: z.string().trim().min(1).max(80),
      reason: z.string().trim().min(5).max(500),
      requestId: z.string().uuid(),
      expectedLatestEventId: z.number().int().positive().nullable(),
    }))
    .mutation(async ({ input, ctx }) => setOrderCommunicationPhoneOverride({
      ...input,
      actor: ctx.user?.name || ctx.user?.username || `Admin ${ctx.user?.id || ""}`.trim(),
    })),

  clearCommunicationPhoneOverride: adminProcedure
    .input(z.object({
      orderId: z.string().trim().min(1).max(32),
      reason: z.string().trim().min(5).max(500),
      requestId: z.string().uuid(),
      expectedLatestEventId: z.number().int().positive().nullable(),
    }))
    .mutation(async ({ input, ctx }) => clearOrderCommunicationPhoneOverride({
      ...input,
      actor: ctx.user?.name || ctx.user?.username || `Admin ${ctx.user?.id || ""}`.trim(),
    })),

  // Reassign order to a different customer (admin only)
  reassignCustomer: adminProcedure
    .input(z.object({
      orderId: z.string(),
      newCustomerId: z.number().int().positive(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      return reassignOrderCustomer(db, input, ctx.user.id);
    }),
});
