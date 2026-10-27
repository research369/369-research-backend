import assert from "node:assert/strict";
import test from "node:test";
import {
  assertGlobalAutomaticDiscountConfigCanBeSaved,
  defaultGlobalAutomaticDiscountConfig,
  getActiveGlobalAutomaticDiscount,
  globalAutomaticDiscountConfigInputSchema,
  parseGlobalAutomaticDiscountConfig,
  resolveGlobalAutomaticDiscountBenefits,
  type GlobalAutomaticDiscountConfig,
} from "./globalAutomaticDiscountConfig.js";

const now = new Date("2026-10-27T12:00:00.000Z");

function activeConfig(overrides: Partial<GlobalAutomaticDiscountConfig> = {}) {
  const config: GlobalAutomaticDiscountConfig = {
    ...defaultGlobalAutomaticDiscountConfig,
    enabled: true,
    percentage: 15,
    expiresAt: "2026-10-27T13:00:00.000Z",
    freeShippingEnabled: true,
    freeShippingMinOrder: 50,
    freeShippingRegions: ["de", "eu"],
    ...overrides,
  };
  const active = getActiveGlobalAutomaticDiscount(config, now);
  assert.ok(active, "test setup must produce an active configuration");
  return active;
}

test("legacy config receives safe new defaults", () => {
  const parsed = parseGlobalAutomaticDiscountConfig(JSON.stringify({
    enabled: false,
    percentage: 0,
    expiresAt: null,
    stackWithPromotionCodes: true,
    labelDe: "Dauerrabatt",
    labelEn: "Automatic discount",
  }));

  assert.equal(parsed.freeShippingEnabled, false);
  assert.equal(parsed.freeShippingMinOrder, 0);
  assert.deepEqual(parsed.freeShippingRegions, []);
  assert.equal(parsed.stackWithPartnerCreatorCodes, true);
  assert.equal(parsed.stackWithKwk, true);
});

test("enabled configs without expiry fail closed during parsing", () => {
  const parsed = parseGlobalAutomaticDiscountConfig(JSON.stringify({
    ...defaultGlobalAutomaticDiscountConfig,
    enabled: true,
    percentage: 15,
  }));

  assert.equal(parsed.enabled, false);
  assert.equal(getActiveGlobalAutomaticDiscount(parsed, now), null);
});

test("enabled config requires a future expiry and a start before expiry", () => {
  assert.throws(() => assertGlobalAutomaticDiscountConfigCanBeSaved({
    ...defaultGlobalAutomaticDiscountConfig,
    enabled: true,
    percentage: 15,
    expiresAt: null,
  }, now), /Endzeitpunkt erforderlich/);

  assert.throws(() => assertGlobalAutomaticDiscountConfigCanBeSaved({
    ...defaultGlobalAutomaticDiscountConfig,
    enabled: true,
    percentage: 15,
    startsAt: "2026-10-27T13:00:00.000Z",
    expiresAt: "2026-10-27T13:00:00.000Z",
  }, now), /Startzeitpunkt/);

  assert.throws(() => assertGlobalAutomaticDiscountConfigCanBeSaved({
    ...defaultGlobalAutomaticDiscountConfig,
    enabled: true,
    percentage: 15,
    expiresAt: "2026-10-27T12:00:00.000Z",
  }, now), /Zukunft/);
});

test("free shipping requires at least one approved region when enabled", () => {
  assert.throws(() => assertGlobalAutomaticDiscountConfigCanBeSaved({
    ...defaultGlobalAutomaticDiscountConfig,
    freeShippingEnabled: true,
    freeShippingMinOrder: 0,
    freeShippingRegions: [],
  }, now), /mindestens eine Versandregion/);
});

test("UI input accepts only nonnegative free-shipping thresholds and de/eu/ch regions", () => {
  const input = {
    enabled: false,
    percentage: 0,
    expiresAt: null,
    stackWithPromotionCodes: true,
    freeShippingEnabled: true,
    freeShippingMinOrder: 0,
    freeShippingRegions: ["de", "ch"],
    stackWithPartnerCreatorCodes: true,
    stackWithKwk: true,
  };
  assert.deepEqual(globalAutomaticDiscountConfigInputSchema.parse(input).freeShippingRegions, ["de", "ch"]);
  assert.throws(() => globalAutomaticDiscountConfigInputSchema.parse({
    ...input,
    freeShippingMinOrder: -0.01,
  }));
  assert.throws(() => globalAutomaticDiscountConfigInputSchema.parse({
    ...input,
    freeShippingRegions: ["at"],
  }));
});

test("promotion-code conflict turns off both global benefits while keeping the code eligible", () => {
  const result = resolveGlobalAutomaticDiscountBenefits(
    activeConfig({ stackWithPromotionCodes: false }),
    { merchandiseSubtotal: 100, shippingRegion: "de", hasPromotionCode: true },
  );
  assert.deepEqual(result, { globalDiscountApplies: false, globalFreeShippingApplies: false });
});

test("partner or creator-code conflict turns off both global benefits", () => {
  const result = resolveGlobalAutomaticDiscountBenefits(
    activeConfig({ stackWithPartnerCreatorCodes: false }),
    { merchandiseSubtotal: 100, shippingRegion: "de", hasPartnerCreatorCode: true },
  );
  assert.deepEqual(result, { globalDiscountApplies: false, globalFreeShippingApplies: false });
});

test("KWK conflict turns off both global benefits", () => {
  const result = resolveGlobalAutomaticDiscountBenefits(
    activeConfig({ stackWithKwk: false }),
    { merchandiseSubtotal: 100, shippingRegion: "de", hasKwk: true },
  );
  assert.deepEqual(result, { globalDiscountApplies: false, globalFreeShippingApplies: false });
});

test("default stacking preserves both global benefits with every eligible combination", () => {
  const result = resolveGlobalAutomaticDiscountBenefits(
    activeConfig(),
    {
      merchandiseSubtotal: 100,
      shippingRegion: "de",
      hasPromotionCode: true,
      hasPartnerCreatorCode: true,
      hasKwk: true,
    },
  );
  assert.deepEqual(result, { globalDiscountApplies: true, globalFreeShippingApplies: true });
});

test("free shipping uses pre-discount merchandise subtotal and approved region", () => {
  const config = activeConfig({ freeShippingMinOrder: 50, freeShippingRegions: ["de"] });

  assert.deepEqual(resolveGlobalAutomaticDiscountBenefits(config, {
    merchandiseSubtotal: 49.99,
    shippingRegion: "de",
  }), { globalDiscountApplies: true, globalFreeShippingApplies: false });

  assert.deepEqual(resolveGlobalAutomaticDiscountBenefits(config, {
    merchandiseSubtotal: 50,
    shippingRegion: "ch",
  }), { globalDiscountApplies: true, globalFreeShippingApplies: false });

  assert.deepEqual(resolveGlobalAutomaticDiscountBenefits(config, {
    merchandiseSubtotal: 50,
    shippingRegion: "de",
  }), { globalDiscountApplies: true, globalFreeShippingApplies: true });
});
