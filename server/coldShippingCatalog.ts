import { requiresColdChainShipping, type ShippingCheckoutItem } from "./kwkCheckoutPricing.js";
import { isNasalDiySetEligible } from "./nasalDiySetConfig.js";

export type ColdShippingCatalogArticle = {
  sku: string;
  shopProductId: string | null;
  name: string;
  category?: string | null;
  categories?: unknown;
  shopVisible?: number;
  isActive?: number;
};

type CatalogCheckoutItem = ShippingCheckoutItem & { shopProductId?: string };

function normalize(value: unknown): string {
  return String(value ?? "").trim().toLocaleLowerCase("de-DE");
}

// Mirrors client/src/lib/plugPlayConfig.ts; public flags do not authorize
// preparation of accessories, excluded peptides or non-vial product forms.
const plugPlayExcludedIds = new Set([
  "369-retinal-shot", "369-deep-collagen-mask", "perfect-skin-bundle",
  "selank", "semax", "oxytocin", "adamax", "semax-selank", "melanotan-1",
  "melanotan-2", "dsip", "snap-8", "snap8", "peptidpen-case",
  "pen-kartusche-5er", "pen-nadeln-10er",
]);
const plugPlayIncludedIds = new Set(["klow-stack", "klow-stack-80mg"]);
const nonVialCategories = new Set([
  "nasensprays", "fertigpens", "forscherpens", "kapseln / tabletten",
  "tabletten", "kapseln", "369 beautyline", "forscher-bundles", "zubehör",
]);
const plugPlayPattern = /plug\s*(?:&|and|und)?\s*play/i;
const accessoryPattern = /\bpen\b|\bpens\b|fertigpen|forscherpen|\bcase\b|\betui\b|\bleer\w*|\bempty\b|nadeln?|kanülen?|spritze|flasche|bottle/i;

function findArticle(item: CatalogCheckoutItem, catalog: readonly ColdShippingCatalogArticle[]) {
  const id = normalize(item.shopProductId);
  if (!id) return undefined;
  const family = catalog.filter((article) => article.isActive !== 0
    && (normalize(article.sku) === id || normalize(article.shopProductId) === id));
  return family.find((article) => normalize(article.sku) === id)
    ?? family.find((article) => article.shopVisible === 1)
    ?? family[0];
}

function resolveForms(item: CatalogCheckoutItem, article: ColdShippingCatalogArticle) {
  const categories = [article.category, ...(Array.isArray(article.categories) ? article.categories : [])]
    .map(normalize).filter(Boolean);
  const descriptor = `${normalize(article.name)} ${categories.join(" ")}`;
  const fixedDiy = descriptor.includes("diy");
  const accessory = accessoryPattern.test(article.name) || categories.includes("zubehör");
  // Use the same cartridge requirement as the canonical shipping helper.
  // Suppressing its nasal branch isolates Plug&Play form recognition.
  const fixedPlugPlay = !accessory && !fixedDiy
    && requiresColdChainShipping({ name: article.name, isNasalDiySet: true });
  const fixedNasal = !accessory && !fixedDiy
    && /nasenspray|nasal\s*spray/i.test(descriptor)
    && requiresColdChainShipping({ name: descriptor });
  const ids = [article.shopProductId, article.sku].map(normalize);
  const includedVial = ids.some((id) => plugPlayIncludedIds.has(id));
  const ordinaryVial = !fixedDiy && !fixedPlugPlay && !fixedNasal && !accessory
    && !/patrone|cartridge|kapsel|tablett|beautyline|kosmetik|cosmetic|\bserum\b|bac[\s-]*(?:wasser|water)/i.test(descriptor)
    && !categories.some((category) => nonVialCategories.has(category)
      && !(includedVial && category === "forscher-bundles"));
  const plugPlayEligible = ordinaryVial && !ids.some((id) => plugPlayExcludedIds.has(id));
  const legacyVariant = String(item.variant ?? "");
  const legacyPlugPlay = !accessoryPattern.test(legacyVariant) && (
    plugPlayPattern.test(legacyVariant)
    || requiresColdChainShipping({ name: item.name, isNasalDiySet: true })
  );
  const plugPlayOption = plugPlayEligible && (item.isPlugPlay === true || legacyPlugPlay);
  const nasalDiyEligible = ordinaryVial && ids.some((id) => isNasalDiySetEligible(id));
  // Cartridge and DIY preparation are mutually exclusive; the cartridge wins.
  const nasalDiyOption = !plugPlayOption && nasalDiyEligible && item.isNasalDiySet === true;
  return { fixedDiy, fixedPlugPlay, fixedNasal, plugPlayOption, nasalDiyOption };
}

/**
 * PUBLIC CHECKOUT ONLY: normalize requested, billable preparation options before
 * resolveAuthoritativeItemPrice/repricePublicCheckoutItems. Returns fresh items;
 * prices, names, dosage and custom variants are not changed here.
 *
 * isPlugPlay means the separate +15 vial option in this pricing projection, NOT
 * a fixed cartridge whose catalogue price already includes preparation.
 * isNasalDiySet means the validated separate +7 vial option, NOT a fixed DIY
 * catalogue product or ready nasal spray. Ready sprays cannot be relabelled DIY.
 *
 * For mandatory shipping (and persisted product-form flags), resolve the result
 * through resolveTrustedColdShippingItems. Never reprice that shipping projection:
 * fixed cartridges deliberately have isPlugPlay:true there. Unknown references
 * still require the independent catalogue rejection in authoritative repricing.
 * Do not apply this helper to authenticated manual/custom-price WaWi sales.
 */
export function normalizePublicCheckoutPricingOptions<T extends CatalogCheckoutItem>(
  items: readonly T[],
  catalog: readonly ColdShippingCatalogArticle[],
): T[] {
  return items.map((item) => {
    const article = findArticle(item, catalog);
    if (!article) return { ...item, isPlugPlay: false, isNasalSpray: false, isNasalDiySet: false };
    const forms = resolveForms(item, article);
    return {
      ...item,
      isPlugPlay: forms.plugPlayOption,
      isNasalSpray: forms.fixedNasal || forms.nasalDiyOption,
      isNasalDiySet: forms.nasalDiyOption,
    };
  });
}

/**
 * Catalogue-confirmed product forms and validated vial options for SHIPPING.
 * This is not a pricing projection: fixed prepared products require cooling but
 * must not receive another preparation surcharge. Source items are never mutated;
 * manual prices/custom display variants remain on the original order lines.
 * Names/variants in this decision-only projection may be sanitized to prevent
 * text fallback on unprepared accessories. Do not persist the whole projection;
 * use its trusted form flags alongside the separately repriced original fields.
 */
export function resolveTrustedColdShippingItems<T extends CatalogCheckoutItem>(
  items: readonly T[],
  catalog: readonly ColdShippingCatalogArticle[],
): T[] {
  return items.map((item) => {
    const article = findArticle(item, catalog);
    if (!article) return { ...item };
    const forms = resolveForms(item, article);
    // Do not let unvalidated public variant text trigger the generic helper's
    // historical cartridge/nasal fallback on pens, accessories or ordinary vials.
    const variantHasPreparation = plugPlayPattern.test(String(item.variant ?? ""))
      || /nasenspray|nasal\s*spray/i.test(String(item.variant ?? ""));
    const trustedVariant = variantHasPreparation
      && !forms.plugPlayOption && !forms.nasalDiyOption
      ? undefined : item.variant;
    const trustedName = !forms.fixedPlugPlay && !forms.fixedNasal
      && !forms.plugPlayOption && !forms.nasalDiyOption
      && requiresColdChainShipping({ name: article.name }) ? "" : article.name;
    return {
      ...item,
      name: trustedName,
      variant: trustedVariant,
      isPlugPlay: forms.fixedPlugPlay || forms.plugPlayOption,
      isNasalSpray: forms.fixedNasal || forms.nasalDiyOption,
      isNasalDiySet: forms.fixedNasal ? false : forms.fixedDiy || forms.nasalDiyOption,
    };
  });
}

export function catalogueRequiresColdShipping(
  items: readonly CatalogCheckoutItem[],
  catalog: readonly ColdShippingCatalogArticle[],
): boolean {
  return resolveTrustedColdShippingItems(items, catalog).some(requiresColdChainShipping);
}
