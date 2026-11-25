import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeMainshopLines, assertMainshopStock, quantityPricing, mainshopBenefitCategories, type MainshopCatalogArticle, type MainshopLine } from "./mainshopCanonicalPricing.js";
import { reconcileFreeBacWaterForShopOrder } from "./freeBacWaterService.js";

// Offline synthetic fixtures only; not a proposal for the pending real product catalogue.
const article = (id: number, sku: string, shopProductId: string, name: string, category: string, sellingPrice: string, stock: number): MainshopCatalogArticle => ({ id, sku, shopProductId, name, category, categories: [category], sellingPrice, salePrice: null, variants: [], stock, isActive: 1, shopVisible: 1 });
const vial = article(1, "PURE-VIAL-10MG", "pure-vial", "Synthetic (10 mg)", "Vials", "20", 10);
const set = article(2, "PURE-SET", "pure-set", "Synthetic DIY Nasenspray Zubehörset", "Zubehör", "13.25", 4);
const line = (shopProductId: string, quantity = 1): MainshopLine => ({ name: "Client fiction", shopProductId, quantity, price: 0.01, type: "peptide" });
const canonical = (lines: MainshopLine[], catalog: MainshopCatalogArticle[] = [vial, set]) => canonicalizeMainshopLines(lines, catalog, [], []);

test("pure separate accessory set is one actual priced row, never a format, kit fee or implicit stock demand", () => {
  const c = canonical([line("pure-vial", 4), line("pure-set", 2)]);
  assert.equal(c.items.length, 2);
  assert.deepEqual(c.items.map(i => [i.shopProductId, i.price, i.quantity, i.type]), [["PURE-VIAL-10MG", 20, 4, "peptide"], ["PURE-SET", 13.25, 2, "accessory"]]);
  assert.deepEqual(c.quantityEligible, [true, false]); assert.equal(c.quantityUnits, 4);
  assert.equal(quantityPricing(c.items, c.quantityEligible, c.quantityUnits).amount, 8);
  assert.equal(assertMainshopStock(c.items, [vial, set], true).size, 0);
  assert(c.items.every(i => !i.isNasalSpray && !i.isNasalDiySet));
});
test("pure accessory set is not quantity eligible and gets no automatic BAC, even above threshold", () => {
  const c = canonical([line("pure-set", 4)]);
  assert.equal(c.items.length, 1); assert.equal(c.quantityUnits, 0);
  const items = reconcileFreeBacWaterForShopOrder(c.items, [set], { storeKey: "369research" });
  assert.deepEqual(items, c.items); assert.equal(quantityPricing(c.items, c.quantityEligible, c.quantityUnits).amount, 0);
  assert.throws(() => assertMainshopStock(canonical([line("pure-set", 5)]).items, [set], true), /CHECKOUT_STOCK_DEMAND_NOT_COVERED/);
});
for (const flags of [{ isNasalSpray: true }, { isNasalDiySet: true }, { isNasalSpray: true, isPlugPlay: true }, { variant: "DIY-Set" }, { variant: "[Nasenspray]" }]) test(`pure retired format ${JSON.stringify(flags)} rejects rather than sanitizing into a vial`, () => {
  assert.throws(() => canonical([{ ...line("pure-vial"), ...flags }]), /CHECKOUT_NASAL_FORMAT_RETIRED/);
});
for (const prepared of [{ ...vial, category: "Nasensprays" }, { ...vial, name: "Prepared Nasenspray (10 mg)" }]) test(`pure prepared catalogue ${prepared.category}/${prepared.name} fails closed`, () => {
  assert.throws(() => canonical([line("pure-vial")], [prepared]), /CHECKOUT_PREPARED_NASAL_NOT_SELLABLE/);
});
test("pure secondary nasal tag is filter-only: retain vial quantity/BAC/SmartSub authority", () => {
  const tagged = { ...vial, categories: ["Vials", "Nasensprays"] };
  const c = canonical([line("pure-vial", 4)], [tagged]);
  assert.equal(c.items[0].type, "peptide"); assert.equal(c.quantityUnits, 4);
  const gift = reconcileFreeBacWaterForShopOrder(c.items, [{ ...tagged, categories: mainshopBenefitCategories(tagged) }], { storeKey: "369research" });
  assert.equal(gift.at(-1)?.quantity, 4); assert.equal(gift.at(-1)?.shopProductId, "bac-wasser-3ml");
  assert.equal(assertMainshopStock(c.items, [tagged], true).size, 0);
});
