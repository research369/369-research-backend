import assert from "node:assert/strict";
import test from "node:test";
import { TRPCError } from "@trpc/server";
import {
  getActiveGlobalAutomaticDiscount, resolveGlobalAutomaticDiscountBenefits,
  globalAutomaticDiscountConfigSchema, defaultGlobalAutomaticDiscountConfig,
} from "./globalAutomaticDiscountConfig.js";
import { getBuiltInBlackFridayPreset, parsePromotionPresets, promotionPresetSchema } from "./promotionPresets.js";
import { assertExclusiveCampaignInput, sanitizeExclusiveCampaignAttribution } from "./exclusiveCampaignPolicy.js";
import { reconcileFreeBacWaterForShopOrder } from "./freeBacWaterService.js";
import { calculateAutomaticGlobalDiscount } from "./kwkCheckoutPricing.js";

const start = new Date("2026-11-12T23:00:00.000Z");
const config = { ...getBuiltInBlackFridayPreset().config, enabled: true };
const active = getActiveGlobalAutomaticDiscount(config, start)!;

const vial = { name: "Vial", shopProductId: "paid-vial", price: 19, quantity: 2, type: "peptide" };
const catalog = [
  { shopProductId: "paid-vial", category: "Vials", categories: ["Vials"] },
  { shopProductId: "cosmetic", category: "369 BeautyLine", categories: ["369 BeautyLine"] },
  { shopProductId: "nasal", category: "Nasal Spray", categories: ["Nasal Spray"] },
];
const giftCount = (items: ReturnType<typeof reconcileFreeBacWaterForShopOrder>) => items.find((item) => item.isFreeGift && item.shopProductId === "bac-wasser-3ml")?.quantity ?? 0;

test("BF default is permanently selectable draft with approved Berlin schedule and editable decimal values", () => {
  const preset = getBuiltInBlackFridayPreset();
  assert.equal(preset.name, "Black Friday36.9");
  assert.equal(preset.config.enabled, false);
  assert.equal(preset.config.percentage, 36.9);
  assert.equal(preset.config.freeShippingMinOrder, 150);
  assert.equal(preset.config.coldShippingSurcharge, 15);
  assert.equal(preset.config.exclusiveCampaign, true);
  assert.equal(preset.config.freeBacWaterPerPaidVial, true);
  assert.equal(getActiveGlobalAutomaticDiscount(preset.config, start), null);
  assert.equal(calculateAutomaticGlobalDiscount(123.45, 36.9), 45.55);
  const edited = promotionPresetSchema.parse({ ...preset, name: "Edited template", config: { ...preset.config, percentage: 37.25, coldShippingSurcharge: 12.5 } });
  assert.equal(edited.config.percentage, 37.25);
  assert.equal(edited.config.coldShippingSurcharge, 12.5);
  assert.throws(() => promotionPresetSchema.parse({ ...preset, config: { ...preset.config, enabled: true } }));
  assert.throws(() => promotionPresetSchema.parse({ ...preset, config: { ...preset.config, exclusiveCampaign: false } }));
});

test("stored preset overrides built-in template and missing/corrupt template never mutates current campaign", () => {
  const preset = getBuiltInBlackFridayPreset();
  const edited = { ...preset, name: "Operator label", config: { ...preset.config, percentage: 40 } };
  const stored = parsePromotionPresets(JSON.stringify({ version: 1, presets: [edited] }));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].name, "Operator label");
  assert.equal(stored[0].config.enabled, false);
  assert.equal(parsePromotionPresets("{")[0].id, preset.id);
  assert.equal(parsePromotionPresets(JSON.stringify({ version: 1, presets: [] }))[0].id, preset.id);
});

test("start is inclusive, expiry exclusive; planned/off/expired campaigns never block other benefits", () => {
  assert.equal(getActiveGlobalAutomaticDiscount(config, new Date(start.getTime() - 1)), null);
  assert.ok(active);
  assert.ok(getActiveGlobalAutomaticDiscount(config, new Date("2026-11-13T22:59:59.999Z")));
  assert.equal(getActiveGlobalAutomaticDiscount(config, new Date("2026-11-13T23:00:00.000Z")), null);
  for (const snapshot of [null, getActiveGlobalAutomaticDiscount({ ...config, enabled: false }, start)]) {
    assert.doesNotThrow(() => assertExclusiveCampaignInput(snapshot, { discountCode: "OLD", creditUsed: 12, kwkCode: "KWK" }));
  }
});

test("strict BF retains global percentage/free shipping despite every conflicting code flag", () => {
  assert.deepEqual(resolveGlobalAutomaticDiscountBenefits(active, {
    merchandiseSubtotal: 150, shippingRegion: "de", hasPromotionCode: true, hasPartnerCreatorCode: true, hasKwk: true,
  }), { globalDiscountApplies: true, globalFreeShippingApplies: true });
  assert.equal(resolveGlobalAutomaticDiscountBenefits(active, { merchandiseSubtotal: 149.99, shippingRegion: "de" }).globalFreeShippingApplies, false);
  assert.equal(resolveGlobalAutomaticDiscountBenefits(active, { merchandiseSubtotal: 150, shippingRegion: "ch" }).globalFreeShippingApplies, true);
});

test("ALL explicit code/credit/KWK attempts are CONFLICT, not a global-discount bypass", () => {
  for (const facts of [
    { promotionCode: "PROMO" }, { discountCode: "123456" }, { partnerCode: "CREATOR" }, { kwkCode: "KWK" },
    { creditUsed: 1 }, { partnerCreditUsed: 1 }, { kwkCreditUsed: 1 }, { partnerDiscount: 1 }, { kwkDiscount: 1 },
  ]) {
    assert.throws(() => assertExclusiveCampaignInput(active, facts), (error) => error instanceof TRPCError
      && error.code === "CONFLICT" && /Aktionsrabatt bleibt/.test(error.message));
  }
});

test("partner identity/login is permitted but implicit self-rate, indirect commission and referral terms are suppressed", () => {
  const policy = assertExclusiveCampaignInput(active, { hasPartnerSelfDiscount: true, creditUsed: 0 });
  assert.equal(policy.suppressPartnerSelfDiscount, true);
  assert.equal(policy.suppressPartnerAttribution, true);
  assert.equal(policy.suppressKwkRewards, true);
  const facts = { partnerNumber: "ACC-1", customerId: 2, partnerId: 9, partnerCode: "INDIRECT", commissionPercent: 10, commissionAmount: 12, kwkCode: "KWK", kwkReward: 9 };
  assert.deepEqual(sanitizeExclusiveCampaignAttribution(active, facts), { ...facts, partnerId: null, partnerCode: null, commissionPercent: 0, commissionAmount: 0, kwkCode: null, kwkReward: 0 });
  assert.equal(facts.partnerCode, "INDIRECT", "sanitizer must not mutate account/request input");
  assert.equal(sanitizeExclusiveCampaignAttribution(null, facts), facts);
});

test("campaign BAC includes paid catalogue-confirmed vials below EUR50 only during campaign", () => {
  assert.equal(giftCount(reconcileFreeBacWaterForShopOrder([vial], catalog, active)), 2);
  assert.equal(giftCount(reconcileFreeBacWaterForShopOrder([vial], catalog)), 0);
  assert.equal(giftCount(reconcileFreeBacWaterForShopOrder([vial], catalog, getActiveGlobalAutomaticDiscount(config, new Date("2026-11-13T23:00:00Z")))), 0);
  assert.equal(giftCount(reconcileFreeBacWaterForShopOrder([{ ...vial, quantity: 3, variant: "Bundle: Paid" }], catalog, active)), 3);
  for (const item of [
    { ...vial, price: 0 }, { ...vial, isFreeGift: true }, { ...vial, isNasalSpray: true }, { ...vial, isNasalDiySet: true },
    { ...vial, isPlugPlay: true }, { ...vial, shopProductId: "cosmetic" }, { ...vial, shopProductId: "unknown" }, { ...vial, quantity: 1.5 },
    { ...vial, shopProductId: "nasal" }, { ...vial, variant: "Bundle: Mind (Nasenspray)" },
  ]) assert.equal(giftCount(reconcileFreeBacWaterForShopOrder([item], catalog, active)), 0);
});

test("legacy config retains standard shipping/gift rules and rejects invalid monetary configuration", () => {
  const legacy = globalAutomaticDiscountConfigSchema.parse({ ...defaultGlobalAutomaticDiscountConfig });
  assert.equal(legacy.exclusiveCampaign, false);
  assert.equal(legacy.coldShippingSurcharge, null);
  assert.equal(legacy.freeBacWaterPerPaidVial, false);
  assert.throws(() => globalAutomaticDiscountConfigSchema.parse({ ...config, coldShippingSurcharge: -1 }));
  assert.throws(() => globalAutomaticDiscountConfigSchema.parse({ ...config, percentage: NaN }));
});
