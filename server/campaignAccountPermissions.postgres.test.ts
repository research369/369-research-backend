import assert from "node:assert/strict";
import test, { before, after, beforeEach, mock } from "node:test";
import { readFileSync } from "node:fs";
import { ENV } from "./env.js";
import { getPool, closeDb } from "./db.js";
import {
  ensurePermissionsSchema, isPermissionsSchemaReady, permissionsSchemaSql,
  campaignAccountPermissionsSchemaSql,
} from "./permissionsSchema.js";
import { ensureAdminChangeLogSchema } from "./adminChangeLogService.js";
import { defaultGlobalAutomaticDiscountConfig } from "./globalAutomaticDiscountConfig.js";
import { getBuiltInBlackFridayPreset } from "./promotionPresets.js";

// This file never skips. Only its dedicated disposable cluster may run it.
const socket = process.env.CAMPAIGN_TEST_PG_SOCKET;
if (!socket?.startsWith("/tmp/369-campaign-permissions.") || !socket.endsWith("/socket")
  || process.env.DATABASE_URL || process.env.RAILWAY_DB_URL
  || process.env.DOTENV_CONFIG_PATH !== "/dev/null") throw Error("DEDICATED_LOCAL_FIXTURE_REQUIRED");
let external = 0, notifications = 0;
const notificationNoop = async () => { notifications++; return false; };
// All business handlers, persistence, auth helpers and audit middleware stay real.
// Only outbound notifications are no-ops; fetch is additionally blocked below.
mock.module(new URL("./emailService.ts", import.meta.url).href, { namedExports: {
  sendOrderConfirmationEmail: notificationNoop, sendAdminOrderNotification: notificationNoop,
  sendPackingNotificationEmail: notificationNoop, sendShippingNotificationEmail: notificationNoop,
} });
const { shopSettingsRouter } = await import("./shopSettingsRouter.js");
const { customerRouter } = await import("./customerRouter.js");
const { orderRouter } = await import("./orderRouter.js");
const { router, adminProcedure } = await import("./trpc.js");
const app = router({ shopSettings: shopSettingsRouter, customer: customerRouter, order: orderRouter });
const user = { id: 2, username: "product_manager", role: "product_manager", name: null, email: null };
const admin = { ...user, id: 1, username: "local-admin", role: "admin" };
const context = (principal: any = user): any => ({ req: { headers: {} }, res: {}, user: principal });
const caller = (principal: any = user) => app.createCaller(context(principal));
const forbidden = (error: any) => ["FORBIDDEN", "UNAUTHORIZED"].includes(error.code);
const draft = () => getBuiltInBlackFridayPreset();
const campaign = () => ({ ...draft().config, enabled: true });
const clock = (now = "2026-11-12T12:00:00.000Z") => mock.timers.enable({ apis: ["Date"], now: Date.parse(now) });
let pool: NonNullable<Awaited<ReturnType<typeof getPool>>>;
const settings = async () => (await pool.query("SELECT key,value FROM shop_settings ORDER BY key")).rows;
const events = async () => (await pool.query("SELECT action,actor,changed_fields FROM admin_change_events ORDER BY id")).rows;
const campaignOperations = (principal: any = user) => {
  const c = caller(principal).shopSettings;
  return [() => c.getGlobalAutomaticDiscountPresets(), () => c.saveGlobalAutomaticDiscountPreset(draft()),
    () => c.getGlobalAutomaticDiscountAdmin(), () => c.setGlobalAutomaticDiscount(campaign())];
};
async function deniedOnAll(principal: any = user) {
  for (const operation of campaignOperations(principal)) await assert.rejects(operation(), forbidden);
}

before(async () => {
  mock.method(globalThis, "fetch", async () => { external++; throw Error("NETWORK_FORBIDDEN"); });
  await closeDb();
  ENV.databaseUrl = `postgresql://campaign_local@localhost:55460/postgres?host=${encodeURIComponent(socket!)}`;
  ENV.resendApiKey = ""; ENV.bunqApiKey = ""; ENV.dhlApiKey = ""; ENV.dhlTrackingApiKey = ""; ENV.forgeApiKey = "";
  const localPool = await getPool(); assert(localPool); pool = localPool;
  await pool.query("ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'product_manager'");
  // Identity-only fixture: no passwords, tokens, credentials or login/auth changes.
  // Nullability is changed ONLY in this throwaway database, not in the source schema.
  await pool.query("ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL");
  await pool.query("INSERT INTO users(id,username,role) VALUES(2,'product_manager','product_manager'),(3,'other_manager','product_manager')");
  assert.equal(isPermissionsSchemaReady(), false);
  await deniedOnAll();
  await pool.query(permissionsSchemaSql);
  const oldCheck = (await pool.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='operations_account_capability_grants_capability_check'")).rows[0].definition;
  assert(!oldCheck.includes("campaign_settings"));
  await deniedOnAll(); // Original three grants alone never imply campaign scope.
  await ensurePermissionsSchema();
  assert.equal(isPermissionsSchemaReady(), true);
  await ensureAdminChangeLogSchema();
});
beforeEach(async () => {
  mock.timers.reset();
  await pool.query("UPDATE users SET username='other_manager',role='product_manager' WHERE id=3; UPDATE users SET username='product_manager',role='product_manager' WHERE id=2");
  await pool.query("UPDATE operations_account_capability_grants SET revoked_at=NULL");
  await ensurePermissionsSchema();
  await pool.query("TRUNCATE shop_settings,admin_change_events");
});
after(async () => {
  mock.timers.reset();
  await closeDb(); ENV.databaseUrl = "";
  mock.restoreAll();
  assert.equal(external, 0); assert.equal(notifications, 0);
});

test("additive migration adds exactly one campaign grant, preserves old rights and rejects arbitrary capabilities", async () => {
  const before = (await pool.query("SELECT * FROM operations_account_capability_grants WHERE capability <> 'campaign_settings' ORDER BY capability")).rows;
  assert.equal(before.length, 3);
  await pool.query("UPDATE operations_account_capability_grants SET revoked_at='2026-11-10T10:00:00Z' WHERE capability='order_cleanup'");
  const unchanged = (await pool.query("SELECT * FROM operations_account_capability_grants WHERE capability <> 'campaign_settings' ORDER BY capability")).rows;
  await ensurePermissionsSchema(); await ensurePermissionsSchema();
  assert.deepEqual((await pool.query("SELECT * FROM operations_account_capability_grants WHERE capability <> 'campaign_settings' ORDER BY capability")).rows, unchanged);
  const grants = (await pool.query("SELECT * FROM operations_account_capability_grants WHERE capability='campaign_settings'")).rows;
  assert.equal(grants.length, 1);
  assert.equal(grants[0].user_id, 2); assert.equal(grants[0].username, user.username);
  assert.equal(grants[0].required_role, user.role); assert.equal(grants[0].revoked_at, null);
  assert.match(grants[0].grant_reason, /2026-11-12 Userauthorize at 13:42:36/);
  assert.match(grants[0].grant_reason, /permanently read\/save global campaign and promotion presets ONLY/);
  await assert.rejects(pool.query("INSERT INTO operations_account_capability_grants(user_id,username,required_role,capability,grant_reason) VALUES(2,'product_manager','product_manager','full_admin','forbidden')"), /check constraint/);
  assert.equal((await pool.query("SELECT count(*)::int n FROM operations_account_capability_grants")).rows[0].n, 4);
});

test("all four actual campaign endpoints reject unauthenticated, wrong id/name/role and other managers with same username", async () => {
  clock();
  for (const principal of [null, { ...user, id: 3 }, { ...user, username: "other_manager" },
    { ...user, id: 3, username: "other_manager" }, { ...user, role: "user" },
    { ...user, role: "packing" }]) {
    await deniedOnAll(principal);
  }
  // Even when DB account 3 now has the exact same username/role, its id is denied.
  await pool.query("UPDATE users SET username='renamed' WHERE id=2; UPDATE users SET username='product_manager' WHERE id=3");
  await deniedOnAll({ ...user, id: 3 });
  await ensurePermissionsSchema();
  assert.equal((await pool.query("SELECT count(*)::int n FROM operations_account_capability_grants WHERE capability='campaign_settings'")).rows[0].n, 1);
  assert.deepEqual(await settings(), []); assert.deepEqual(await events(), []);
});

test("every request joins live identity; username/role changes and revoked grant fail closed with replay retaining revocation", async () => {
  clock();
  await caller().shopSettings.getGlobalAutomaticDiscountAdmin();
  await pool.query("UPDATE operations_account_capability_grants SET user_id=3 WHERE capability='campaign_settings'");
  try {
    await deniedOnAll();
    await pool.query("UPDATE users SET username='renamed' WHERE id=2");
    await ensurePermissionsSchema();
    assert.equal((await pool.query("SELECT count(*)::int n FROM operations_account_capability_grants WHERE user_id=2 AND capability='campaign_settings'")).rows[0].n, 0);
    await pool.query("UPDATE users SET username='product_manager',role='user' WHERE id=2");
    await ensurePermissionsSchema();
    assert.equal((await pool.query("SELECT count(*)::int n FROM operations_account_capability_grants WHERE user_id=2 AND capability='campaign_settings'")).rows[0].n, 0);
    await deniedOnAll();
  } finally {
    await pool.query("UPDATE users SET username='product_manager',role='product_manager' WHERE id=2");
    await pool.query("UPDATE operations_account_capability_grants SET user_id=2 WHERE capability='campaign_settings'");
  }
  await pool.query("UPDATE users SET username='renamed' WHERE id=2"); await deniedOnAll();
  await pool.query("UPDATE users SET username='product_manager',role='user' WHERE id=2"); await deniedOnAll();
  await pool.query("UPDATE users SET role='product_manager' WHERE id=2");
  await pool.query("UPDATE operations_account_capability_grants SET revoked_at='2026-11-12T12:42:36Z' WHERE capability='campaign_settings'");
  const revoked = (await pool.query("SELECT * FROM operations_account_capability_grants WHERE capability='campaign_settings'")).rows;
  await deniedOnAll(); await ensurePermissionsSchema(); await ensurePermissionsSchema();
  assert.deepEqual((await pool.query("SELECT * FROM operations_account_capability_grants WHERE capability='campaign_settings'")).rows, revoked);
  await deniedOnAll({ ...user, capabilities: ["campaign_settings"], meta: { role: "admin", campaign_settings: true } });
  assert.deepEqual(await settings(), []); assert.deepEqual(await events(), []);
  assert.deepEqual((await caller(admin).shopSettings.getGlobalAutomaticDiscountAdmin()).config, defaultGlobalAutomaticDiscountConfig);
});

test("grant lookup failure, absent grant table and additive-migration failure never set readiness or fall back to a role", async () => {
  clock();
  await pool.query("ALTER TABLE operations_account_capability_grants RENAME TO local_hidden_grants");
  try { await deniedOnAll(); } finally { await pool.query("ALTER TABLE local_hidden_grants RENAME TO operations_account_capability_grants"); }
  const actualQuery = pool.query.bind(pool);
  const queryMock = mock.method(pool, "query", async (...args: any[]) => {
    if (args[0] === campaignAccountPermissionsSchemaSql || String(args[0]).includes("SELECT 1 FROM operations_account_capability_grants")) throw Error("LOCAL_CAMPAIGN_MIGRATION_FAILURE");
    return (actualQuery as any)(...args);
  });
  try {
    await deniedOnAll();
    await assert.rejects(ensurePermissionsSchema(), /LOCAL_CAMPAIGN_MIGRATION_FAILURE/);
    assert.equal(isPermissionsSchemaReady(), false);
  } finally { queryMock.mock.restore(); }
  await deniedOnAll(); // Existing valid DB grant alone is insufficient until ready.
  const adminCaller = caller(admin).shopSettings;
  await adminCaller.getGlobalAutomaticDiscountAdmin();
  await adminCaller.setGlobalAutomaticDiscount({ ...campaign(), enabled: false });
  assert.equal((await adminCaller.saveGlobalAutomaticDiscountPreset(draft())).presets[0].config.enabled, false);
  await adminCaller.getGlobalAutomaticDiscountPresets();
  await ensurePermissionsSchema();
  await caller().shopSettings.getGlobalAutomaticDiscountAdmin();
});

test("CHECK replacement and grant insert roll back atomically on an invalid historical capability", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN; ALTER TABLE operations_account_capability_grants DROP CONSTRAINT operations_account_capability_grants_capability_check; INSERT INTO operations_account_capability_grants(user_id,username,required_role,capability,grant_reason) VALUES(3,'other_manager','product_manager','unexpected_existing','local rollback fixture'); COMMIT");
    const rows = (await client.query("SELECT * FROM operations_account_capability_grants ORDER BY user_id,capability")).rows;
    await assert.rejects(client.query(campaignAccountPermissionsSchemaSql), /check constraint/);
    await client.query("ROLLBACK");
    assert.deepEqual((await client.query("SELECT * FROM operations_account_capability_grants ORDER BY user_id,capability")).rows, rows);
    assert.equal((await client.query("SELECT count(*)::int n FROM pg_constraint WHERE conname='operations_account_capability_grants_capability_check'")).rows[0].n, 0);
    // Retain every local row: move synthetic invalid value to an allowed capability.
    await client.query("UPDATE operations_account_capability_grants SET capability='operations_read' WHERE user_id=3");
  } finally { client.release(); }
  await ensurePermissionsSchema();
});

test("actual preset read/save/replay is audited and never activates or overwrites the global campaign", async () => {
  clock();
  const c = caller().shopSettings;
  const original = { ...campaign(), enabled: false, percentage: 11.5, labelDe: "Independent existing campaign" };
  await c.setGlobalAutomaticDiscount(original);
  const initial = await settings();
  await c.getGlobalAutomaticDiscountPresets(); await c.getGlobalAutomaticDiscountAdmin();
  assert.deepEqual(await settings(), initial);
  const edited = { ...draft(), name: "Stored operator draft", config: { ...draft().config, percentage: 37.25, coldShippingSurcharge: 12.5 } };
  await c.saveGlobalAutomaticDiscountPreset(edited); await c.saveGlobalAutomaticDiscountPreset(edited);
  assert.deepEqual((await c.getGlobalAutomaticDiscountPresets()).presets, [edited]);
  assert.deepEqual((await c.getGlobalAutomaticDiscountAdmin()).config, original);
  assert.equal((await c.getGlobalAutomaticDiscount()).discount, null);
  assert.deepEqual((await settings()).map((row) => row.key), ["global_automatic_discount", "global_automatic_discount_presets"]);
  const audit = await events();
  assert.equal(audit.length, 3);
  assert(audit.every((event) => event.actor === "product_manager"));
  assert.equal(audit[1].action, "shopSettings.saveGlobalAutomaticDiscountPreset");
  assert(!JSON.stringify(audit).includes(edited.name));
});

test("same campaign handlers read back/replay the approved Berlin schedule before/during/after expiry, without auto-disable", async () => {
  clock();
  const c = caller().shopSettings, input = campaign();
  const first = await c.setGlobalAutomaticDiscount(input), replay = await c.setGlobalAutomaticDiscount(input);
  assert.deepEqual(first, replay); assert.deepEqual(first.config, input); assert.equal(first.discount, null);
  const unchanged = await settings();
  for (const [now, active] of [
    ["2026-11-12T22:59:59.999Z", false], ["2026-11-12T23:00:00.000Z", true],
    ["2026-11-13T12:00:00.000Z", true], ["2026-11-13T22:59:59.999Z", true],
    ["2026-11-13T23:00:00.000Z", false], ["2026-11-14T12:00:00.000Z", false],
  ] as const) {
    mock.timers.setTime(Date.parse(now));
    assert.deepEqual((await c.getGlobalAutomaticDiscountAdmin()).config, input);
    assert.equal(Boolean((await c.getGlobalAutomaticDiscount()).discount), active);
    assert.equal((await c.getGlobalAutomaticDiscountPresets()).presets[0].config.enabled, false);
    assert.deepEqual(await settings(), unchanged);
  }
  await assert.rejects(c.setGlobalAutomaticDiscount(input), /Zukunft/);
  assert.deepEqual(await settings(), unchanged);
  await c.saveGlobalAutomaticDiscountPreset(draft()); // Disabled templates remain saveable after expiry.
  assert.deepEqual((await c.getGlobalAutomaticDiscountAdmin()).config, input);
});

test("native strict validation and deferred config merge reject invalid writes without persistence or audit", async () => {
  clock();
  const c = caller().shopSettings;
  await c.setGlobalAutomaticDiscount(campaign());
  const snapshot = await settings(), audit = await events();
  for (const input of [
    { ...campaign(), percentage: 101 }, { ...campaign(), coldShippingSurcharge: -1 },
    { ...campaign(), freeShippingMinOrder: -1 }, { ...campaign(), freeShippingRegions: ["us"] },
    { ...campaign(), expiresAt: null }, { ...campaign(), startsAt: campaign().expiresAt },
    { ...campaign(), expiresAt: "2026-11-11T23:00:00.000Z" },
    { ...campaign(), freeShippingRegions: [] },
    { ...campaign(), meta: { admin: true } }, { ...campaign(), shop_open: true },
  ]) await assert.rejects(c.setGlobalAutomaticDiscount(input as any));
  for (const input of [
    { ...draft(), config: { ...draft().config, enabled: true } },
    { ...draft(), config: { ...draft().config, exclusiveCampaign: false } },
    { ...draft(), config: { ...draft().config, percentage: -1 } },
    { ...draft(), config: { ...draft().config, freeShippingRegions: [] } },
    { ...draft(), metadata: { capability: "campaign_settings" } },
  ]) await assert.rejects(c.saveGlobalAutomaticDiscountPreset(input as any));
  // Optional input fields must not discard stored start/free-shipping invariants.
  await assert.rejects(c.setGlobalAutomaticDiscount({ enabled: true, percentage: 20,
    expiresAt: "2026-11-12T22:00:00.000Z", stackWithPromotionCodes: false }), /Startzeitpunkt/);
  assert.deepEqual(await settings(), snapshot); assert.deepEqual(await events(), audit);
  const saved = await c.setGlobalAutomaticDiscount({ enabled: false, percentage: 21,
    expiresAt: campaign().expiresAt, stackWithPromotionCodes: false });
  assert.equal(saved.config.startsAt, campaign().startsAt);
  assert.deepEqual(saved.config.freeShippingRegions, campaign().freeShippingRegions);
  assert.equal(saved.config.coldShippingSurcharge, campaign().coldShippingSurcharge);
});

test("every unrelated shop-settings admin guard remains unchanged and the campaign grant gives no customers/payments/admin access", async () => {
  clock();
  const c = caller(), s = c.shopSettings;
  for (const operation of [
    () => s.getBankTransferPaymentInstructions(), () => s.setBankTransferPaymentInstructions({} as any),
    () => s.setWhatsAppChannelConfig({} as any), () => s.getPackingAutomationConfig(),
    () => s.setPackingAutomationConfig({} as any), () => s.toggleShop({ open: false }),
    () => s.getAll(), () => s.setPromo2for3({ enabled: true }),
    () => s.set({ key: "shop_open", value: "false" }),
    () => s.set({ key: "global_automatic_discount", value: "{}" }),
    () => c.customer.create({ name: "Never created" }), () => c.order.matchBunqPayments(),
    () => c.order.bunqPayments(),
  ]) await assert.rejects(operation(), forbidden);
  // No user-management router exists; the unmodified shared admin guard cannot be
  // bypassed by principal metadata, header metadata, or this campaign grant.
  const adminOnly = router({ probe: adminProcedure.query(() => "admin") });
  await assert.rejects(adminOnly.createCaller({ ...context({ ...user, meta: { role: "admin" } }),
    req: { headers: { "x-role": "admin", "x-capability": "campaign_settings" } } } as any).probe(), forbidden);
  const source = readFileSync(new URL("./shopSettingsRouter.ts", import.meta.url), "utf8");
  assert.deepEqual([...source.matchAll(/^  (\w+): adminProcedure/gm)].map((match) => match[1]), [
    "getBankTransferPaymentInstructions", "setBankTransferPaymentInstructions", "setWhatsAppChannelConfig",
    "getPackingAutomationConfig", "setPackingAutomationConfig", "toggleShop", "getAll", "setPromo2for3", "set",
  ]);
  assert.deepEqual([...source.matchAll(/^  (\w+): scopedCampaignProcedure/gm)].map((match) => match[1]), [
    "getGlobalAutomaticDiscountPresets", "saveGlobalAutomaticDiscountPreset", "getGlobalAutomaticDiscountAdmin", "setGlobalAutomaticDiscount",
  ]);
  assert(!source.includes(".meta("));
  assert.deepEqual(await settings(), []); assert.deepEqual(await events(), []);
  assert.equal((await pool.query("SELECT count(*)::int n FROM customers")).rows[0].n, 0);
  for (const table of ["users", "customer_communications", "orders"]) {
    const rows = (await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;
    assert.equal(rows, table === "users" ? 2 : 0);
  }
});
