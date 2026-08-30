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
  if (!description) return { restrict: [] };
  const separatorIndex = description.lastIndexOf(" | {");
  if (separatorIndex === -1) return { restrict: [] };

  try {
    const metadata = JSON.parse(description.substring(separatorIndex + 3).trim());
    return {
      restrict: Array.isArray(metadata.restrict)
        ? metadata.restrict.filter((value: unknown): value is string => typeof value === "string")
        : [],
    };
  } catch {
    return { restrict: [] };
  }
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
