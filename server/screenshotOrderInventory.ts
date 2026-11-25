import { normalizePublicCheckoutPricingOptions, resolveTrustedColdShippingItems } from './coldShippingCatalog.js';
import { resolveAuthoritativeItemPrice, requiresColdChainShipping, roundMoney } from './kwkCheckoutPricing.js';
import { NASAL_DIY_SET_COMPONENTS, NASAL_DIY_SET_ELIGIBLE_PRODUCT_IDS } from './nasalDiySetConfig.js';
import { getPublicSingleBlendComposition } from './singleBlendComposition.js';
import { screenshotHash, type ScreenshotForm } from './screenshotOrderContract.js';
import { isReadyNasalArticle, resolveNasalBacComponent } from './nasalSalesPolicy.js';

// This route never expands blends or kits by parsing their names. A published
// inventory set is one physical SKU. Only the native tracked nasal kit/BAC
// contract creates implicit components; fixed DIY inventory is already a kit.
export const screenshotInventoryPolicy = {
  version: 3,
  vialOnly: ['somatide', 'somatide-15mg'],
  includedVial: ['klow-stack', 'klow-stack-80mg'],
  nasalEligible: [...NASAL_DIY_SET_ELIGIBLE_PRODUCT_IDS].sort(),
  nasalComponents: NASAL_DIY_SET_COMPONENTS,
};
export type ScreenshotPreparation = 'inventory' | 'plug_play_option' | 'nasal_diy_option';
export type ScreenshotStockDemand = { articleId: number; sku: string; quantity: number; stock: number };
export type ScreenshotStockPlan = { articleId: number; sku: string; quantity: number; expectedStock: number }[];
export type ScreenshotComponentLine = { name: string; variant: string; quantity: number; articleId: number | null; isNasalDiySet: boolean };
export type ScreenshotCandidate = {
  sku: string; name: string; dosage: string; form: ScreenshotForm; defaultForm: ScreenshotForm;
  preparation: ScreenshotPreparation; type: 'peptide' | 'cosmetic' | 'accessory' | 'other';
  price: number; stock: number; shopProductId: string; articleId: number; parentId: number;
  candidateKey: string; available: boolean; maxQuantity: number; mandatoryCold: boolean; coldShippingMandatory: boolean;
  isPlugPlay: boolean; isNasalSpray: boolean; isNasalDiySet: boolean;
  stockDemands: ScreenshotStockDemand[]; componentLines: ScreenshotComponentLine[]; dependencyIds: number[];
};
const key = (v: unknown) => String(v ?? '').trim().toLowerCase();
const strength = (v: unknown) => key(v).replace(/,/g, '.').replace(/\s+/g, '');
function dosage(a: any) { return String(a.name).match(/\((\d+(?:[.,]\d+)?\s*(?:mg|mcg|iu|ml))\)\s*$/i)?.[1] ?? String(a.name).match(/\b(\d+(?:[.,]\d+)?\s*(?:mg|mcg|iu|ml))\s*$/i)?.[1] ?? ''; }
function physicalForm(a: any): ScreenshotForm {
  const [trusted] = resolveTrustedColdShippingItems([{ name: a.name, shopProductId: a.sku, isPlugPlay:false,isNasalSpray:false,isNasalDiySet:false }], [a]);
  if (trusted.isPlugPlay) return 'plug_play';
  if (trusted.isNasalSpray || trusted.isNasalDiySet) return 'nasal';
  const categories = [a.category, ...(Array.isArray(a.categories) ? a.categories : [])].map(key);
  const includedVial=[a.sku,a.shopProductId].some(id=>screenshotInventoryPolicy.includedVial.includes(key(id)));
  if (categories.some(c=>['369 beautyline','zubehör','fertigpens','forscherpens','tabletten','kapseln / tabletten','kapseln'].includes(c)
    || (c==='forscher-bundles'&&!includedVial)) || key(a.category)==='nasensprays') return 'other';
  if (categories.some(c => /^(vials?|peptide.*)$/.test(c)) && !/kosmetik|cosmetic|serum|retinal|kapsel|tablett|cartridge|patrone|fertigpen|forscherpen|bac[\s-]*(wasser|water)/i.test(a.name)) return 'vial';
  // The canonical helper has exactly one approved category exception. Unknown
  // accessories/products must not become vials merely because they are not excluded.
  return includedVial ? 'vial' : 'other';
}
function articleType(a: any, form: ScreenshotForm): ScreenshotCandidate['type'] {
  if (form !== 'other') return 'peptide';
  const text = [a.category, ...(Array.isArray(a.categories) ? a.categories : []), a.name].join(' ');
  if (/beautyline|kosmetik|cosmetic|serum|collagen.?mask|retinal/i.test(text)) return 'cosmetic';
  if (/zubehör|accessor|bac[\s-]*(wasser|water)|pen|patrone|cartridge|nadel|spritze|kanüle|flasche|etui|case/i.test(text)) return 'accessory';
  return 'other';
}
function componentProjection(rows: any[], preparation: ScreenshotPreparation) {
  const demands: ScreenshotStockDemand[] = [], lines: ScreenshotComponentLine[] = [], ids: number[] = [];
  if (preparation === 'nasal_diy_option') {
    for (const component of NASAL_DIY_SET_COMPONENTS) {
      const a = component.inventoryTracked ? resolveNasalBacComponent(rows, component.articleShopProductId) : null;
      if (a) { demands.push({ articleId: a.id, sku: a.sku, stock: a.stock, quantity: 1 }); ids.push(a.id); }
      lines.push({ name: component.name, variant: component.variant, quantity: 1, articleId: a?.id ?? null, isNasalDiySet: true });
    }
  }
  return { demands, lines, ids };
}
/** Current published parent -> exact physical inventory -> permitted preparations. */
export function screenshotCatalogProjection(rows: any[]): ScreenshotCandidate[] {
  const duplicateSkus = new Set<string>(), seen = new Set<string>();
  for (const a of rows) { const k = key(a.sku); if (seen.has(k)) duplicateSkus.add(k); seen.add(k); }
  const result = new Map<string, ScreenshotCandidate>(), ambiguous = new Set<string>();
  const published = rows.filter(a => a.isActive === 1 && a.shopVisible === 1 && a.publishedAt && Number(a.sellingPrice) > 0
    && !isReadyNasalArticle(a)
    && !/\[draft\]|price[_ -]?open|open[_ -]?price/i.test([a.name, a.notes, JSON.stringify(a.description ?? {})].join(' '))
    && !(a.description as any)?.draftMeta
    && (a.shopProductId !== 'somatide' || getPublicSingleBlendComposition(a, rows)));
  for (const parent of published) {
    const family = rows.filter(a => parent.shopProductId ? a.shopProductId === parent.shopProductId : a.id === parent.id);
    const variants = Array.isArray(parent.variants) && parent.variants.length ? parent.variants : [{ label: dosage(parent), inventoryArticleId: parent.id }];
    for (const v of variants) {
      if (!v || v.hidden === true || v.isActive === false || v.isActive === 0 || v.price === null) continue;
      const label = String(v.dosage ?? v.label ?? v.name ?? dosage(parent));
      // Persisted IDs/SKUs lead. A dosage fallback must be exact and unambiguous.
      const choices = v.inventoryArticleId ? family.filter(a => a.id === Number(v.inventoryArticleId))
        : v.sku ? family.filter(a => key(a.sku) === key(v.sku)) : family.filter(a => strength(dosage(a)) === strength(label));
      if (choices.length !== 1) continue;
      const a = choices[0];
      if (a.isActive !== 1 || duplicateSkus.has(key(a.sku)) || Number(a.sellingPrice) <= 0 || !Number.isSafeInteger(a.stock)) continue;
      if (v.sku && key(v.sku) !== key(a.sku)) continue;
      if (isReadyNasalArticle(a)) continue;
      const defaultForm = physicalForm(a), type = articleType(a, defaultForm);
      const forms: { form: ScreenshotForm; preparation: ScreenshotPreparation }[] = [{ form: defaultForm, preparation: 'inventory' }];
      const vialOnly = [a.sku, a.shopProductId, parent.sku, parent.shopProductId].some(id => screenshotInventoryPolicy.vialOnly.includes(key(id)));
      if (defaultForm === 'vial' && !vialOnly) {
        const [p] = normalizePublicCheckoutPricingOptions([{ name: a.name, shopProductId: a.sku, isPlugPlay: true }], rows);
        if (p.isPlugPlay) forms.push({ form: 'plug_play', preparation: 'plug_play_option' });
        const [n] = normalizePublicCheckoutPricingOptions([{ name: a.name, shopProductId: a.sku, isNasalDiySet: true }], rows);
        if (n.isNasalDiySet) forms.push({ form: 'nasal', preparation: 'nasal_diy_option' });
      }
      for (const selected of forms) {
        const pricingItem = { name: a.name, shopProductId: a.sku, dosage: label, price: 0, quantity: 1,
          isNasalSpray:false, isPlugPlay: selected.preparation === 'plug_play_option', isNasalDiySet: selected.preparation === 'nasal_diy_option' };
        const [physical] = resolveTrustedColdShippingItems([pricingItem], rows);
        let price: number, components: ReturnType<typeof componentProjection>;
        try {
          // Use the same resolver as the existing exact-SKU quote; ready cartridge
          // flags are shipping-only and never passed into pricing again.
          price = resolveAuthoritativeItemPrice(pricingItem, rows);
          components = componentProjection(rows, selected.preparation);
        } catch { continue; }
        if (!Number.isFinite(price) || price <= 0) continue;
        const stockDemands = [{ articleId: a.id, sku: a.sku, quantity: 1, stock: a.stock }, ...components.demands];
        const grouped = new Map<number, ScreenshotStockDemand>();
        for (const d of stockDemands) { const old = grouped.get(d.articleId); grouped.set(d.articleId, { ...d, quantity: (old?.quantity ?? 0) + d.quantity }); }
        const demands = [...grouped.values()].sort((a,b) => a.articleId-b.articleId);
        const stock = Math.max(0, Math.min(...demands.map(d => Math.floor(d.stock/d.quantity))));
        const candidateKey = JSON.stringify([a.sku, selected.form]);
        const candidate: ScreenshotCandidate = { sku: a.sku, name: a.name, dosage: label, ...selected, defaultForm, type,
          price: roundMoney(price), stock, maxQuantity: stock, available: stock > 0, candidateKey,
          shopProductId: parent.shopProductId || a.sku, articleId: a.id, parentId: parent.id,
          mandatoryCold: requiresColdChainShipping(physical), coldShippingMandatory: requiresColdChainShipping(physical),
          isPlugPlay: Boolean(physical.isPlugPlay), isNasalSpray: Boolean(physical.isNasalSpray), isNasalDiySet: Boolean(physical.isNasalDiySet),
          stockDemands: demands, componentLines: components.lines,
          dependencyIds: [...new Set([...family.map(a => a.id), a.id, parent.id, ...components.ids])].sort((a,b) => a-b) };
        const old = result.get(candidateKey);
        if (old && screenshotHash({ ...old, parentId: 0 }) !== screenshotHash({ ...candidate, parentId: 0 })) ambiguous.add(candidateKey);
        else result.set(candidateKey, candidate);
      }
    }
  }
  return [...result.values()].filter(c => !ambiguous.has(c.candidateKey));
}
export function screenshotSelection(catalog: ScreenshotCandidate[], items: { sku: string; quantity: number; form?: ScreenshotForm }[]) {
  const selected = items.map(line => {
    const exact = catalog.filter(c => c.sku === line.sku);
    if (!exact.length) throw Error('EXACT_PUBLISHED_SKU_REQUIRED');
    const requestedForm = line.form ?? exact[0].defaultForm;
    const c = exact.find(c => c.form === requestedForm);
    if (!c) throw Error('PRODUCT_FORM_UNAVAILABLE');
    return { ...c, quantity: line.quantity };
  });
  if (new Set(selected.map(c => c.candidateKey)).size !== selected.length) throw Error('DUPLICATE_SELECTION');
  const plan = new Map<number, ScreenshotStockPlan[number]>();
  for (const c of selected) for (const d of c.stockDemands) {
    const old = plan.get(d.articleId);
    plan.set(d.articleId, { articleId: d.articleId, sku: d.sku, expectedStock: d.stock, quantity: (old?.quantity ?? 0) + d.quantity*c.quantity });
  }
  const stockPlan = [...plan.values()].sort((a,b) => a.articleId-b.articleId);
  if (stockPlan.some(d => !Number.isSafeInteger(d.quantity) || d.quantity <= 0 || d.expectedStock < d.quantity)) throw Error('STOCK_UNAVAILABLE');
  const componentLines = selected.flatMap(c => c.componentLines.map(line => ({ ...line, quantity: line.quantity*c.quantity })));
  return { selected, stockPlan, componentLines };
}
