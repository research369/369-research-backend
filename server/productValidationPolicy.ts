export type ProductValidationCategoryInput = {
  category?: string | null;
  categories?: unknown;
};

/**
 * Cosmetic products are governed by cosmetic product requirements rather than
 * research-only peptide metadata. The decision is driven by the persisted
 * category taxonomy, never by an individual product name or SKU.
 */
export function requiresResearchOnlyValidation(input: ProductValidationCategoryInput): boolean {
  const categories = Array.isArray(input.categories)
    ? input.categories.filter((value): value is string => typeof value === "string")
    : [];

  return input.category !== "369 BeautyLine" && !categories.includes("369 BeautyLine");
}
