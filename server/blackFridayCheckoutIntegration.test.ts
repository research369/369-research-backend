import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { defaultGlobalAutomaticDiscountConfig, getActiveGlobalAutomaticDiscount, resolveGlobalAutomaticDiscountBenefits } from "./globalAutomaticDiscountConfig.js";
import { assertExclusiveCampaignAllowsBenefits } from "./exclusiveCampaignPolicy.js";
import { calculateAutomaticGlobalDiscount, calculateAuthoritativeShipping, roundMoney } from "./kwkCheckoutPricing.js";
import { resolveTrustedColdShippingItems } from "./coldShippingCatalog.js";
import { reconcileFreeBacWaterForShopOrder } from "./freeBacWaterService.js";
import { projectOffers } from "./pepgptOffers.js";

const config = {
  ...defaultGlobalAutomaticDiscountConfig,
  enabled: true, percentage: 36.9,
  startsAt: "2026-11-12T23:00:00.000Z", expiresAt: "2026-11-13T23:00:00.000Z",
  freeShippingEnabled: true, freeShippingMinOrder: 150, freeShippingRegions: ["de", "eu", "ch"] as ("de" | "eu" | "ch")[],
  exclusiveCampaign: true, coldShippingSurcharge: 15, freeBacWaterPerPaidVial: true,
  stackWithPromotionCodes: false, stackWithPartnerCreatorCodes: false, stackWithKwk: false,
};
const now = new Date("2026-11-13T12:00:00.000Z");
const active = getActiveGlobalAutomaticDiscount(config, now)!;

test("all code, KWK, partner discount and wallet paths rejected, campaign still wins", () => {
  assert(active);
  for (const input of [{ discountCode: "PROMO" }, { partnerCode: "CREATOR" }, { kwkCode: "KWK" }, { creditUsed: 1 }, { kwkCreditUsed: 1 }, { partnerDiscount: 1 }, { kwkDiscount: 1 }]) {
    assert.throws(() => assertExclusiveCampaignAllowsBenefits(active, input), /exklusiv/);
  }
  assert.doesNotThrow(() => assertExclusiveCampaignAllowsBenefits(active, {}));
  assert.deepEqual(resolveGlobalAutomaticDiscountBenefits(active, {
    merchandiseSubtotal: 150, shippingRegion: "de", hasPromotionCode: true, hasPartnerCreatorCode: true, hasKwk: true,
  }), { globalDiscountApplies: true, globalFreeShippingApplies: true });
});

test("Berlin start/end are exact and expired campaign never blocks regular code/credit", () => {
  for (const time of ["2026-11-12T22:59:59.999Z", "2026-11-13T23:00:00.000Z", "2026-11-14T12:00:00.000Z"]) {
    const inactive = getActiveGlobalAutomaticDiscount(config, new Date(time));
    assert.equal(inactive, null);
    assert.doesNotThrow(() => assertExclusiveCampaignAllowsBenefits(inactive, { discountCode: "NORMAL", kwkCreditUsed: 3 }));
  }
  assert(getActiveGlobalAutomaticDiscount(config, new Date(config.startsAt)));
  assert.equal(getActiveGlobalAutomaticDiscount({ ...config, enabled: false }, now), null);
});

test("150 EUR threshold before discount and exactly one cooled surcharge per order", () => {
  for (const country of ["de", "ch", "fr"]) {
    const items = [{ isPlugPlay: true }, { isNasalSpray: true }];
    const shipping = calculateAuthoritativeShipping({ country, items, coldChainRequested: true, coldShippingSurcharge: active.coldShippingSurcharge ?? undefined, freeBaseShipping: true });
    assert.equal(shipping, 15);
    assert.equal(roundMoney(150 - calculateAutomaticGlobalDiscount(150, active.percentage) + shipping), 109.65);
  }
  assert.equal(calculateAuthoritativeShipping({ country: "de", items: [], freeBaseShipping: true }), 0);
  assert.equal(calculateAuthoritativeShipping({ country: "de", items: [{ isPlugPlay: true }] }), 15); // regular 8 + 7
  assert.equal(calculateAuthoritativeShipping({ country: "ch", items: [{ isPlugPlay: true }], coldShippingSurcharge: 15 }), 33);
  assert.equal(resolveGlobalAutomaticDiscountBenefits(active, { merchandiseSubtotal: 149.99, shippingRegion: "de" }).globalFreeShippingApplies, false);
});

test("campaign gives one BAC per low-priced paid vial, never cosmetic or plug-and-play", () => {
  const items = [
    { name: "Vial", shopProductId: "vial", type: "peptide", price: 20, quantity: 2 },
    { name: "Serum", shopProductId: "serum", type: "peptide", price: 100, quantity: 1 },
    { name: "Patrone", shopProductId: "vial", type: "peptide", price: 80, quantity: 1, isPlugPlay: true },
  ];
  const catalog = [{ shopProductId: "vial", category: "Peptide" }, { shopProductId: "serum", category: "369 BeautyLine" }];
  const result = reconcileFreeBacWaterForShopOrder(items, catalog, active);
  assert.equal(result.filter((item) => item.isFreeGift).length, 1);
  assert.equal(result.at(-1)!.quantity, 2);
  assert.equal(reconcileFreeBacWaterForShopOrder(items, catalog, null).filter((item) => item.isFreeGift).length, 0);
});

test("fixed nasal catalogue product cannot claim non-cold DIY flags", () => {
  const trusted = resolveTrustedColdShippingItems([{ shopProductId: "nasal", name: "Fake vial", isNasalSpray: false, isNasalDiySet: true }], [{ sku: "NASAL", shopProductId: "nasal", name: "Ready Nasenspray", category: "Nasensprays" }]);
  assert.equal(trusted[0].isNasalSpray, true);
  assert.equal(trusted[0].isNasalDiySet, false);
});

test("bot offers never recommend or stack another code during exclusive campaign", () => {
  const articles = [{ id: 1, name: "Synthetic (10 mg)", sku: "SYNTH", shop_product_id: "synthetic", selling_price: "200", sale_price: null, stock: 5, is_active: 1, shop_visible: 1, variants: [{ dosage: "10 mg", price: 200, inventoryArticleId: 1 }] }];
  const result = projectOffers(articles, [], JSON.stringify(config), { search: "Synthetic", quantity: 1, country: "de", promotion: { mode: "bot_approved" } }, now);
  assert.equal(result.offers[0].total, 126.2);
  assert.deepEqual(result.offers[0].promotions, []);
  assert.throws(() => projectOffers(articles, [], JSON.stringify(config), { search: "Synthetic", quantity: 1, country: "de", promotion: { mode: "explicit_code", code: "OTHER" } }, now), /promotion_not_eligible/);
});

test("actual route guards cold destination and exclusivity before transaction writes; public free-base claims ignored", () => {
  const router = readFileSync(new URL("./orderRouter.ts", import.meta.url), "utf8");
  const guard = router.indexOf("assertExclusiveCampaignAllowsBenefits(configuredGlobalDiscount");
  const cold = router.indexOf("const eligibility = await getColdShippingAvailability({");
  const firstOrderNumber = router.indexOf("const orderId =");
  assert(guard >= 0 && cold > guard);
  if (firstOrderNumber > 0) assert(cold < firstOrderNumber);
  assert.equal(router.match(/input\.shipping = 0;/g)?.length, 1);
  assert(router.includes('if (isAuthenticatedWawiPickup) {\n        input.shipping = 0;\n        input.shippingCountry = "Abholung";'));
  assert(router.includes("requiresPartnerSession = !strictExclusiveCampaign"));
  assert(router.includes("if (isAuthenticatedWawiManualSale) {\n          input.shipping = calculateAuthoritativeShipping"));
  assert(router.indexOf("input.subtotal = repriced.subtotal") < router.indexOf("reconcileFreeBacWaterForShopOrder(qualifiedBacItems"));
});

test("36.9 percent half-cent is rounded once using cents and basis points", () => {
  assert.equal(calculateAutomaticGlobalDiscount(215, 36.9), 79.34);
  assert.equal(calculateAutomaticGlobalDiscount(200, 36.9), 73.8);
  assert.equal(calculateAutomaticGlobalDiscount(115, 36.9), 42.44);
});
