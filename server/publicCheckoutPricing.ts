import {
  resolveAuthoritativeItemPrice,
  roundMoney,
  type KwkCatalogArticle,
  type KwkCheckoutItem,
} from "./kwkCheckoutPricing.js";

export type PublicCheckoutCatalogItem = KwkCheckoutItem & {
  dosage?: string;
  isPlugPlay?: boolean;
  isNasalDiySet?: boolean;
  isFreeGift?: boolean;
};

/**
 * Public shop prices are never accepted from the browser. This deliberately
 * leaves authenticated manual WaWi sales outside the helper: they are an
 * explicitly manual pricing workflow with their own server-side safeguards.
 */
export function repricePublicCheckoutItems<T extends PublicCheckoutCatalogItem>(
  items: readonly T[],
  catalog: KwkCatalogArticle[],
): { items: T[]; subtotal: number } {
  const authoritativeItems = items.map((item) => ({
    ...item,
    price: resolveAuthoritativeItemPrice(item, catalog),
  })) as T[];

  return {
    items: authoritativeItems,
    subtotal: roundMoney(
      authoritativeItems.reduce((sum, item) => sum + item.price * item.quantity, 0),
    ),
  };
}

/**
 * A promotion threshold is a pre-discount merchandise threshold. Call this
 * only after public items were rebuilt from the current catalog.
 */
export function assertPromotionMinimumOrder(
  minimumOrder: number,
  merchandiseSubtotal: number,
  errorCode = "AKTIONSCODE_UNGUELTIG",
): void {
  const threshold = Number(minimumOrder);
  const subtotal = Number(merchandiseSubtotal);
  if (!Number.isFinite(threshold) || threshold < 0 || !Number.isFinite(subtotal) || subtotal < 0) {
    throw new Error(errorCode);
  }
  if (threshold > 0 && subtotal + 0.000001 < threshold) {
    throw new Error(errorCode);
  }
}
