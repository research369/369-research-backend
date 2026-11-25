import { normalizePublicCheckoutPricingOptions, resolveTrustedColdShippingItems, type ColdShippingCatalogArticle } from "./coldShippingCatalog.js";
import { NASAL_DIY_SET_SURCHARGE, isNasalDiySetEligible } from "./nasalDiySetConfig.js";

type SalesItem = { name?: string; variant?: string; type?: string; shopProductId?: string; isPlugPlay?: boolean; isNasalSpray?: boolean; isNasalDiySet?: boolean };
const key = (value: unknown) => String(value ?? "").trim().toLowerCase();

/** New sales only. Historical display/shipping/cancellation helpers are untouched. */
export function isReadyNasalArticle(article: ColdShippingCatalogArticle): boolean {
  const [form] = resolveTrustedColdShippingItems<SalesItem>([{ shopProductId: article.sku }], [article]);
  return form.isNasalSpray === true && form.isNasalDiySet !== true;
}

export function assertNewNasalSale(items: readonly SalesItem[], catalog: readonly ColdShippingCatalogArticle[]): void {
  for (const item of items) {
    const ref = key(item.shopProductId);
    const family = ref ? catalog.filter(a => key(a.sku) === ref || key(a.shopProductId) === ref) : [];
    // A catalogue-confirmed ready SKU cannot be relabelled or turned into a kit.
    if (family.some(isReadyNasalArticle)) throw Error("READY_NASAL_SALE_DISABLED");
    if (family.some(a => isNasalDiySetEligible(key(a.shopProductId)))
      && (item.isPlugPlay === true || /plug\s*(?:&|and|und)?\s*play|patrone|cartridge/i.test(`${item.name ?? ""} ${item.variant ?? ""}`))) throw Error("PRODUCT_FORM_UNAVAILABLE");
    const [option] = normalizePublicCheckoutPricingOptions([item], catalog);
    const [physical] = resolveTrustedColdShippingItems([item], catalog);
    const fixedKit = family.length > 0 && physical.isNasalDiySet === true && !option.isNasalDiySet;
    if (item.isNasalDiySet === true && !option.isNasalDiySet && !fixedKit) throw Error("NASAL_DIY_OPTION_UNAVAILABLE");
    if (option.isNasalDiySet && item.type !== undefined && item.type !== 'peptide') throw Error("NASAL_DIY_OPTION_UNAVAILABLE");
    // Both legacy flags are allowed for a VALIDATED DIY option or fixed kit.
    if (item.isNasalSpray === true && !option.isNasalDiySet && !fixedKit) throw Error("READY_NASAL_SALE_DISABLED");
    const descriptor = `${item.name ?? ""} ${item.variant ?? ""}`;
    const accessory = family.some(a => key(a.category) === "zubehör" || /leer\w*|empty|flasche|bottle/i.test(a.name));
    if (!accessory && /nasenspray|nasal\s*spray/i.test(descriptor) && !/diy/i.test(descriptor)
      && !option.isNasalDiySet && !fixedKit) throw Error("READY_NASAL_SALE_DISABLED");
  }
}

type ComponentArticle = { id: number; sku: string; shopProductId: string | null; name: string; isActive: number; stock: number };
/** Exact native identity, including inactive duplicates; never substitute 3 ml BAC. */
export function resolveNasalBacComponent<T extends ComponentArticle>(catalog: readonly T[], productId = "bac-wasser"): T {
  const choices = catalog.filter(a => key(a.shopProductId) === key(productId));
  const article = choices[0];
  if (choices.length !== 1 || article.isActive !== 1 || !Number.isSafeInteger(article.stock) || article.stock < 0
    || !/\b10\s*[- ]?\s*ml\b/i.test(`${article.name} ${article.sku}`)
    || /\b(?:3|5|20)\s*[- ]?\s*ml\b/i.test(`${article.name} ${article.sku}`)) throw Error("COMPONENT_INVENTORY_UNAVAILABLE");
  return article;
}

/** Additive per-variant public availability; stock is never taken from browser JSON. */
export function nasalDiySetAvailability<T extends ColdShippingCatalogArticle & ComponentArticle>(
  inventorySku: string, catalog: readonly T[],
): { nasalDiySet?: { eligible: boolean; inStock: boolean; stock: number; surcharge: number; stockDemands: { sku: string; quantity: number; stock: number }[] } } {
  const choices = catalog.filter(a => key(a.sku) === key(inventorySku));
  const article = choices[0];
  if (!article || ![article.shopProductId, article.sku].some(isNasalDiySetEligible)) return {};
  const [option] = normalizePublicCheckoutPricingOptions([{ shopProductId: inventorySku, isNasalDiySet: true }], catalog);
  const eligible = choices.length === 1 && article.isActive === 1 && option.isNasalDiySet === true;
  let stock = 0;
  const stockDemands: { sku: string; quantity: number; stock: number }[] = [];
  try {
    if (eligible && Number.isSafeInteger(article.stock) && article.stock >= 0) {
      const bac = resolveNasalBacComponent(catalog);
      stock = Math.min(article.stock, bac.stock);
      stockDemands.push({ sku: article.sku, quantity: 1, stock: article.stock }, { sku: bac.sku, quantity: 1, stock: bac.stock });
    }
  } catch { /* fail closed for DIY only */ }
  return { nasalDiySet: { eligible, inStock: stock > 0, stock, surcharge: NASAL_DIY_SET_SURCHARGE, stockDemands } };
}
