import { resolveAuthoritativeItemPrice, type KwkCatalogArticle } from "./kwkCheckoutPricing.js";

export type PublicGiftItem = { shopProductId?: string; dosage?: string; quantity: number; price: number; isFreeGift?: boolean };
export type MultiBuyGiftConfig = { enabled: boolean; expiresAt: string | null; mode: "all" | "include" | "exclude"; products: string[] };
const norm = (value: unknown) => String(value ?? "").trim().toLowerCase();
const generatedBac = (item: PublicGiftItem) => ["bac-wasser-3ml", "bac-water-3ml"].includes(norm(item.shopProductId));

/** BAC is independently removed/rebuilt from canonical paid-vial entitlement.
 * Other free merchandise requires the same paid variant and an active server
 * multi-buy rule. In an exclusive campaign no multi-buy free line is allowed.
 */
export function authorizePublicGiftLines(
  items: readonly PublicGiftItem[],
  catalog: KwkCatalogArticle[],
  multiBuy: MultiBuyGiftConfig,
  exclusive: boolean,
  now = Date.now(),
): void {
  const active = !exclusive && multiBuy.enabled && (!multiBuy.expiresAt || (Number.isFinite(Date.parse(multiBuy.expiresAt)) && now < Date.parse(multiBuy.expiresAt)));
  const group = (item: PublicGiftItem) => {
    const id = norm(item.shopProductId);
    const article = catalog.find((a) => a.isActive === 1 && (norm(a.shopProductId) === id || norm(a.sku) === id));
    if (!article) throw new Error("SHOP_GRATISPOSITION_NICHT_AUTORISIERT: Unbekannte Produktreferenz.");
    // Validate the actual catalogue reference despite the legacy free-price shortcut.
    resolveAuthoritativeItemPrice({ ...item, isFreeGift: false }, catalog);
    return { id: norm(article.shopProductId || article.sku), key: JSON.stringify([norm(article.shopProductId || article.sku), norm(item.dosage).replace(/\s+/g, "")]) };
  };
  const paid = new Map<string, number>();
  for (const item of items.filter((i) => !i.isFreeGift)) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) continue;
    const { key } = group(item);
    paid.set(key, (paid.get(key) ?? 0) + item.quantity);
  }
  const used = new Map<string, number>();
  const filtered = new Set(multiBuy.products.map(norm));
  for (const item of items.filter((i) => i.isFreeGift && !generatedBac(i))) {
    if (!active || !Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
      throw new Error("SHOP_GRATISPOSITION_NICHT_AUTORISIERT: Diese Gratisposition ist während der Aktion nicht verfügbar. Bitte entferne sie aus dem Warenkorb.");
    }
    const { id, key } = group(item);
    const eligible = multiBuy.mode === "all" || (multiBuy.mode === "include" ? filtered.has(id) : !filtered.has(id));
    const total = (used.get(key) ?? 0) + item.quantity;
    if (!eligible || total > Math.floor((paid.get(key) ?? 0) / 2)) {
      throw new Error("SHOP_GRATISPOSITION_NICHT_AUTORISIERT: Kein ausreichender bezahlter Mehrkauf für diese Gratisposition.");
    }
    used.set(key, total);
  }
}
