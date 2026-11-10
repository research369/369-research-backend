import { createHash } from "node:crypto";
import { canonicalIntent } from "./priorityOrderIntegrity.js";
import { roundMoney, parsePromoMetadata, normalizeKwkPhone, resolveShippingRegion, type KwkCatalogArticle, type PromoDefinition } from "./kwkCheckoutPricing.js";
import { PLUGPLAY_SURCHARGE, NASAL_DIY_SET_SURCHARGE } from "./checkoutFormatSurcharges.js";
import { isNasalDiySetEligible, NASAL_DIY_SET_COMPONENTS } from "./nasalDiySetConfig.js";
import type { CheckoutOrderItem } from "./freeBacWaterService.js";
import { calculateCheckoutV2AutomaticGiftLines, type CheckoutV2Promotion2for3 } from "./checkoutV2AutomaticBenefits.js";
import { resolveSubstitution, extractDosageMg, isSubstitutionEligible, type SubstitutionResult } from "./substitutionService.js";
import { resolveSubstitutionProductFamily } from "./orderItemIdentity.js";

export type MainshopCatalogArticle = KwkCatalogArticle & { id: number; category: string | null; categories: unknown; stock?: number | null };
export type MainshopLine = CheckoutOrderItem & { bundleId?: number; bundleGroup?: string; canonicalProductId?: string; canonicalVariantId?: string };
export type MainshopBundle = { id: number; name: string; discountPercent: string; isActive: number; allowsPlugPlay: number; allowsNasalSpray: number };
export type MainshopBundleComponent = { bundleId: number; articleSku: string; quantity: number; isFreeGift: number; fixedDosageMg: number | null };
const norm = (v: unknown) => String(v ?? "").trim().toLocaleLowerCase("de-DE");
const dosage = (v: unknown) => norm(v).replace(/\s/g, "");
type Variant = Record<string, unknown>;
const variants = (a: MainshopCatalogArticle): Variant[] => Array.isArray(a.variants) ? a.variants.filter((v): v is Variant => !!v && typeof v === "object") : [];
const variantDosage = (v: Variant) => dosage(v.dosage ?? v.label ?? v.name);
const articleDosage = (a: MainshopCatalogArticle) => dosage(a.name.match(/(\d+(?:\.\d+)?\s*(?:mg|iu|ml|mcg))\s*\)?\s*$/i)?.[1] || a.sku.match(/-(\d+(?:\.\d+)?(?:MG|IU|ML|MCG))$/i)?.[1]);
export function catalogCategories(a: MainshopCatalogArticle): string[] {
  return [a.category, ...(Array.isArray(a.categories) ? a.categories : [])].filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}
type ResolvedSelection = { article: MainshopCatalogArticle; parent: MainshopCatalogArticle; configured?: Variant; selectedDosage: string; variantId: string };
/** Only an active visible parent can publish a selection. Hidden inventory children need its exact variant proof. */
function resolveSelection(line: MainshopLine, catalog: MainshopCatalogArticle[]): ResolvedSelection {
  const id = norm(line.shopProductId);
  if (!id) throw Error("CHECKOUT_CATALOG_IDENTITY_INVALID");
  const exactMatches = catalog.filter(a => norm(a.sku) === id && a.isActive === 1);
  if (exactMatches.length > 1) throw Error("CHECKOUT_CATALOG_IDENTITY_AMBIGUOUS");
  const exact = exactMatches[0];
  const familyId = norm(exact?.shopProductId) || (!exact ? id : "");
  const family = catalog.filter(a => a.isActive === 1 && (familyId ? norm(a.shopProductId) === familyId : a === exact));
  const visible = family.filter(a => a.shopVisible === 1);
  // A full family configuration wins over standalone child configurations. Ties fail closed.
  const configuredParents = visible.filter(a => variants(a).length > 0);
  const maxVariants = Math.max(0, ...configuredParents.map(a => variants(a).length));
  const parents = maxVariants ? configuredParents.filter(a => variants(a).length === maxVariants) : visible;
  if (parents.length !== 1) throw Error(parents.length ? "CHECKOUT_CATALOG_IDENTITY_AMBIGUOUS" : "CHECKOUT_CATALOG_NOT_VISIBLE");
  const parent = parents[0];
  if (!catalogCategories(parent).length) throw Error("CHECKOUT_CATALOG_CATEGORY_REQUIRED");
  const wanted = dosage(line.dosage) || (exact ? articleDosage(exact) : "") || (variants(parent).length === 1 ? variantDosage(variants(parent)[0]) : articleDosage(parent));
  if (!wanted && variants(parent).length > 1) throw Error("CHECKOUT_CATALOG_VARIANT_REQUIRED");
  const configuredMatches = variants(parent).filter(v => variantDosage(v) === wanted);
  if (configuredMatches.length > 1) throw Error("CHECKOUT_CATALOG_VARIANT_AMBIGUOUS");
  const configured = configuredMatches[0];
  if (variants(parent).length && !configured) throw Error("CHECKOUT_CATALOG_VARIANT_INVALID");
  let selected = parent;
  if (configured?.sku) {
    const candidates = family.filter(a => norm(a.sku) === norm(configured.sku));
    if (candidates.length !== 1) throw Error("CHECKOUT_CATALOG_VARIANT_INVENTORY_REQUIRED");
    selected = candidates[0];
    if (articleDosage(selected) && articleDosage(selected) !== wanted) throw Error("CHECKOUT_CATALOG_VARIANT_INVALID");
  } else if (wanted) {
    const candidates = family.filter(a => articleDosage(a) === wanted);
    if (candidates.length !== 1) throw Error("CHECKOUT_CATALOG_VARIANT_INVENTORY_REQUIRED");
    selected = candidates[0];
  }
  if (exact && exact !== selected) throw Error("CHECKOUT_CATALOG_SKU_DOSAGE_MISMATCH");
  if (selected !== parent && !configured) throw Error("CHECKOUT_CATALOG_VARIANT_INVALID");
  if (wanted && articleDosage(selected) && articleDosage(selected) !== wanted) throw Error("CHECKOUT_CATALOG_VARIANT_INVALID");
  return { article: selected, parent, configured, selectedDosage: wanted, variantId: familyId && wanted ? `${familyId}-${wanted}` : norm(selected.sku) };
}
export function mainshopArticleForLine(line: MainshopLine, catalog: MainshopCatalogArticle[]): MainshopCatalogArticle { return resolveSelection(line, catalog).article; }
function nonVial(a: MainshopCatalogArticle): boolean {
  return catalogCategories(a).some(c => ["nasensprays", "fertigpens", "forscherpens", "kapseln / tabletten", "tabletten", "kapseln", "369 beautyline", "zubehör"].includes(norm(c)));
}
// Existing shop Plug&Play exclusions, now evaluated exclusively on canonical identities/categories.
const plugExcluded = new Set(["369-retinal-shot", "369-deep-collagen-mask", "perfect-skin-bundle", "selank", "semax", "oxytocin", "adamax", "semax-selank", "melanotan-1", "melanotan-2", "dsip", "snap-8", "snap8", "peptidpen-case", "pen-kartusche-5er", "pen-nadeln-10er"]);
function canonicalFormat(line: MainshopLine, selection: ResolvedSelection) {
  if ([line.isPlugPlay, line.isNasalDiySet, line.isNasalSpray].filter(Boolean).length > 1) throw Error("CHECKOUT_FORMAT_AMBIGUOUS");
  const { parent, article } = selection;
  const cats = catalogCategories(parent).map(norm);
  const nasal = cats.includes("nasensprays") || catalogCategories(article).map(norm).includes("nasensprays");
  const id = norm(parent.shopProductId || parent.sku);
  const plugIncluded = [id, norm(article.sku)].some(v => ["klow-stack", "klow-stack-80mg"].includes(v));
  if (line.isNasalSpray && !nasal) throw Error("CHECKOUT_FORMAT_UNSUPPORTED");
  if (line.isPlugPlay && (nonVial(parent) || nonVial(article) || [id, norm(article.sku)].some(v => plugExcluded.has(v)) || (!plugIncluded && cats.includes("forscher-bundles")))) throw Error("CHECKOUT_FORMAT_UNSUPPORTED");
  if (line.isNasalDiySet && (nonVial(parent) || nonVial(article) || !isNasalDiySetEligible(id))) throw Error("CHECKOUT_FORMAT_UNSUPPORTED");
  return { isPlugPlay: line.isPlugPlay === true, isNasalDiySet: line.isNasalDiySet === true, isNasalSpray: nasal };
}
function priceValue(v: unknown): number {
  if (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) || Number(v) < 0) throw Error("CHECKOUT_CATALOG_PRICE_REQUIRED");
  return Number(v);
}
/** Sale is scoped to the selected inventory SKU, never the other dosage's parent sale. Bundles use full configured prices. */
function selectionPrice(selection: ResolvedSelection, format: ReturnType<typeof canonicalFormat>, bundle: boolean): { base: number; surcharge: number } {
  const { article, configured } = selection;
  const base = !bundle && article.salePrice !== null && article.salePrice !== undefined && Number(article.salePrice) > 0
    ? priceValue(article.salePrice) : configured ? priceValue(configured.price) : priceValue(article.sellingPrice);
  return { base, surcharge: (format.isPlugPlay ? PLUGPLAY_SURCHARGE : 0) + (format.isNasalDiySet ? NASAL_DIY_SET_SURCHARGE : 0) };
}
function isPen(a: MainshopCatalogArticle): boolean {
  return [norm(a.sku), norm(a.shopProductId)].some(id => ["369pen", "forscherpen", "peptidpen-case"].includes(id));
}
function quantityEligible(a: MainshopCatalogArticle): boolean { return isPen(a) || (!nonVial(a) && ![norm(a.sku), norm(a.shopProductId)].some(id => ["bac-wasser", "bac-wasser-3ml", "bac-3ml"].includes(id))); }
function canonicalType(a: MainshopCatalogArticle): string { return nonVial(a) ? "accessory" : "peptide"; }
/** The only bundle authority is the active WaWi definition and its complete composition. */
export function canonicalizeMainshopLines(input: MainshopLine[], catalog: MainshopCatalogArticle[], bundles: MainshopBundle[], components: MainshopBundleComponent[], promotion2for3: CheckoutV2Promotion2for3 = { enabled: false, mode: "all", products: [] }): { items: MainshopLine[]; quantityUnits: number; quantityEligible: boolean[] } {
  const raw = input.filter(i => !(i.isFreeGift && norm(i.shopProductId) === "bac-wasser-3ml" && i.bundleId === undefined));
  const claimedGifts = raw.filter(i => i.isFreeGift && i.bundleId === undefined);
  const paid = raw.filter(i => !i.isFreeGift || i.bundleId !== undefined);
  if (!paid.length) throw Error(claimedGifts.length ? "CHECKOUT_UNTRUSTED_GIFT" : "CHECKOUT_EMPTY_CART");
  const selections = paid.map(i => resolveSelection(i, catalog));
  const prices = selections.map((s, n) => selectionPrice(s, canonicalFormat(paid[n], s), paid[n].bundleId !== undefined));
  const items: MainshopLine[] = paid.map((i, n) => {
    if (!Number.isSafeInteger(i.quantity) || i.quantity <= 0) throw Error("CHECKOUT_QUANTITY_INVALID");
    if ((i.bundleId === undefined) !== (i.bundleGroup === undefined)) throw Error("CHECKOUT_BUNDLE_IDENTITY_REQUIRED");
    const s = selections[n];
    return { ...i, ...canonicalFormat(i, s), name: s.article.name, type: canonicalType(s.parent), dosage: s.selectedDosage.replace(/(\d)(mg|iu|ml|mcg)$/, "$1 $2") || undefined, shopProductId: s.article.sku, canonicalProductId: s.parent.shopProductId || s.parent.sku, canonicalVariantId: s.variantId, variant: i.bundleId === undefined ? undefined : i.variant, isFreeGift: false, price: roundMoney(prices[n].base + prices[n].surcharge) };
  });
  let quantityUnits = 0;
  const eligible = selections.map(s => quantityEligible(s.parent) && (s.article === s.parent || quantityEligible(s.article)));
  const groups = new Map<string, number[]>();
  items.forEach((i, n) => {
    if (i.bundleId !== undefined) { const key = `${i.bundleId}:${i.bundleGroup}`; groups.set(key, [...(groups.get(key) || []), n]); }
    else if (eligible[n]) quantityUnits += i.quantity;
  });
  for (const indexes of groups.values()) {
    const first = items[indexes[0]];
    const bundle = bundles.find(b => b.id === first.bundleId && b.isActive === 1);
    const definition = components.filter(c => c.bundleId === first.bundleId);
    if (!bundle || !definition.length || indexes.length !== definition.length) throw Error("CHECKOUT_BUNDLE_COMPOSITION_INVALID");
    let copies: number | undefined;
    const used = new Set<number>();
    for (const n of indexes) {
      const a = selections[n].article;
      const candidates = definition.map((c, k) => ({ c, k })).filter(({ c, k }) => !used.has(k) && (norm(c.articleSku) === norm(a.sku) || catalog.some(base => base.isActive === 1 && norm(base.sku) === norm(c.articleSku) && norm(base.shopProductId) && norm(base.shopProductId) === norm(a.shopProductId))));
      if (candidates.length !== 1) throw Error("CHECKOUT_BUNDLE_COMPOSITION_INVALID");
      const { c, k } = candidates[0]; used.add(k);
      const count = items[n].quantity / c.quantity;
      if (!Number.isSafeInteger(count) || count <= 0 || (copies !== undefined && copies !== count)) throw Error("CHECKOUT_BUNDLE_QUANTITY_INVALID");
      copies = count;
      if (c.fixedDosageMg !== null && dosage(items[n].dosage) !== `${c.fixedDosageMg}mg`) throw Error("CHECKOUT_BUNDLE_VARIANT_INVALID");
      if ((items[n].isPlugPlay && !bundle.allowsPlugPlay) || ((items[n].isNasalSpray || items[n].isNasalDiySet) && !bundle.allowsNasalSpray)) throw Error("CHECKOUT_BUNDLE_FORMAT_INVALID");
      items[n].variant = `Bundle: ${bundle.name}${items[n].dosage ? ` (${items[n].dosage})` : ""}`;
      items[n].isFreeGift = c.isFreeGift === 1;
      // WaWi bundle base: selling/configured variant price, never an additional discount on a sale. Format is outside bundle reduction.
      items[n].price = c.isFreeGift ? 0 : roundMoney(prices[n].base * (1 - Number(bundle.discountPercent) / 100) + prices[n].surcharge);
      if (!Number.isFinite(items[n].price) || items[n].price < 0 || Number(bundle.discountPercent) > 100 || Number(bundle.discountPercent) < 0) throw Error("CHECKOUT_BUNDLE_PRICE_INVALID");
      eligible[n] = Number(bundle.discountPercent) > 0 ? false : eligible[n];
    }
    quantityUnits += copies || 0;
  }
  // Reuse the existing promotion policy; never accept a zero-price client authority.
  const gifts: MainshopLine[] = [];
  items.forEach((item, n) => {
    if (item.bundleId !== undefined || item.isFreeGift) return;
    const parent = selections[n].parent;
    const derived = calculateCheckoutV2AutomaticGiftLines({
      lines: [{ ...item, shopProductId: item.canonicalProductId!, unitPrice: item.price, type: item.type === "peptide" ? "peptide" : "accessory", category: parent.category, categories: parent.categories, isPlugPlay: item.isPlugPlay === true, isNasalSpray: item.isNasalSpray === true, isNasalDiySet: item.isNasalDiySet === true }],
      promotion2for3, freeBacWaterProduct: { name: "BAC Wasser 3ml" },
    }).find(g => g.source === "promo_2for3");
    if (derived) gifts.push({ ...item, quantity: derived.quantity, price: 0, isFreeGift: true, variant: "2für3" });
  });
  const claimedCounts = new Map<string, number>();
  for (const gift of claimedGifts) {
    const resolved = resolveSelection(gift, catalog);
    canonicalFormat(gift, resolved);
    if (gift.isPlugPlay || gift.isNasalSpray || gift.isNasalDiySet) throw Error("CHECKOUT_UNTRUSTED_GIFT");
    const key = `${norm(resolved.article.sku)}:${resolved.selectedDosage}`;
    claimedCounts.set(key, (claimedCounts.get(key) || 0) + gift.quantity);
  }
  for (const [key, count] of claimedCounts) {
    const allowed = gifts.filter(g => `${norm(g.shopProductId)}:${dosage(g.dosage)}` === key).reduce((sum, g) => sum + g.quantity, 0);
    if (count !== allowed || !allowed) throw Error("CHECKOUT_UNTRUSTED_GIFT");
  }
  items.push(...gifts); eligible.push(...gifts.map(() => false));
  return { items, quantityUnits, quantityEligible: eligible };
}
/** Pure shared fulfillment plan, checked before quote/create and under inventory locks.
 * Canonical customer selections/prices stay unchanged; only existing Smart-Sub components may fulfill them. */
export function assertMainshopStock(items: MainshopLine[], catalog: MainshopCatalogArticle[], substitutionEnabled = false): Map<string, SubstitutionResult> {
  const demand = new Map<string, number>();
  const add = (sku: string, count: number) => demand.set(norm(sku), (demand.get(norm(sku)) || 0) + count);
  const trackedSkus = new Set<string>();
  const trackedComponent = (id: string, count: number) => {
    const matches = catalog.filter(a => a.isActive === 1 && norm(a.shopProductId) === norm(id));
    if (matches.length !== 1) throw Error("CHECKOUT_STOCK_COMPONENT_REQUIRED");
    trackedSkus.add(norm(matches[0].sku));
    add(matches[0].sku, count);
  };
  for (const item of items) {
    if (!item.shopProductId) throw Error("CHECKOUT_STOCK_IDENTITY_REQUIRED");
    add(item.shopProductId, item.quantity);
    if (item.isNasalSpray && !item.isNasalDiySet) trackedComponent("bac-wasser", item.quantity);
    if (item.isNasalDiySet) for (const c of NASAL_DIY_SET_COMPONENTS) if (c.inventoryTracked) trackedComponent(c.articleShopProductId, item.quantity);
  }
  const active = catalog.filter(a => a.isActive === 1);
  const available = new Map(active.map(a => [norm(a.sku), Number.isSafeInteger(a.stock) && Number(a.stock) >= 0 ? Number(a.stock) : 0]));
  const eligible = (a: MainshopCatalogArticle) => catalogCategories(a).every(isSubstitutionEligible);
  const pending: Array<{ article: MainshopCatalogArticle; count: number }> = [];
  const substitutions = new Map<string, SubstitutionResult>();
  const fail = (sku: string): never => { throw Error(`CHECKOUT_STOCK_DEMAND_NOT_COVERED: ${sku} (Bestand)`); };
  // Reserve ALL directly fulfillable demand first, including paid/free BAC and
  // tracked kit components. Substitution may only consume the remaining pool.
  for (const [sku, count] of demand) {
    const matches = active.filter(a => norm(a.sku) === sku);
    if (matches.length !== 1 || !Number.isSafeInteger(count) || count <= 0 || !Number.isSafeInteger(matches[0].stock) || Number(matches[0].stock) < 0) fail(sku);
    const article = matches[0];
    if (Number(article.stock) >= count) available.set(sku, Number(article.stock) - count);
    else {
      if (substitutionEnabled !== true || trackedSkus.has(sku) || !eligible(article)) fail(sku);
      pending.push({ article, count });
    }
  }
  for (const { article, count } of pending) {
    const sku = norm(article.sku);
    const family = resolveSubstitutionProductFamily(article.sku, [article]);
    const selection = items.find(item => norm(item.shopProductId) === sku)!;
    const dosageMg = extractDosageMg(selection.dosage || article.name) ?? extractDosageMg(article.sku);
    if (!family || dosageMg === null) return fail(sku);
    if (dosageMg <= 0 || active.some(a => a.shopProductId === family && a.shopVisible === 1 && !eligible(a))) fail(sku);
    // Existing resolver replaces the WHOLE unavailable selection, not a partial
    // direct/alternative mix. Do not invent a new stock or dosage fallback here.
    const sub = resolveSubstitution(family, dosageMg, count, active.filter(a =>
      eligible(a) && Number.isSafeInteger(a.stock) && Number(a.stock) >= 0 &&
      active.filter(other => norm(other.sku) === norm(a.sku)).length === 1
    ).map(a => ({ ...a, stock: available.get(norm(a.sku)) ?? 0 })));
    if (!sub.possible) fail(sku);
    for (const component of sub.components) {
      const key = norm(component.sku);
      const remaining = (available.get(key) ?? 0) - component.quantity;
      if (remaining < 0) fail(sku);
      available.set(key, remaining);
    }
    substitutions.set(sku, sub);
  }
  return substitutions;
}
/** Normalized original business selection. Browser totals/type/name are not authorities; ephemeral proofs never enter this object. */
export function mainshopBusinessIntent(input: {
  customer: Record<string, unknown>; items: MainshopLine[]; discountCode?: string | null; partnerCode?: string | null; partnerNumber?: string | null; kwkCode?: string | null;
  creditUsed?: number; kwkCreditUsed?: number; paymentMethod: string; communicationLanguage?: string; internalNote?: string;
}) {
  const customer = Object.fromEntries(["firstName", "lastName", "email", "street", "houseNumber", "zip", "city", "company", "deliveryType", "dhlPostNumber"].map(k => [k, norm(input.customer[k]).replace(/\s+/g, " ")]));
  return {
    customer: { ...customer, phone: normalizeKwkPhone(String(input.customer.phone || "")), country: norm(input.customer.country), shippingRegion: resolveShippingRegion(String(input.customer.country || "")) },
    items: input.items.filter(i => !(i.isFreeGift && norm(i.shopProductId) === "bac-wasser-3ml" && i.bundleId === undefined)).map(i => ({
      shopProductId: norm(i.shopProductId), dosage: dosage(i.dosage), variant: norm(i.variant), quantity: i.quantity, bundleId: i.bundleId, bundleGroup: i.bundleGroup,
      isPlugPlay: i.isPlugPlay === true, isNasalDiySet: i.isNasalDiySet === true, isNasalSpray: i.isNasalSpray === true, isFreeGift: i.isFreeGift === true,
    })),
    codes: { promo: norm(input.discountCode), partner: norm(input.partnerCode), partnerNumber: norm(input.partnerNumber), kwk: norm(input.kwkCode) },
    requestedCredits: { partner: roundMoney(input.creditUsed || 0), kwk: roundMoney(input.kwkCreditUsed || 0) }, paymentMethod: input.paymentMethod,
    communicationLanguage: input.communicationLanguage || "de", internalNote: input.internalNote || "",
  };
}
/** Cent-conserving allocation: deterministic largest remainder; never proportional across excluded lines. */
export function allocateMoney(amount: number, values: number[]): number[] {
  const cents = Math.round(roundMoney(amount) * 100);
  const weights = values.map(v => Math.max(0, Math.round(roundMoney(v) * 100)));
  const total = weights.reduce((a, b) => a + b, 0);
  if (!total || !cents) return values.map(() => 0);
  const shares = weights.map((w, n) => ({ n, base: Math.floor(cents * w / total), remainder: cents * w % total }));
  let remaining = cents - shares.reduce((sum, s) => sum + s.base, 0);
  for (const s of [...shares].sort((a, b) => b.remainder - a.remainder || a.n - b.n)) { if (remaining-- > 0) s.base++; }
  return shares.map(s => s.base / 100);
}
export function quantityPricing(items: MainshopLine[], eligible: boolean[], units: number) {
  const percentage = [[36, 35], [20, 30], [13, 25], [8, 20], [4, 10]].find(([min]) => units >= min)?.[1] || 0;
  const values = items.map(i => roundMoney(i.price * i.quantity));
  const eligibleValues = values.map((v, n) => eligible[n] && !items[n].isFreeGift ? v : 0);
  const amount = roundMoney(eligibleValues.reduce((a, b) => a + b, 0) * percentage / 100);
  const allocated = allocateMoney(amount, eligibleValues);
  return { percentage, units, amount, lineValues: values.map((v, n) => roundMoney(v - allocated[n])) };
}
export function mainshopPromoDiscount(items: MainshopLine[], remainingValues: number[], promo: PromoDefinition | null): number {
  if (!promo) return 0;
  const { restrict } = parsePromoMetadata(promo.description);
  const eligible = remainingValues.reduce((sum, value, n) => {
    const ids = [items[n].shopProductId, items[n].canonicalProductId, items[n].canonicalVariantId].filter(Boolean).map(norm);
    const matches = !restrict.length || restrict.some(r => ids.includes(norm(r)));
    return matches && !items[n].isFreeGift ? sum + value : sum;
  }, 0);
  return roundMoney(promo.discountType === "fixed" ? Math.min(Math.max(0, promo.fixedAmount), eligible) : eligible * Math.min(100, Math.max(0, promo.percentage)) / 100);
}
/** Restrict hash/locks to the actual selected families and tracked components, not the whole shop. */
export function mainshopCatalogScope(input: MainshopLine[], catalog: MainshopCatalogArticle[]): MainshopCatalogArticle[] {
  const selections = input.filter(i => !(i.isFreeGift && norm(i.shopProductId) === "bac-wasser-3ml" && i.bundleId === undefined)).map(i => resolveSelection(i, catalog));
  const families = new Set(selections.map(s => norm(s.parent.shopProductId)).filter(Boolean));
  const skus = new Set(selections.flatMap(s => [norm(s.parent.sku), norm(s.article.sku)]));
  return catalog.filter(a => families.has(norm(a.shopProductId)) || skus.has(norm(a.sku)) || ["bac-wasser-3ml", "bac-wasser"].includes(norm(a.shopProductId))).sort((a, b) => norm(a.sku).localeCompare(norm(b.sku)));
}
export function mainshopPolicySnapshot(input: MainshopLine[], catalog: MainshopCatalogArticle[], bundles: MainshopBundle[], components: MainshopBundleComponent[]) {
  const ids = new Set(input.map(i => i.bundleId).filter(v => v !== undefined));
  return {
    catalog: mainshopCatalogScope(input, catalog).map(a => ({ sku: a.sku, shopProductId: a.shopProductId, name: a.name, sellingPrice: a.sellingPrice, salePrice: a.salePrice, variants: a.variants, isActive: a.isActive, shopVisible: a.shopVisible, category: a.category, categories: a.categories })),
    bundles: bundles.filter(b => ids.has(b.id)).map(b => ({ id: b.id, name: b.name, discountPercent: b.discountPercent, isActive: b.isActive, allowsPlugPlay: b.allowsPlugPlay, allowsNasalSpray: b.allowsNasalSpray })).sort((a, b) => a.id - b.id),
    components: components.filter(c => ids.has(c.bundleId)).map(c => ({ bundleId: c.bundleId, articleSku: c.articleSku, quantity: c.quantity, isFreeGift: c.isFreeGift, fixedDosageMg: c.fixedDosageMg })).sort((a, b) => `${a.bundleId}:${a.articleSku}`.localeCompare(`${b.bundleId}:${b.articleSku}`)),
  };
}
export function quoteHash(value: unknown): string { return createHash("sha256").update(canonicalIntent(JSON.parse(JSON.stringify(value)))).digest("hex"); }
