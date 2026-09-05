import { roundMoney } from "./kwkCheckoutPricing.js";

export const CHECKOUT_V2_NON_VIAL_CATEGORIES = new Set([
  "Nasensprays",
  "Fertigpens",
  "Forscherpens",
  "Kapseln / Tabletten",
  "Tabletten",
  "Kapseln",
  "369 BeautyLine",
  "Forscher-Bundles",
  "Zubehör",
]);

export const CHECKOUT_V2_FREE_BAC_WATER_THRESHOLD = 50;
export const CHECKOUT_V2_FREE_BAC_WATER_PRODUCT_ID = "bac-wasser-3ml";

export type CheckoutV2Promotion2for3 = {
  enabled: boolean;
  expiresAt?: string | null;
  mode: "all" | "include" | "exclude";
  products: string[];
};

export type CheckoutV2AutomaticEligibleLine = {
  shopProductId: string;
  name: string;
  dosage?: string;
  quantity: number;
  unitPrice: number;
  type: "peptide" | "accessory";
  category?: string | null;
  categories?: unknown;
  isPlugPlay: boolean;
  isNasalDiySet: boolean;
  isNasalSpray: boolean;
};

export type CheckoutV2GiftLine = {
  source: "promo_2for3" | "free_bac_water";
  shopProductId: string;
  name: string;
  dosage?: string;
  quantity: number;
  type: "peptide" | "accessory";
  isNasalDiySet: false;
  isNasalSpray: false;
  isPlugPlay: false;
};

function normaliseProductId(value: string): string {
  return value.trim().toLowerCase();
}

function categoryValues(line: CheckoutV2AutomaticEligibleLine): string[] {
  const fromJson = Array.isArray(line.categories)
    ? line.categories.filter((entry): entry is string => typeof entry === "string")
    : [];
  return [line.category || "", ...fromJson].map((entry) => entry.trim()).filter(Boolean);
}

export function isCheckoutV2NonVial(line: CheckoutV2AutomaticEligibleLine): boolean {
  return categoryValues(line).some((category) => CHECKOUT_V2_NON_VIAL_CATEGORIES.has(category));
}

function isPromotion2for3Active(promotion: CheckoutV2Promotion2for3): boolean {
  if (!promotion.enabled) return false;
  if (!promotion.expiresAt?.trim()) return true;
  const expiresAt = new Date(promotion.expiresAt);
  return !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() > Date.now();
}

function isPromotion2for3Eligible(
  line: CheckoutV2AutomaticEligibleLine,
  promotion: CheckoutV2Promotion2for3,
): boolean {
  if (!isPromotion2for3Active(promotion)) return false;
  if (line.type !== "peptide" || line.isPlugPlay || line.isNasalSpray || line.isNasalDiySet || isCheckoutV2NonVial(line)) {
    return false;
  }
  const selected = normaliseProductId(line.shopProductId);
  const configured = promotion.products.map(normaliseProductId);
  if (promotion.mode === "include" && configured.length > 0 && !configured.includes(selected)) return false;
  if (promotion.mode === "exclude" && configured.includes(selected)) return false;
  return true;
}

function isFreeBacEligible(line: CheckoutV2AutomaticEligibleLine): boolean {
  return line.type === "peptide"
    && !line.isPlugPlay
    && !line.isNasalSpray
    && !line.isNasalDiySet
    && !isCheckoutV2NonVial(line)
    && line.unitPrice >= CHECKOUT_V2_FREE_BAC_WATER_THRESHOLD
    && !normaliseProductId(line.shopProductId).startsWith("bac");
}

/**
 * Calculates the automatic free order lines from authoritative product metadata only.
 * It has no database access and no side effects; the caller must verify gift inventory
 * before exposing or persisting the returned lines.
 */
export function calculateCheckoutV2AutomaticGiftLines(input: {
  lines: CheckoutV2AutomaticEligibleLine[];
  promotion2for3: CheckoutV2Promotion2for3;
  freeBacWaterProduct?: { name: string; dosage?: string } | null;
}): CheckoutV2GiftLine[] {
  const gifts: CheckoutV2GiftLine[] = [];

  for (const line of input.lines) {
    if (!isPromotion2for3Eligible(line, input.promotion2for3)) continue;
    const quantity = Math.floor(line.quantity / 2);
    if (quantity <= 0) continue;
    gifts.push({
      source: "promo_2for3",
      shopProductId: line.shopProductId,
      name: line.name,
      dosage: line.dosage,
      quantity,
      type: "peptide",
      isNasalDiySet: false,
      isNasalSpray: false,
      isPlugPlay: false,
    });
  }

  const freeBacQuantity = input.lines
    .filter(isFreeBacEligible)
    .reduce((sum, line) => sum + line.quantity, 0);
  if (freeBacQuantity > 0) {
    const bac = input.freeBacWaterProduct;
    if (!bac?.name?.trim()) {
      throw new Error("FREE_BAC_WATER_CONFIGURATION_INVALID");
    }
    gifts.push({
      source: "free_bac_water",
      shopProductId: CHECKOUT_V2_FREE_BAC_WATER_PRODUCT_ID,
      name: bac.name,
      dosage: bac.dosage || "3ml",
      quantity: freeBacQuantity,
      type: "accessory",
      isNasalDiySet: false,
      isNasalSpray: false,
      isPlugPlay: false,
    });
  }

  return gifts.map((gift) => ({ ...gift, quantity: Math.max(0, Math.floor(gift.quantity)) }))
    .filter((gift) => gift.quantity > 0);
}

export function calculateCheckoutV2GiftValue(gifts: CheckoutV2GiftLine[]): number {
  // Gifts are recorded as zero-price order lines. This helper deliberately exists to
  // make the resulting monetary value explicit in tests and prevent accidental totals.
  return roundMoney(gifts.reduce((sum) => sum + 0, 0));
}
