import {
  calculateAuthoritativeShipping,
  calculatePromoDiscount,
  requiresColdChainShipping,
  resolveAuthoritativeItemPrice,
  roundMoney,
  type KwkCatalogArticle,
  type PromoDefinition,
} from "./kwkCheckoutPricing.js";
import {
  isNasalDiySetEligible,
  NASAL_DIY_SET_COMPONENTS,
} from "./nasalDiySetConfig.js";

/**
 * Checkout V2 accepts only a customer's selection. It never accepts a
 * client-calculated price, discount, shipping amount or total. This module is
 * pure and testable; its router resolves all identities and code definitions
 * from the leading database before calculating a quote.
 */
export type CheckoutV2CatalogArticle = KwkCatalogArticle & {
  stock?: number | null;
};

export type CheckoutV2Selection = {
  shopProductId: string;
  dosage?: string;
  quantity: number;
  isPlugPlay?: boolean;
  isNasalDiySet?: boolean;
  isNasalSpray?: boolean;
};

export type CheckoutV2Delivery = {
  country: string;
  deliveryType: "home" | "packstation";
};

export type CheckoutV2Promotion =
  | { kind: "promo"; code: string; promo: PromoDefinition }
  | { kind: "partner"; code: string; percent: number };

export type CheckoutV2Benefits = {
  promotion?: CheckoutV2Promotion;
  kwkReferralCode?: string;
  kwkReferralPercent?: number;
  kwkCredit?: { requested: number; available: number };
};

/** Kept only for the first pure-contract tests and adapter compatibility. */
export type CheckoutV2Benefit =
  | { kind: "none" }
  | CheckoutV2Promotion
  | { kind: "kwk_referral"; code: string; percent?: number }
  | { kind: "kwk_credit"; requested: number; available: number };

export type CheckoutV2QuoteLine = {
  shopProductId: string;
  name: string;
  dosage?: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  isPlugPlay: boolean;
  isNasalDiySet: boolean;
  isNasalSpray: boolean;
};

export type CheckoutV2DiscountLine = {
  source: "promotion_code" | "partner_code" | "kwk_referral" | "kwk_credit";
  label: string;
  amount: number;
  code?: string;
  percentage?: number;
};

export type CheckoutV2Quote = {
  lines: CheckoutV2QuoteLine[];
  subtotal: number;
  shipping: number;
  discount: number;
  total: number;
  coldChainRequired: boolean;
  deliveryType: "home" | "packstation";
  discountLines: CheckoutV2DiscountLine[];
};

export class CheckoutV2QuoteError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "CheckoutV2QuoteError";
  }
}

function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeDosage(value: string | undefined): string {
  return (value || "").trim().replace(/(\d)\s*(mg|iu|ml|mcg)\b/gi, "$1 $2").toLowerCase();
}

function articleDosage(article: CheckoutV2CatalogArticle): string {
  const match = article.name.match(/(\d+(?:\.\d+)?\s*(?:mg|IU|ml|mcg|iu))\s*\)?\s*$/i);
  return normalizeDosage(match?.[1]);
}

function matchesSelectionArticle(selection: CheckoutV2Selection, article: CheckoutV2CatalogArticle): boolean {
  const selectedId = normalizeId(selection.shopProductId);
  if (normalizeId(article.shopProductId || "") !== selectedId && normalizeId(article.sku) !== selectedId) return false;
  const selectedDosage = normalizeDosage(selection.dosage);
  return !selectedDosage || selectedDosage === articleDosage(article);
}

function findCanonicalArticle(selection: CheckoutV2Selection, catalog: CheckoutV2CatalogArticle[]): CheckoutV2CatalogArticle {
  const productId = normalizeId(selection.shopProductId);
  if (!productId) throw new CheckoutV2QuoteError("PRODUCT_REFERENCE_REQUIRED", "Ein Produkt konnte nicht eindeutig zugeordnet werden.");

  const family = catalog.filter((article) => article.isActive === 1 && (
    normalizeId(article.shopProductId || "") === productId || normalizeId(article.sku) === productId
  ));
  const canonical = family.find((article) => article.shopVisible === 1 && Array.isArray(article.variants) && article.variants.length > 0)
    ?? family.find((article) => article.shopVisible === 1)
    ?? family[0];
  if (!canonical) throw new CheckoutV2QuoteError("PRODUCT_NOT_AVAILABLE", "Ein Produkt ist nicht mehr verfügbar.");
  return canonical;
}

function validateSelection(selection: CheckoutV2Selection): void {
  if (!Number.isInteger(selection.quantity) || selection.quantity < 1 || selection.quantity > 99) {
    throw new CheckoutV2QuoteError("INVALID_QUANTITY", "Die ausgewählte Menge ist nicht verfügbar.");
  }
  if (selection.isNasalDiySet && !isNasalDiySetEligible(selection.shopProductId)) {
    throw new CheckoutV2QuoteError("NASAL_KIT_NOT_AVAILABLE", "Das Nasenspray-Kit ist für dieses Produkt nicht verfügbar.");
  }
}

function assertAvailability(selection: CheckoutV2Selection, catalog: CheckoutV2CatalogArticle[]): void {
  const matching = catalog.filter((article) => article.isActive === 1 && matchesSelectionArticle(selection, article));
  if (matching.length === 0) throw new CheckoutV2QuoteError("PRODUCT_NOT_AVAILABLE", "Ein Produkt ist nicht mehr verfügbar.");
  const available = matching.reduce((sum, article) => sum + Math.max(0, Number(article.stock ?? 0)), 0);
  if (available < selection.quantity) {
    throw new CheckoutV2QuoteError("PRODUCT_OUT_OF_STOCK", "Ein Produkt ist in der gewünschten Menge nicht mehr verfügbar.");
  }
}

function assertNasalKitAvailability(selections: CheckoutV2Selection[], catalog: CheckoutV2CatalogArticle[]): void {
  const kitCount = selections.filter((selection) => selection.isNasalDiySet).reduce((sum, selection) => sum + selection.quantity, 0);
  if (kitCount === 0) return;
  const bacComponent = NASAL_DIY_SET_COMPONENTS.find((component) => component.inventoryTracked);
  if (!bacComponent) throw new CheckoutV2QuoteError("NASAL_KIT_CONFIGURATION_INVALID", "Das Nasenspray-Kit ist derzeit nicht verfügbar.");
  const bacArticles = catalog.filter((article) => article.isActive === 1 && normalizeId(article.shopProductId || "") === bacComponent.articleShopProductId);
  const available = bacArticles.reduce((sum, article) => sum + Math.max(0, Number(article.stock ?? 0)), 0);
  if (available < kitCount) {
    throw new CheckoutV2QuoteError("NASAL_KIT_COMPONENT_OUT_OF_STOCK", "Das Nasenspray-Kit ist derzeit nicht verfügbar.");
  }
}

function resolveLine(selection: CheckoutV2Selection, catalog: CheckoutV2CatalogArticle[]): CheckoutV2QuoteLine {
  validateSelection(selection);
  assertAvailability(selection, catalog);
  const article = findCanonicalArticle(selection, catalog);
  const unitPrice = resolveAuthoritativeItemPrice({
    shopProductId: selection.shopProductId,
    dosage: selection.dosage,
    quantity: selection.quantity,
    // Pricing helpers receive no client-supplied monetary value.
    price: 0,
    isPlugPlay: selection.isPlugPlay,
    isNasalDiySet: selection.isNasalDiySet,
  }, catalog);

  return {
    shopProductId: selection.shopProductId.trim(),
    name: article.name,
    dosage: selection.dosage?.trim() || undefined,
    quantity: selection.quantity,
    unitPrice,
    lineTotal: roundMoney(unitPrice * selection.quantity),
    isPlugPlay: selection.isPlugPlay === true,
    isNasalDiySet: selection.isNasalDiySet === true,
    isNasalSpray: selection.isNasalSpray === true,
  };
}

function normalizeBenefits(benefit: CheckoutV2Benefit | undefined, benefits: CheckoutV2Benefits | undefined): CheckoutV2Benefits {
  if (benefit && benefits) throw new CheckoutV2QuoteError("BENEFIT_INPUT_AMBIGUOUS", "Ein Vorteil konnte nicht eindeutig zugeordnet werden.");
  if (benefits) return benefits;
  if (!benefit || benefit.kind === "none") return {};
  if (benefit.kind === "promo" || benefit.kind === "partner") return { promotion: benefit };
  if (benefit.kind === "kwk_referral") return { kwkReferralCode: benefit.code, kwkReferralPercent: benefit.percent };
  return { kwkCredit: { requested: benefit.requested, available: benefit.available } };
}

function resolveDiscount(input: {
  lines: CheckoutV2QuoteLine[];
  subtotal: number;
  shipping: number;
  benefits: CheckoutV2Benefits;
}): { discount: number; total: number; discountLines: CheckoutV2DiscountLine[] } {
  const { lines, subtotal, shipping, benefits } = input;
  const promotion = benefits.promotion;
  const hasPartner = promotion?.kind === "partner";
  const hasReferral = Boolean(benefits.kwkReferralCode?.trim());
  const hasKwkCredit = Boolean(benefits.kwkCredit && benefits.kwkCredit.requested > 0);
  if (hasPartner && (hasReferral || hasKwkCredit)) {
    throw new CheckoutV2QuoteError("KWK_PARTNER_EXCLUDED", "Partner- und Empfehlungswege können nicht kombiniert werden.");
  }
  if (hasReferral && hasKwkCredit) {
    throw new CheckoutV2QuoteError("KWK_REFERRAL_CREDIT_EXCLUDED", "Empfehlungsvorteil und Guthaben können nicht kombiniert werden.");
  }

  const discountLines: CheckoutV2DiscountLine[] = [];
  let promotionDiscount = 0;
  if (promotion?.kind === "promo") {
    promotionDiscount = calculatePromoDiscount({
      subtotal,
      items: lines.map((line) => ({ shopProductId: line.shopProductId, price: line.unitPrice, quantity: line.quantity })),
      promo: promotion.promo,
    });
    if (promotionDiscount > 0) discountLines.push({ source: "promotion_code", label: "Aktionsrabatt", amount: promotionDiscount, code: promotion.code });
  }
  if (promotion?.kind === "partner") {
    const percentage = Math.max(0, Math.min(100, Number(promotion.percent) || 0));
    promotionDiscount = roundMoney(subtotal * percentage / 100);
    if (promotionDiscount > 0) discountLines.push({ source: "partner_code", label: "Partnervorteil", amount: promotionDiscount, code: promotion.code, percentage });
  }

  const postPromotionValue = roundMoney(Math.max(0, subtotal - promotionDiscount));
  let referralDiscount = 0;
  if (hasReferral) {
    const percentage = Math.max(0, Math.min(100, Number(benefits.kwkReferralPercent ?? 10)));
    referralDiscount = roundMoney(postPromotionValue * percentage / 100);
    if (referralDiscount > 0) discountLines.push({ source: "kwk_referral", label: "Empfehlungsvorteil", amount: referralDiscount, code: benefits.kwkReferralCode?.trim().toUpperCase(), percentage });
  }

  const creditEligibleValue = roundMoney(Math.max(0, postPromotionValue - referralDiscount));
  let creditDiscount = 0;
  if (hasKwkCredit && benefits.kwkCredit) {
    const requested = roundMoney(Math.max(0, benefits.kwkCredit.requested));
    const available = roundMoney(Math.max(0, benefits.kwkCredit.available));
    creditDiscount = roundMoney(Math.min(requested, available, creditEligibleValue));
    if (creditDiscount > 0) discountLines.push({ source: "kwk_credit", label: "Guthaben", amount: creditDiscount });
  }

  const discount = roundMoney(promotionDiscount + referralDiscount + creditDiscount);
  return { discount, total: roundMoney(subtotal - discount + shipping), discountLines };
}

export function calculateCheckoutV2Quote(input: {
  selections: CheckoutV2Selection[];
  delivery: CheckoutV2Delivery;
  /** Compatibility input. New callers use `benefits`. */
  benefit?: CheckoutV2Benefit;
  benefits?: CheckoutV2Benefits;
  catalog: CheckoutV2CatalogArticle[];
}): CheckoutV2Quote {
  if (!Array.isArray(input.selections) || input.selections.length === 0) {
    throw new CheckoutV2QuoteError("CART_EMPTY", "Dein Warenkorb ist leer.");
  }
  const country = input.delivery.country?.trim();
  if (!country) throw new CheckoutV2QuoteError("COUNTRY_REQUIRED", "Bitte wähle ein Lieferland aus.");

  const lines = input.selections.map((selection) => resolveLine(selection, input.catalog));
  assertNasalKitAvailability(input.selections, input.catalog);
  const coldChainRequired = lines.some(requiresColdChainShipping);
  if (input.delivery.deliveryType === "packstation" && coldChainRequired) {
    throw new CheckoutV2QuoteError("PACKSTATION_NOT_AVAILABLE", "Für diese Bestellung ist eine Hausadresse erforderlich.");
  }

  const benefits = normalizeBenefits(input.benefit, input.benefits);
  const shipping = calculateAuthoritativeShipping({
    country,
    items: lines,
    promoDescription: benefits.promotion?.kind === "promo" ? benefits.promotion.promo.description : undefined,
  });
  const subtotal = roundMoney(lines.reduce((sum, line) => sum + line.lineTotal, 0));
  const discount = resolveDiscount({ lines, subtotal, shipping, benefits });
  return {
    lines,
    subtotal,
    shipping,
    discount: discount.discount,
    total: discount.total,
    coldChainRequired,
    deliveryType: input.delivery.deliveryType,
    discountLines: discount.discountLines,
  };
}
