import { roundMoney } from "./kwkCheckoutPricing.js";

export type CheckoutV2QuantityDiscountItem = {
  shopProductId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  type: "peptide" | "accessory";
  category?: string | null;
  categories?: unknown;
};

export type CheckoutV2QuantityDiscount = {
  percentage: number;
  eligibleItems: number;
  eligibleSubtotal: number;
  amount: number;
};

const TIERS = [
  { minItems: 4, percentage: 10 },
  { minItems: 8, percentage: 20 },
  { minItems: 13, percentage: 25 },
  { minItems: 20, percentage: 30 },
  { minItems: 36, percentage: 35 },
] as const;

function normalizedIdentifier(item: CheckoutV2QuantityDiscountItem): string {
  const categoryValues = Array.isArray(item.categories)
    ? item.categories.filter((entry): entry is string => typeof entry === "string")
    : [];
  return [item.shopProductId, item.name, item.category || "", ...categoryValues]
    .join(" ")
    .toLocaleLowerCase("de-DE")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isPeptidpenWithCase(item: CheckoutV2QuantityDiscountItem): boolean {
  const identifier = normalizedIdentifier(item);
  return item.shopProductId.trim().toLowerCase() === "forscherpen"
    || identifier.includes("peptidpen mit case")
    || identifier.includes("forscherpen mit case");
}

export function isCheckoutV2QuantityDiscountEligible(item: CheckoutV2QuantityDiscountItem): boolean {
  if (!Number.isFinite(item.unitPrice) || item.unitPrice <= 0 || item.quantity <= 0) return false;
  const identifier = normalizedIdentifier(item);
  if (identifier.includes("bac wasser")) return false;

  const categoryValues = [item.category, ...(Array.isArray(item.categories) ? item.categories : [])]
    .filter((entry): entry is string => typeof entry === "string");
  const isAccessory = item.type === "accessory" || categoryValues.some((category) => ["Zubehör", "Forscherpens"].includes(category));
  return !isAccessory || isPeptidpenWithCase(item);
}

/** Applies the agreed quantity tier before eligible promotion codes. */
export function calculateCheckoutV2QuantityDiscount(lines: CheckoutV2QuantityDiscountItem[]): CheckoutV2QuantityDiscount {
  const eligibleLines = lines.filter(isCheckoutV2QuantityDiscountEligible);
  const eligibleItems = eligibleLines.reduce((sum, line) => sum + line.quantity, 0);
  const eligibleSubtotal = roundMoney(eligibleLines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0));
  const percentage = [...TIERS].reverse().find((tier) => eligibleItems >= tier.minItems)?.percentage ?? 0;

  return {
    percentage,
    eligibleItems,
    eligibleSubtotal,
    amount: roundMoney(eligibleSubtotal * percentage / 100),
  };
}
