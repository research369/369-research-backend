import { KWK_DISCOUNT_PERCENT } from "./kwkService.js";

export type KwkCheckoutItem = {
  shopProductId?: string;
  price: number;
  quantity: number;
};

export type PromoDefinition = {
  discountType: "percent" | "fixed";
  percentage: number;
  fixedAmount: number;
  description?: string | null;
};

export type PromoMetadata = {
  restrict: string[];
  freeShipping: string[];
};

export const roundMoney = (value: number): number =>
  Math.round((value + Number.EPSILON) * 100) / 100;

export const normalizeKwkPhone = (value: string): string => {
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("0049")) digits = digits.slice(2);
  if (digits.startsWith("490")) return `49${digits.slice(3)}`;
  if (digits.startsWith("49")) return digits;
  if (digits.startsWith("0")) return `49${digits.replace(/^0+/, "")}`;
  return digits;
};

export function parsePromoMetadata(description?: string | null): PromoMetadata {
  if (!description) return { restrict: [], freeShipping: [] };
  const separatorIndex = description.lastIndexOf(" | {");
  if (separatorIndex === -1) return { restrict: [], freeShipping: [] };

  try {
    const metadata = JSON.parse(description.substring(separatorIndex + 3).trim());
    return {
      restrict: Array.isArray(metadata.restrict)
        ? metadata.restrict.filter((value: unknown): value is string => typeof value === "string")
        : [],
      freeShipping: Array.isArray(metadata.freeShipping)
        ? metadata.freeShipping.filter((value: unknown): value is string => typeof value === "string")
        : [],
    };
  } catch {
    return { restrict: [], freeShipping: [] };
  }
}

export type KwkCatalogArticle = {
  sku: string;
  shopProductId: string | null;
  name: string;
  sellingPrice: string | number | null;
  salePrice: string | number | null;
  variants: unknown;
  isActive: number;
  shopVisible: number;
};

function normalizeDosage(value: unknown): string {
  return typeof value === "string"
    ? value.trim().replace(/(\d)\s*(mg|iu|ml|mcg)\b/gi, "$1 $2").toLowerCase()
    : "";
}

function articleDosage(article: KwkCatalogArticle): string {
  const match = article.name.match(/(\d+(?:\.\d+)?\s*(?:mg|IU|ml|mcg|iu))\s*\)?\s*$/i);
  return normalizeDosage(match?.[1]);
}

export function resolveAuthoritativeItemPrice(
  item: KwkCheckoutItem & { dosage?: string; isPlugPlay?: boolean; isNasalDiySet?: boolean; isFreeGift?: boolean },
  catalog: KwkCatalogArticle[],
): number {
  if (item.isFreeGift) return 0;
  const productId = (item.shopProductId || "").trim().toLowerCase();
  if (!productId) throw new Error("KWK_ARTIKEL_OHNE_PRODUKTREFERENZ");

  const family = catalog.filter((article) => article.isActive === 1 && (
    article.shopProductId?.trim().toLowerCase() === productId
    || article.sku.trim().toLowerCase() === productId
  ));
  const canonical = family.find((article) => article.shopVisible === 1 && Array.isArray(article.variants) && article.variants.length > 0)
    ?? family.find((article) => article.shopVisible === 1)
    ?? family[0];
  if (!canonical) throw new Error(`KWK_ARTIKEL_NICHT_GEFUNDEN: ${item.shopProductId}`);

  const salePrice = Number(canonical.salePrice);
  let basePrice = Number.isFinite(salePrice) && salePrice > 0 ? salePrice : NaN;
  const dosage = normalizeDosage(item.dosage);
  if (!Number.isFinite(basePrice) && dosage) {
    const configuredVariants = family.flatMap((article) => Array.isArray(article.variants) ? article.variants : []);
    const configured = configuredVariants.find((raw) => {
      if (!raw || typeof raw !== "object") return false;
      const variant = raw as Record<string, unknown>;
      return normalizeDosage(variant.dosage ?? variant.label ?? variant.name) === dosage;
    }) as Record<string, unknown> | undefined;
    const configuredPrice = Number(configured?.price);
    const inventoryPrice = Number(family.find((article) => articleDosage(article) === dosage)?.sellingPrice);
    basePrice = Number.isFinite(configuredPrice) && configuredPrice > 0 ? configuredPrice : inventoryPrice;
  }
  if (!Number.isFinite(basePrice)) basePrice = Number(canonical.sellingPrice);
  if (!Number.isFinite(basePrice) || basePrice < 0) {
    throw new Error(`KWK_ARTIKELPREIS_NICHT_ERMITTELBAR: ${item.shopProductId}`);
  }

  const optionSurcharge = (item.isPlugPlay ? 15 : 0) + (item.isNasalDiySet ? 7 : 0);
  return roundMoney(basePrice + optionSurcharge);
}

export function resolveShippingRegion(country: string): "de" | "eu" | "ch" {
  const normalized = country.trim().toLowerCase();
  if (["de", "deutschland", "germany", "allemagne"].includes(normalized)) return "de";
  if (["ch", "schweiz", "switzerland", "suisse", "svizzera"].includes(normalized)) return "ch";
  return "eu";
}

export type ShippingCheckoutItem = {
  name?: string;
  variant?: string;
  isPlugPlay?: boolean;
  isNasalSpray?: boolean;
  isNasalDiySet?: boolean;
};

/**
 * Kühlversand ist für Plug&Play und fertig gemischte Nasensprays verpflichtend.
 * Neben dem persistierten Flag schützt die Rückfallerkennung Bestellungen aus
 * älteren Bundleversionen, deren Variantenbezeichnung „Nasenspray“ enthält.
 */
export function requiresColdChainShipping(item: ShippingCheckoutItem): boolean {
  if (item.isPlugPlay === true) return true;
  if (item.isNasalDiySet === true) return false;
  if (item.isNasalSpray === true) return true;
  const descriptor = `${item.name || ""} ${item.variant || ""}`.toLowerCase();
  return descriptor.includes("nasenspray") && !descriptor.includes("diy");
}

export function calculateAuthoritativeShipping(input: {
  country: string;
  items: ShippingCheckoutItem[];
  promoDescription?: string | null;
}): number {
  const region = resolveShippingRegion(input.country);
  const { freeShipping } = parsePromoMetadata(input.promoDescription);
  if (freeShipping.some((entry) => entry.toLowerCase() === region)) return 0;
  const base = region === "de" ? 8 : region === "ch" ? 18 : 15;
  return base + (input.items.some(requiresColdChainShipping) ? 7 : 0);
}

function productMatchesRestriction(productId: string, restriction: string): boolean {
  return productId === restriction
    || productId.startsWith(`${restriction}-`)
    || restriction.startsWith(`${productId}-`);
}

export function calculatePromoDiscount(input: {
  subtotal: number;
  items: KwkCheckoutItem[];
  promo?: PromoDefinition | null;
}): number {
  if (!input.promo) return 0;
  const { restrict } = parsePromoMetadata(input.promo.description);
  const eligibleSubtotal = restrict.length === 0
    ? input.subtotal
    : input.items.reduce((sum, item) => {
      const productId = (item.shopProductId || "").toLowerCase().trim();
      const eligible = productId.length > 0
        && restrict.some((restriction) => productMatchesRestriction(productId, restriction.toLowerCase().trim()));
      return eligible ? sum + item.price * item.quantity : sum;
    }, 0);

  if (input.promo.discountType === "fixed") {
    return roundMoney(Math.min(Math.max(0, input.promo.fixedAmount), eligibleSubtotal));
  }
  return roundMoney(eligibleSubtotal * Math.max(0, input.promo.percentage) / 100);
}

export function calculateAuthoritativeKwkOrder(input: {
  subtotal: number;
  shipping: number;
  promoDiscount: number;
  kwkCreditUsed: number;
  applyReferralDiscount: boolean;
}): {
  promoDiscount: number;
  kwkDiscount: number;
  kwkCreditUsed: number;
  totalDiscount: number;
  total: number;
} {
  const subtotal = roundMoney(input.subtotal);
  const shipping = roundMoney(input.shipping);
  const promoDiscount = roundMoney(Math.max(0, Math.min(input.promoDiscount, subtotal)));
  const remainingProductValue = roundMoney(Math.max(0, subtotal - promoDiscount));
  const kwkDiscount = input.applyReferralDiscount
    ? roundMoney(remainingProductValue * KWK_DISCOUNT_PERCENT / 100)
    : 0;
  const productValueAfterDiscounts = roundMoney(Math.max(0, remainingProductValue - kwkDiscount));
  const kwkCreditUsed = roundMoney(Math.max(0, Math.min(input.kwkCreditUsed, productValueAfterDiscounts)));
  const totalDiscount = roundMoney(promoDiscount + kwkDiscount + kwkCreditUsed);

  return {
    promoDiscount,
    kwkDiscount,
    kwkCreditUsed,
    totalDiscount,
    total: roundMoney(subtotal - totalDiscount + shipping),
  };
}
