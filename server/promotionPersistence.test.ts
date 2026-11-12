import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { Param } from "drizzle-orm";

// No environment credentials/network/real database are used by this test.
const settings = new Map<string, { key: string; value: string }>();
const writes: string[] = [];
const keyFromWhere = (where: any): string => where.queryChunks.find((chunk: unknown) => chunk instanceof Param)?.value;
const db: any = {
  select: () => ({ from: () => ({ where: (condition: any) => ({ limit: async () => {
    const value = settings.get(keyFromWhere(condition));
    return value ? [value] : [];
  } }) }) }),
  insert: () => ({ values: async (row: { key: string; value: string }) => { writes.push(row.key); settings.set(row.key, row); } }),
  update: () => ({ set: (values: { value: string }) => ({ where: async (condition: any) => {
    const key = keyFromWhere(condition); writes.push(key); settings.set(key, { key, value: values.value });
  } }) }),
  execute: async () => undefined,
  transaction: async (work: (tx: any) => unknown) => work(db),
};

mock.module(new URL("./db.ts", import.meta.url).href, { namedExports: {
  getDb: async () => db, getPool: async () => null, closeDb: async () => {}, withReadOnlyDatabase: async (work: () => unknown) => work(),
} });
mock.module(new URL("./adminChangeLogService.ts", import.meta.url).href, { namedExports: { recordAdminMutation: async () => {} } });
mock.module(new URL("./customerCreationMaintenance.ts", import.meta.url).href, { namedExports: {
  trackCustomerCreation: async (_path: string, _type: string, next: () => unknown) => next(),
} });

const { getPromotionPresets, savePromotionPreset, getBuiltInBlackFridayPreset, GLOBAL_AUTOMATIC_DISCOUNT_PRESETS_KEY } = await import("./promotionPresets.js");
const { GLOBAL_AUTOMATIC_DISCOUNT_CONFIG_KEY } = await import("./globalAutomaticDiscountConfig.js");
const { assertNoExclusiveCampaignBenefitFromDb } = await import("./exclusiveCampaignPolicy.js");
const { shopSettingsRouter } = await import("./shopSettingsRouter.js");

const context = (role: string | null): any => ({ req: { headers: {} }, res: {}, user: role ? { id: 1, username: role, name: role, email: null, role } : null });

test("read/select built-in does not seed DB; template writes only separate shop_settings key", async () => {
  settings.clear(); writes.length = 0;
  const [preset] = await getPromotionPresets();
  assert.equal(preset.config.enabled, false);
  assert.deepEqual(writes, []);
  const old = { key: GLOBAL_AUTOMATIC_DISCOUNT_CONFIG_KEY, value: JSON.stringify({ unrelated: "old campaign unchanged" }) };
  settings.set(old.key, old);
  const edited = { ...preset, name: "Stored BF", config: { ...preset.config, percentage: 37.25, coldShippingSurcharge: 12.5 } };
  await savePromotionPreset(edited);
  assert.deepEqual(writes, [GLOBAL_AUTOMATIC_DISCOUNT_PRESETS_KEY]);
  assert.equal(settings.get(old.key)?.value, old.value);
  const reload = await getPromotionPresets();
  assert.equal(reload[0].name, "Stored BF");
  assert.equal(reload[0].config.percentage, 37.25);
  assert.equal(reload[0].config.enabled, false);
});

test("preset read/write permissions remain admin-only and generic setting route cannot bypass validation", async () => {
  for (const role of [null, "product_manager", "packing", "user"]) {
    const caller = shopSettingsRouter.createCaller(context(role));
    await assert.rejects(() => caller.getGlobalAutomaticDiscountPresets(), /anmelden|Berechtigung/);
    await assert.rejects(() => caller.saveGlobalAutomaticDiscountPreset(getBuiltInBlackFridayPreset()), /anmelden|Berechtigung/);
  }
  const admin = shopSettingsRouter.createCaller(context("admin"));
  assert.ok((await admin.getGlobalAutomaticDiscountPresets()).presets.length);
  await assert.rejects(() => admin.set({ key: GLOBAL_AUTOMATIC_DISCOUNT_PRESETS_KEY, value: "{}" }), /Aktions-Endpunkte/);
});

test("DB-backed strict guard rejects active BF but allows planned, disabled and expired records", async () => {
  const base = getBuiltInBlackFridayPreset().config;
  const put = (config: unknown) => settings.set(GLOBAL_AUTOMATIC_DISCOUNT_CONFIG_KEY, { key: GLOBAL_AUTOMATIC_DISCOUNT_CONFIG_KEY, value: JSON.stringify(config) });
  const future = new Date(Date.now() + 60_000).toISOString();
  put({ ...base, enabled: true, startsAt: null, expiresAt: future });
  await assert.rejects(() => assertNoExclusiveCampaignBenefitFromDb(), /Diese Aktion ist exklusiv/);
  put({ ...base, enabled: true, startsAt: future, expiresAt: new Date(Date.now() + 120_000).toISOString() });
  await assert.doesNotReject(() => assertNoExclusiveCampaignBenefitFromDb());
  put({ ...base, enabled: false });
  await assert.doesNotReject(() => assertNoExclusiveCampaignBenefitFromDb());
  put({ ...base, enabled: true, startsAt: null, expiresAt: new Date(Date.now() - 1000).toISOString() });
  await assert.doesNotReject(() => assertNoExclusiveCampaignBenefitFromDb());
});

test("public promo/personal, partner/creator, KWK validation and direct partner credit route reject before benefits lookup", async () => {
  const base = getBuiltInBlackFridayPreset().config;
  settings.set(GLOBAL_AUTOMATIC_DISCOUNT_CONFIG_KEY, {
    key: GLOBAL_AUTOMATIC_DISCOUNT_CONFIG_KEY,
    value: JSON.stringify({ ...base, enabled: true, startsAt: null, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  });
  const { promoCodeRouter } = await import("./promoCodeRouter.js");
  const { partnerRouter } = await import("./partnerRouter.js");
  const { kwkRouter } = await import("./kwkRouter.js");
  const ctx = context(null);
  const promo = promoCodeRouter.createCaller(ctx);
  const partner = partnerRouter.createCaller(ctx);
  const kwk = kwkRouter.createCaller(ctx);
  process.env.FEATURE_KWK_ENABLED = "true";
  for (const attempt of [
    () => promo.validate({ code: "OLDPROMO", orderTotal: 150 }),
    () => promo.validate({ code: "123456", orderTotal: 150 }),
    () => partner.validateCode({ code: "CREATOR" }),
    () => kwk.validateCode({ code: "KWK" }),
    () => partner.redeemCreditByNumber({ partnerNumber: "ACC-1", password: "not-used", orderId: "no-order", amount: 1 }),
  ]) await assert.rejects(attempt, (error: any) => error.code === "CONFLICT" && /Aktionsrabatt bleibt/.test(error.message));
  delete process.env.FEATURE_KWK_ENABLED;
});
