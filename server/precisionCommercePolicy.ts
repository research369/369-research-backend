import type { CheckoutOrderItem } from "./freeBacWaterService.js";
import type { MainshopCatalogArticle } from "./mainshopCanonicalPricing.js";
import { NASAL_DIY_SET_COMPONENTS } from "./nasalDiySetConfig.js";
export const PRECISION_CARTRIDGE_FAMILIES = new Set([
  "3g-triple-g", "tirzepatide", "cagrilinitide", "eloralintide", "mots-c", "ss-31", "nad-plus", "5-amino-1mq", "tb-500", "ghk-cu", "pt-141", "tesamorelin", "cjc-ipamorelin-kombi",
]);
export const PRECISION_NASAL_FAMILIES = new Set(["semax", "selank", "adamax", "oxytocin", "pt-141", "kisspeptin-10", "semax-selank"]);
const nonVial = /nasenspray|nasal\s*spray|fertigpen|forscherpen|patrone|cartridge|kapsel|tablett|beautyline|kosmetik|cosmetic|\bserum\b|\bdiy\b|bac[\s-]*(?:wasser|water)|starterset|nadeln?|kanülen?|spritze|flasche|bottle/i;
const excludedCategories = new Set(["nasensprays", "nasal spray", "fertigpens", "forscherpens", "kapseln / tabletten", "tabletten", "kapseln", "369 beautyline", "forscher-bundles", "zubehör", "accessories", "lab / research supplies"]);
function ordinaryVial(a: MainshopCatalogArticle): boolean {
  const primary = String(a.category || "").toLowerCase();
  const categories = [primary, ...(Array.isArray(a.categories) ? a.categories : [])].map(c => String(c).toLowerCase());
  return !nonVial.test(a.name) && !categories.some(c => excludedCategories.has(c) && !(c === "nasensprays" && primary !== "nasensprays"));
}
/** Actual catalog resolution supplies identity; no SKU-prefix/name/client-type inference. */
export function precisionFormat(line: CheckoutOrderItem, parent: MainshopCatalogArticle, article: MainshopCatalogArticle) {
  const cartridge = line.isPlugPlay === true, nasal = line.isNasalSpray === true, kit = line.isNasalDiySet === true;
  const described = /nasenspray|nasal\s*spray|\bdiy\b|plug\s*(?:&|and|und)?\s*play|patrone|cartridge/i.test(line.variant || "");
  if ((cartridge && (nasal || kit)) || nasal !== kit || (described && !cartridge && !kit)) throw Error("PRECISION_CHECKOUT_FORMAT_INVALID");
  if (!cartridge && !kit) return { isPlugPlay: false, isNasalSpray: false, isNasalDiySet: false };
  const family = parent.shopProductId;
  if (!family || article.shopProductId !== family || !ordinaryVial(parent) || !ordinaryVial(article)) throw Error("PRECISION_CHECKOUT_FORMAT_UNSUPPORTED");
  if (!(cartridge ? PRECISION_CARTRIDGE_FAMILIES : PRECISION_NASAL_FAMILIES).has(family)) throw Error("PRECISION_CHECKOUT_FORMAT_UNSUPPORTED");
  return { isPlugPlay: cartridge, isNasalSpray: kit, isNasalDiySet: kit };
}
const dosage10 = (a: MainshopCatalogArticle) => {
  const named = a.name.match(/\b(\d+(?:\.\d+)?)\s*ml\s*\)?$/i)?.[1];
  const sku = a.sku.match(/-(\d+(?:\.\d+)?)ML$/i)?.[1];
  return (named !== undefined || sku !== undefined) && (named === undefined || named === "10") && (sku === undefined || sku === "10");
};
/** BAC10 is the existing exact family plus 10ml dosage, never BAC3 or a hidden replacement.
 * Multiple rows/ambiguous publication are not silently resolved with LIMIT 1. */
export function precisionBac10(catalog: MainshopCatalogArticle[]): MainshopCatalogArticle {
  const family = catalog.filter(a => a.shopProductId === "bac-wasser");
  const candidates = family.filter(a => a.isActive === 1 && dosage10(a));
  if (candidates.length !== 1 || family.some(a => a !== candidates[0] && dosage10(a))) throw Error("PRECISION_CHECKOUT_BAC10_INVENTORY_REQUIRED");
  const selected = candidates[0];
  if (!Number.isSafeInteger(selected.stock) || Number(selected.stock) < 0 || !["zubehör", "accessories", "lab / research supplies"].includes(String(selected.category).toLowerCase())) throw Error("PRECISION_CHECKOUT_BAC10_INVENTORY_REQUIRED");
  return selected;
}
export const PRECISION_UNTRACKED_KIT_COMPONENTS = NASAL_DIY_SET_COMPONENTS.filter(c => !c.inventoryTracked);
