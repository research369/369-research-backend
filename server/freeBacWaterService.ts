export const FREE_BAC_WATER_THRESHOLD = 50;
export const FREE_BAC_WATER_PRODUCT_ID = "bac-wasser-3ml";

const NON_VIAL_CATEGORIES = new Set([
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

export type CheckoutOrderItem = {
  name: string;
  dosage?: string;
  variant?: string;
  price: number;
  quantity: number;
  type: string;
  shopProductId?: string;
  isNasalSpray?: boolean;
  isNasalDiySet?: boolean;
  isPlugPlay?: boolean;
  isFreeGift?: boolean;
};

export type BacEligibilityArticle = {
  sku?: string | null;
  shopProductId?: string | null;
  category?: string | null;
  categories?: unknown;
};

function normalise(value: string | null | undefined): string {
  return String(value || "").trim().toLocaleLowerCase("de-DE");
}

function articleCategories(article: BacEligibilityArticle | undefined): string[] {
  if (!article) return [];
  const categories = Array.isArray(article.categories)
    ? article.categories.filter((value): value is string => typeof value === "string")
    : [];
  if (article.category && !categories.includes(article.category)) categories.push(article.category);
  return categories;
}

function findArticleForItem(item: CheckoutOrderItem, catalog: BacEligibilityArticle[]): BacEligibilityArticle | undefined {
  const itemProductId = normalise(item.shopProductId);
  if (itemProductId) {
    const bySku = catalog.find((article) => normalise(article.sku) === itemProductId);
    if (bySku) return bySku;
    const byShopProductId = catalog.find((article) => normalise(article.shopProductId) === itemProductId);
    if (byShopProductId) return byShopProductId;
  }
  return undefined;
}

function isVialForm(item: CheckoutOrderItem, article: BacEligibilityArticle | undefined): boolean {
  if (item.type !== "peptide") return false;
  if (item.isFreeGift || item.isNasalSpray || item.isNasalDiySet || item.isPlugPlay) return false;
  const isBundlePosition = item.variant?.startsWith("Bundle:") === true;
  return !articleCategories(article).some((category) =>
    NON_VIAL_CATEGORIES.has(category) && !(isBundlePosition && category === "Forscher-Bundles"),
  );
}

function isGeneratedFreeBacWater(item: CheckoutOrderItem): boolean {
  return item.isFreeGift === true
    && Number(item.price) === 0
    && normalise(item.shopProductId) === FREE_BAC_WATER_PRODUCT_ID
    && normalise(item.name) === "bac wasser 3ml (gratis)";
}

/**
 * Reconciles the auto-generated 3 ml BAC gift against the authoritative product catalogue.
 * The customer may receive one only per qualifying peptide vial. Cosmetics, pens, nasal
 * products, tablets, accessories and bundles that contain those forms never qualify.
 *
 * The browser's generated free line is deliberately not trusted. This protects the actual
 * order even if a stale cart classified a cosmetic product as a peptide.
 */
export function reconcileFreeBacWaterForShopOrder(
  items: CheckoutOrderItem[],
  catalog: BacEligibilityArticle[],
): CheckoutOrderItem[] {
  const normalItems = items.filter((item) => !isGeneratedFreeBacWater(item));
  const eligibleUnits = normalItems.reduce((sum, item) => {
    const article = findArticleForItem(item, catalog);
    const isBundleVial = item.variant?.startsWith("Bundle:") === true;
    return isVialForm(item, article) && (isBundleVial || Number(item.price) >= FREE_BAC_WATER_THRESHOLD)
      ? sum + Math.max(0, Number(item.quantity) || 0)
      : sum;
  }, 0);

  if (eligibleUnits === 0) return normalItems;

  return [
    ...normalItems,
    {
      name: "BAC Wasser 3ml (GRATIS)",
      dosage: "",
      variant: "3ml",
      price: 0,
      quantity: eligibleUnits,
      type: "accessory",
      shopProductId: FREE_BAC_WATER_PRODUCT_ID,
      isNasalSpray: false,
      isNasalDiySet: false,
      isPlugPlay: false,
      isFreeGift: true,
    },
  ];
}
