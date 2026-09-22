export type OrderItemArticleIdentity = {
  sku: string;
  shopProductId: string | null;
};

/**
 * Smart Substitution is indexed by a canonical shop product family. Older
 * bundle carts can still submit the selected inventory SKU as shopProductId;
 * retain that exact SKU for matching, but resolve the canonical family before
 * asking the substitution engine for an alternative fulfillment plan.
 */
export function resolveSubstitutionProductFamily(
  submittedShopProductId: string | undefined,
  matchingArticles: OrderItemArticleIdentity[],
): string | null {
  const submitted = submittedShopProductId?.trim();
  if (!submitted) return matchingArticles[0]?.shopProductId ?? null;

  const directSkuArticle = matchingArticles.find(
    (article) => article.sku.trim().toLowerCase() === submitted.toLowerCase(),
  );

  return directSkuArticle?.shopProductId ?? submitted;
}
