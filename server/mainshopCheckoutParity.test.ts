import assert from "node:assert/strict";
import test, { before, beforeEach, after, mock } from "node:test";
import pg from "pg";
import { orderRouter } from "./orderRouter.js";
import { closeDb } from "./db.js";
import { ENV } from "./env.js";
import { createKwkToken, createKwkDemoToken } from "./kwkAuth.js";
import { createPartnerToken } from "./partnerAuth.js";
import { checkoutFingerprint } from "./priorityOrderIntegrity.js";
import { quantityPricing, allocateMoney } from "./mainshopCanonicalPricing.js";

// Driver boundary only. The actual router, schemas, catalog resolver, all pricing,
// transaction orchestration, stock movement and durable receipt code execute.
// No socket, real DB, external address request, mail or payment can escape.
type Row = Record<string, any>;
let data: Record<string, Row[]>;
let calls: string[], writes: string[], readonly = false, committed = 0, fetches = 0;
let snapshot: Record<string, Row[]> | null;
let publicProgram: Row | null;
let priorPaid = false, failItem = false, blockCustomer = false, existingKwkOrder = false, claimFailure = false;
let selfProgram: Row;
let beforeWriteTransaction: (() => void) | null = null;
const originalUrl = ENV.databaseUrl;
const originalSecret = ENV.jwtSecret;
const article = (id: number, sku: string, shop: string, price: string, category = "Peptide", name = `${sku} 5 mg`): Row => ({ id, sku, shop_product_id: shop, name, selling_price: price, sale_price: null, category, categories: [category], variants: [{ dosage: "5 mg", price: Number(price), sku }], is_active: 1, shop_visible: 1, stock: 1000 });
function result(text: string, values: any[] = [], rowMode?: string): { rows: any[]; rowCount: number } {
  calls.push(text);
  if (/^begin/i.test(text)) { readonly = /READ ONLY/i.test(text); if (!readonly) beforeWriteTransaction?.(); snapshot = structuredClone(data); return { rows: [], rowCount: 0 }; }
  if (/^commit/i.test(text)) { if (!readonly) committed++; readonly = false; snapshot = null; return { rows: [], rowCount: 0 }; }
  if (/^rollback/i.test(text)) { if (snapshot) data = snapshot; readonly = false; snapshot = null; return { rows: [], rowCount: 0 }; }
  if (/^SET LOCAL/i.test(text)) return { rows: [], rowCount: 0 };
  if (!/^\s*select\b/i.test(text)) {
    if (readonly) throw Error("READONLY_WRITE_ATTEMPT");
    writes.push(text);
    const insert = text.match(/^insert into "?([a-z_]+)"?\s*\(([^)]+)\)\s*values\s*\((.*?)\)(?:\s|$)/is);
    if (insert) {
      if (failItem && insert[1] === "order_items") throw Error("INJECTED_ITEM_FAILURE");
      const [, table, columns, terms] = insert;
      const row: Row = { id: (data[table]?.length || 0) + 1 };
      columns.split(",").forEach((col, n) => {
        const term = terms.split(",")[n]?.trim() || "default";
        const param = term.match(/^\$(\d+)/);
        row[col.trim().replaceAll('"', '')] = param ? values[Number(param[1]) - 1] : /^'[^']*'$/.test(term) ? term.slice(1, -1) : null;
      });
      if (table === "orders") { row.status = "offen"; row.kwk_credit_used ??= "0"; row.credit_used ??= "0"; }
      if (table === "priority_checkout_receipts") row.response = JSON.parse(row.response);
      (data[table] ||= []).push(row);
      return project(text, [row], rowMode);
    }
    if (/^update "articles"/i.test(text)) {
      const a = data.articles.find(a => a.id === values[values.length - 1]);
      if (a) a.stock += Number(values[0]);
      return { rows: [], rowCount: 1 };
    }
    if (/^update priority_order_tasks/i.test(text)) {
      // Deny every postcommit claim: obligations stay durable, external work never runs.
      if (claimFailure) throw Error("INJECTED_POSTCOMMIT_TASK_FAILURE");
      return { rows: [], rowCount: 0 };
    }
    if (/^update "promo_codes"/i.test(text)) return project(text, [{ id: 1 }], rowMode);
    if (/^update partners SET credit_balance/i.test(text)) { data.partners.find(p => p.id === values[1])!.credit_balance = values[0]; return { rows: [], rowCount: 1 }; }
    if (/^update orders SET kwk_credit_used/i.test(text)) { data.orders.find(p => p.order_id === values[1])!.kwk_credit_used = values[0]; return { rows: [], rowCount: 1 }; }
    if (/^update kwk_accounts SET/i.test(text)) { Object.assign(data.kwk_accounts.find(p => p.id === values[3])!, { credit_pending: values[0], credit_available: values[1], credit_redeemed: values[2] }); return { rows: [], rowCount: 1 }; }
    if (/^update "orders"/i.test(text)) return { rows: [], rowCount: 1 };
    throw Error(`UNEXPECTED_WRITE:${text}`);
  }
  if (/pg_advisory|hashtextextended/i.test(text)) return { rows: [], rowCount: 0 };
  if (/next_order_id\(\)/i.test(text)) return { rows: [{ order_id: "369-OFFLINE-1" }], rowCount: 1 };
  if (/next_customer_number\(\)/i.test(text)) return { rows: [{ number: "1210" }], rowCount: 1 };
  if (/FROM partner_codes pc\s+JOIN/i.test(text)) return { rows: publicProgram && values[0] === "CREATOR" ? [publicProgram] : [], rowCount: publicProgram ? 1 : 0 };
  if (/FROM partners p\s+JOIN partner_programs/i.test(text)) return { rows: [selfProgram], rowCount: 1 };
  if (/FROM orders o\s/i.test(text) && /paid_at/i.test(text)) return { rows: priorPaid ? [{ order_id: "OLD" }] : [], rowCount: priorPaid ? 1 : 0 };
  if (/FROM kwk_accounts|from kwk_accounts/i.test(text)) {
    const rows = data.kwk_accounts || [];
    const found = /referral_code/.test(text) ? rows.filter(r => r.referral_code === values[0]) : rows.filter(r => r.id === values[0] && (values.length < 2 || r.session_version === values[1]));
    return { rows: found.filter(r => r.status === "aktiv" && !r.deleted_at), rowCount: found.length };
  }
  if (/FROM kwk_ledger/i.test(text)) {
    if (/WHERE order_id/i.test(text)) return { rows: (data.kwk_ledger || []).filter(r => r.order_id === values[0]), rowCount: 0 };
    const used = (data.kwk_ledger || []).reduce((sum, r) => sum + Number(r.amount), 0);
    return { rows: [{ available: String(100 + used), pending: "0", redeemed_total: String(-used) }], rowCount: 1 };
  }
  if (/FROM partners WHERE/i.test(text)) {
    // Drizzle parameterizes each textual placeholder occurrence independently.
    const param = text.match(/id=\$(\d+)/)?.[1];
    const rows = data.partners.filter(p => p.id === values[Number(param) - 1]);
    return { rows, rowCount: rows.length };
  }
  if (/FROM partner_programs/i.test(text)) return { rows: [selfProgram], rowCount: 1 };
  if (/FROM partner_transactions/i.test(text)) return { rows: (data.partner_transactions || []).filter(p => p.order_id === values[0]), rowCount: 0 };
  if (/FROM customer_order_blocks|from customer_order_blocks/i.test(text)) return { rows: blockCustomer ? [{ id: 1, is_active: 1 }] : [], rowCount: blockCustomer ? 1 : 0 };
  const table = text.match(/\bfrom\s+"?([a-z_]+)"?/i)?.[1];
  let rows = structuredClone(data[table || ""] || []);
  if (table === "articles" && /"articles"\."id" = \$/.test(text)) rows = rows.filter(r => r.id === values[0]);
  if (table === "articles" && /"articles"\."shop_product_id" = \$/.test(text)) {
    const param = text.match(/"articles"\."shop_product_id" = \$(\d+)/)?.[1]; rows = rows.filter(r => r.shop_product_id === values[Number(param) - 1]);
  }
  if (table === "shop_settings" && /where/i.test(text)) { const literal = text.match(/key\s*=\s*'([^']+)'/i)?.[1]; rows = rows.filter(r => literal ? r.key === literal : values.includes(r.key)); }
  if (table === "promo_codes") rows = rows.filter(r => /"promo_codes"\."id" = \$/.test(text) ? r.id === values[0] : r.code === values[0] && r.is_active === 1);
  if (table === "priority_checkout_receipts") rows = rows.filter(r => r.intent_key === values[0]);
  if (table === "orders" && /where/i.test(text)) rows = existingKwkOrder ? [{ id: 77 }] : rows.filter(r => r.order_id === values[0]);
  if (table === "partners") rows = rows.filter(r => r.id === values[0] && r.is_active === 1 && r.session_version === values[2]);
  if (table === "customers") rows = [];
  if (table === "customer_order_blocks") rows = [];
  if (table === "kwk_accounts") rows = [];
  return project(text, rows, rowMode);
}
function project(text: string, rows: Row[], rowMode?: string) {
  if (rowMode !== "array") return { rows, rowCount: rows.length };
  const projection = (/^select\s+(.*?)\s+from\s/is.exec(text)?.[1] || /\breturning\s+(.*)$/is.exec(text)?.[1] || "");
  const columns = projection.split(/,\s*(?=(?:"|[a-z_]))/).map(s => [...s.matchAll(/"([a-z_]+)"/g)].at(-1)?.[1] || s.trim());
  return { rows: rows.map(r => columns.map(c => r[c] ?? null)), rowCount: rows.length };
}
const client = { query: async (q: string | Row, values?: any[]) => result(typeof q === "string" ? q : q.text, values || (typeof q === "object" ? q.values : []) || [], typeof q === "object" ? q.rowMode : undefined), release() {} };
before(async () => {
  mock.method(pg.Pool.prototype as any, "query", client.query);
  mock.method(pg.Pool.prototype as any, "connect", async () => client);
  mock.method(pg.Pool.prototype as any, "end", async () => {});
  mock.method(globalThis, "fetch", async () => { fetches++; throw Error("EXTERNAL_FETCH_FORBIDDEN"); });
  await closeDb(); ENV.databaseUrl = "postgresql://offline:offline@127.0.0.1:1/mock_no_socket"; ENV.jwtSecret = "offline-test-key-not-a-secret";
});
beforeEach(() => {
  calls = []; writes = []; readonly = false; committed = 0; fetches = 0; snapshot = null; publicProgram = null; priorPaid = false; failItem = false; blockCustomer = false; existingKwkOrder = false; claimFailure = false;
  beforeWriteTransaction = null;
  selfProgram = { key: "partner", label: "Partner", customer_discount_policy: "first_paid_code_use", commission_policy: "first_paid_code_order", settlement_method: "shop_credit", allow_self_order_credit: true, active: true };
  data = { articles: [article(1, "PEP-5MG", "pep", "100"), article(2, "ACC", "acc", "100", "Zubehör", "Zubehör"), article(3, "BAC-3ML", "bac-wasser-3ml", "5", "Zubehör", "BAC Wasser 3ml")],
    bundles: [], bundle_items: [], promo_codes: [], partners: [], orders: [], order_items: [], stock_history: [], priority_checkout_receipts: [], priority_order_tasks: [],
    substitution_config: [{ id: 1, enabled: false }], shop_settings: [{ key: "address_validation_enabled", value: "false" }] };
  data.articles[1].variants = []; data.articles[2].variants = [];
});
after(async () => { await closeDb(); ENV.databaseUrl = originalUrl; ENV.jwtSecret = originalSecret; mock.restoreAll(); });
const payload = (extra: Row = {}) => ({ items: [{ name: "Manipulated browser name", shopProductId: "pep", dosage: "5 mg", quantity: 4, price: 0.01, type: "accessory" }], customer: { firstName: "Ada", lastName: "Synthetic", email: "ada@example.test", phone: "030123456789", street: "Test", houseNumber: "1", zip: "10115", city: "Berlin", country: "DE" }, subtotal: 0.04, discount: 99999, discountCode: null, discountBreakdown: [{ source: "quantity_discount", label: "Manipulation", amount: 9999 }], shipping: 0, shippingCountry: "ch", total: 0, paymentMethod: "wise", date: "2026-11-10", ...extra });
const caller = (authorization?: string) => orderRouter.createCaller({ req: { headers: authorization ? { authorization } : {} }, res: {}, user: null } as any);
async function quote(extra: Row = {}, authorization?: string) {
  const value = await caller(authorization).quote(payload(extra) as any);
  assert.ok("quote" in value); assert.ok(value.quote);
  assert.equal(writes.length, 0); assert.equal(committed, 0); assert.equal(fetches, 0);
  assert.ok(calls.some(s => /BEGIN TRANSACTION.*READ ONLY/.test(s)));
  return value.quote;
}
function global(percent: number, extra: Row = {}) { data.shop_settings.push({ key: "global_automatic_discount", value: JSON.stringify({ enabled: true, percentage: percent, startsAt: null, expiresAt: "2099-01-01T00:00:00.000Z", freeShippingEnabled: false, freeShippingRegions: [], freeShippingMinOrder: 0, stackWithPromotionCodes: true, stackWithPartnerCreatorCodes: true, stackWithKwk: true, labelDe: "Dauerrabatt", labelEn: "Automatic", ...extra }) }); }
function promo(description = 'Synthetic | {"restrict":["acc"]}', percent = 20) { data.promo_codes.push({ id: 1, code: "PROMO", discount_type: "percent", percentage: String(percent), fixed_amount: "0", description, is_active: 1, min_order: "0", max_uses: 0, current_uses: 0, valid_from: null, valid_until: null }); }
for (const [units, percentage] of [[1, 0], [3, 0], [4, 10], [7, 10], [8, 20], [12, 20], [13, 25], [19, 25], [20, 30], [35, 30], [36, 35], [37, 35]]) test(`real quote handler: tier ${units} => ${percentage}%`, async () => {
  const q = await quote({ items: [{ ...payload().items[0], quantity: units }] });
  assert.equal(q.subtotal, units * 100); assert.equal(q.discount, units * percentage); assert.equal(q.total, units * 100 - units * percentage + 8);
  assert.equal(q.items.at(-1)?.isFreeGift, true); assert.equal(q.items.at(-1)?.quantity, units);
});
test("real quote and regular CREATE persist identical canonical prices, gifts and receipt", async () => {
  const q = await quote();
  const input = payload({ expectedQuoteHash: q.hash, checkoutIdempotencyKey: "a".repeat(64) });
  const out = await caller().create(input as any);
  assert.ok("success" in out && out.success); assert.ok("total" in out); assert.equal(out.total, 368);
  assert.equal(data.orders.length, 1); assert.equal(data.orders[0].subtotal, "400.00"); assert.equal(data.orders[0].discount, "40.00");
  assert.equal(data.order_items.length, 2); assert.equal(data.stock_history.length, 2);
  assert.equal(data.articles[0].stock, 996); assert.equal(data.articles[2].stock, 996);
  assert.equal(data.priority_checkout_receipts.length, 1); assert.equal(committed, 1); assert.equal(fetches, 0);
  const writeCount = writes.length;
  data.articles[0].selling_price = "200";
  const replay = await caller().create({ ...input, kwkCreditToken: "t".repeat(30), customerDataChangeConfirmationToken: "c".repeat(32), expectedQuoteHash: "f".repeat(64), date: "2027-01-01" } as any);
  assert.ok("total" in replay); assert.equal(replay.total, out.total); assert.equal(writes.length, writeCount); assert.equal(data.orders.length, 1);
  await assert.rejects(caller().create({ ...input, items: [{ ...input.items[0], quantity: 5 }] } as any), /CHECKOUT_INTENT_CONFLICT/);
});
test("regular create fails changed/missing quote before any writes", async () => {
  const q = await quote();
  await assert.rejects(caller().create(payload({ checkoutIdempotencyKey: "a".repeat(64) }) as any), /CHECKOUT_QUOTE_REQUIRED/);
  data.articles[0].selling_price = "200"; data.articles[0].variants[0].price = 200;
  await assert.rejects(caller().create(payload({ expectedQuoteHash: q.hash, checkoutIdempotencyKey: "a".repeat(64) }) as any), /CHECKOUT_QUOTE_CHANGED/);
  assert.equal(writes.length, 0); assert.equal(data.orders.length, 0);
});
for (const [restriction, expectedDiscount, expectedTotal] of [["acc", 104, 404], ["pep", 150.8, 357.2]] as const) test(`real restricted promo uses ${restriction}'s actual residual value`, async () => {
  global(10); promo(`Synthetic | {"restrict":["${restriction}"]}`);
  const q = await quote({ discountCode: "promo", items: [...payload().items, { name: "Fake peptide", shopProductId: "acc", price: 1, quantity: 1, type: "peptide" }] });
  assert.equal(q.subtotal, 500); assert.equal(q.discount, expectedDiscount); assert.equal(q.total, expectedTotal);
  assert.equal(q.discountBreakdown.find(e => e.source === "automatic_global_percent")?.amount, 46);
});
test("actual sale remains quantity eligible; 15 euro format surcharge and no cold shipping", async () => {
  data.articles[0].sale_price = "10";
  const q = await quote({ items: [{ ...payload().items[0], isPlugPlay: true }] });
  assert.equal(q.subtotal, 100); assert.equal(q.discount, 10); assert.equal(q.shipping, 8); assert.equal(q.items.length, 1);
});
test("BAC/accessories excluded regardless of forged type; native 369PEN counts", async () => {
  data.articles.push(article(4, "369PEN", "forscherpen", "40", "Forscherpens", "369PEN"));
  const q = await quote({ items: [{ ...payload().items[0], quantity: 3 }, { name: "Pen", shopProductId: "forscherpen", quantity: 1, price: 0, type: "accessory" }, { name: "Peptide", shopProductId: "acc", quantity: 100, price: 1, type: "peptide" }, { name: "Peptide", shopProductId: "bac-wasser-3ml", quantity: 100, price: 1, type: "peptide" }] });
  assert.equal(q.discount, 34); assert.equal(q.items.at(-1)?.quantity, 3);
});
function bundle() { data.articles.push(article(4, "SECOND-5MG", "second", "100")); data.bundles = [{ id: 1, name: "Canonical Offer", discount_percent: "25", is_active: 1, allows_plug_play: 0, allows_nasal_spray: 0 }]; data.bundle_items = [{ bundle_id: 1, article_sku: "PEP-5MG", quantity: 1, is_free_gift: 0, fixed_dosage_mg: 5 }, { bundle_id: 1, article_sku: "SECOND-5MG", quantity: 1, is_free_gift: 0, fixed_dosage_mg: 5 }]; return [{ ...payload().items[0], quantity: 1, bundleId: 1, bundleGroup: "group" }, { ...payload().items[0], shopProductId: "second", quantity: 1, bundleId: 1, bundleGroup: "group" }]; }
test("complete reduced actual WaWi bundle counts ONE and receives no second quantity reduction", async () => {
  const items = bundle();
  const q = await quote({ items: [...items, { ...payload().items[0], quantity: 3 }] });
  assert.equal(q.subtotal, 450); assert.equal(q.discount, 30); assert.equal(q.total, 428); assert.equal(q.items[0].price, 75); assert.equal(q.items.at(-1)?.quantity, 5);
});
test("client Bundle label cannot claim reduced bundle or alter quantity eligibility", async () => {
  const q = await quote({ items: [{ ...payload().items[0], variant: "Bundle: made up" }] });
  assert.equal(q.discount, 40); assert.equal(q.subtotal, 400);
});
for (const manipulation of ["missing", "unknown", "unequal", "wrongsku", "wrongdose", "format"]) test(`actual bundle rejects ${manipulation} composition`, async () => {
  const items = bundle();
  if (manipulation === "missing") items.pop();
  if (manipulation === "unknown") items[0].bundleId = 999;
  if (manipulation === "unequal") items[0].quantity = 2;
  if (manipulation === "wrongsku") items[1].shopProductId = "acc";
  if (manipulation === "wrongdose") items[0].dosage = "10 mg";
  if (manipulation === "format") (items[0] as any).isPlugPlay = true;
  await assert.rejects(caller().quote(payload({ items }) as any), /CHECKOUT_(BUNDLE|CATALOG)/); assert.equal(writes.length, 0);
});
for (const scope of ["peps4pets", "wawi_manual", "checkout-v2"]) test(`new quote never impersonates ${scope}`, async () => {
  await assert.rejects(caller().quote(payload(scope === "wawi_manual" ? { orderSource: scope } : { storeKey: scope }) as any), /CHECKOUT_QUOTE_SCOPE_INVALID|quantity_discount is reserved/); assert.equal(calls.length, 0);
});
for (const [country, shipping] of [["DE", 8], ["FR", 15], ["CH", 18]]) test(`real quote canonical shipping ${country}`, async () => {
  const q = await quote({ customer: { ...payload().customer, country } }); assert.equal(q.shipping, shipping);
});
test("global nonstack preserves promo, removes BOTH global advantages; promo frees shipping", async () => {
  global(10, { freeShippingEnabled: true, freeShippingRegions: ["de"], freeShippingMinOrder: 300, stackWithPromotionCodes: false }); promo('Synthetic | {"freeShipping":["de"]}', 20);
  const q = await quote({ discountCode: "PROMO" }); assert.equal(q.shipping, 0); assert.equal(q.discount, 112); assert.equal(q.discountBreakdown.some(e => e.source === "automatic_global_percent"), false);
});
test("central global free shipping threshold keeps PRE-discount merchandise policy", async () => {
  global(10, { freeShippingEnabled: true, freeShippingRegions: ["de"], freeShippingMinOrder: 400 });
  const q = await quote(); assert.equal(q.shipping, 0); assert.equal(q.discount, 76); assert.equal(q.total, 324);
});
for (const invalid of ["expired", "future", "minimum", "exhausted"]) test(`real promo rejects ${invalid} before any write`, async () => {
  promo(); if (invalid === "expired") data.promo_codes[0].valid_until = new Date("2000-01-01"); if (invalid === "future") data.promo_codes[0].valid_from = new Date("2099-01-01"); if (invalid === "minimum") data.promo_codes[0].min_order = "401"; if (invalid === "exhausted") { data.promo_codes[0].max_uses = 1; data.promo_codes[0].current_uses = 1; }
  await assert.rejects(caller().quote(payload({ discountCode: "PROMO" }) as any), /AKTIONSCODE_UNGUELTIG/); assert.equal(writes.length, 0);
});
test("arbitrary free gift and unknown variant cannot become free paid products", async () => {
  await assert.rejects(caller().quote(payload({ items: [{ ...payload().items[0], isFreeGift: true }] }) as any), /CHECKOUT_UNTRUSTED_GIFT/);
  await assert.rejects(caller().quote(payload({ items: [{ ...payload().items[0], dosage: "99 mg" }] }) as any), /CHECKOUT_CATALOG_VARIANT_INVALID/);
  assert.equal(writes.length, 0);
});
test("exact cent allocation and quote fingerprint transport refresh", () => {
  assert.deepEqual(allocateMoney(0.01, [0.01, 0.01, 0.01]), [0.01, 0, 0]);
  const q = quantityPricing([{ name: "x", price: 0.01, quantity: 4, type: "peptide" }], [true], 4); assert.equal(q.amount, 0); assert.equal(q.lineValues[0], 0.04);
  assert.equal(checkoutFingerprint(payload()), checkoutFingerprint(payload({ kwkCreditToken: "renewed", expectedQuoteHash: "different", date: "later" })));
});

function creator(policy = "each_valid_code_use", commission = "each_paid_code_order") {
  publicProgram = { partner_code_id: 8, partner_id: 9, partner_name: "Synthetic Creator", partner_code: "CREATOR", partner_number: "OWN-9", partner_email: "owner@example.test", commission_percent: "15", customer_discount_percent: "10", program_key: "creator", label: "Creator", customer_discount_policy: policy, commission_policy: commission, settlement_method: "payout", allow_self_order_credit: false, active: true };
}
test("native reusable creator code stacks AFTER quantity/global/restricted promo on actual residual", async () => {
  creator(); priorPaid = true; global(10); promo('Synthetic | {"restrict":["acc"]}');
  const q = await quote({ partnerCode: "creator", discountCode: "PROMO", items: [...payload().items, { name: "Accessory", shopProductId: "acc", price: 1, quantity: 1, type: "peptide" }] });
  assert.equal(q.partnerDiscount, 39.6); assert.equal(q.discount, 143.6); assert.equal(q.total, 364.4);
});
test("native first paid code policy suppresses repeat discount but not valid attribution", async () => {
  creator("first_paid_code_use", "first_paid_code_order"); priorPaid = true;
  const q = await quote({ partnerCode: "CREATOR" }); assert.equal(q.partnerDiscount, 0); assert.equal(q.discount, 40);
});
test("native own-email partner policy rejects unrelated benefit without trusting browser amount", async () => {
  creator("own_email_only", "none"); const q = await quote({ partnerCode: "CREATOR", partnerDiscount: 999 }); assert.equal(q.partnerDiscount, 0);
});
test("native partner-number is not an auth credential and mixed public-code credit is rejected", async () => {
  await assert.rejects(caller().quote(payload({ partnerNumber: "OWN-9", creditUsed: 1 }) as any), /PARTNER_GUTHABEN_AUTHENTIFIZIERUNG_ERFORDERLICH/);
  await assert.rejects(caller().quote(payload({ partnerCode: "CREATOR", creditUsed: 1 }) as any), /PARTNER_CODE_SELBSTBESTELLUNG_AUSGESCHLOSSEN/); assert.equal(writes.length, 0);
});
function selfOwner() { data.partners = [{ id: 9, name: "Synthetic", partner_number: "OWN-9", email: "ada@example.test", commission_percent: "15", customer_discount_percent: "10", credit_balance: "100", is_active: 1, session_version: 0, program_key: "partner" }]; return `Bearer ${createPartnerToken(9)}`; }
test("native authenticated selforder shop credit follows quantity/global/self discount and retains credit", async () => {
  const auth = selfOwner(); global(10); const q = await quote({ partnerNumber: "OWN-9", creditUsed: 20 }, auth);
  assert.equal(q.partnerDiscount, 32.4); assert.equal(q.creditUsed, 20); assert.equal(q.discount, 128.4); assert.equal(q.total, 279.6);
});
test("native payout Creator selforder converts customer plus commission discount, credit excluded", async () => {
  const auth = selfOwner(); selfProgram = { ...selfProgram, key: "creator", settlement_method: "payout", allow_self_order_credit: false };
  const q = await quote({ partnerNumber: "OWN-9" }, auth); assert.equal(q.partnerDiscount, 90); assert.equal(q.total, 278);
  await assert.rejects(caller(auth).quote(payload({ partnerNumber: "OWN-9", creditUsed: 1 }) as any), /PARTNER_GUTHABEN_PROGRAMM_AUSGESCHLOSSEN/);
});
test("native revoked selforder session and requested credit over balance fail closed", async () => {
  const auth = selfOwner(); data.partners[0].session_version = 1;
  await assert.rejects(caller(auth).quote(payload({ partnerNumber: "OWN-9" }) as any), /PARTNER_GUTHABEN_AUTHENTIFIZIERUNG_ERFORDERLICH/);
  data.partners[0].session_version = 0;
  await assert.rejects(caller(auth).quote(payload({ partnerNumber: "OWN-9", creditUsed: 101 }) as any), /PARTNER_GUTHABEN_NICHT_AUSREICHEND/); assert.equal(writes.length, 0);
});
function kwkAccount() { data.kwk_accounts = [{ id: 7, referral_code: "KWK-7", email: "referrer@example.test", phone: "0170123123", status: "aktiv", deleted_at: null, session_version: 0 }]; data.shop_settings.push({ key: "kwk_enabled", value: "true" }); }
test("native KWK first-customer referral uses actual residual after quantity/global/promo", async () => {
  kwkAccount(); global(10); promo('Synthetic | {"restrict":["pep"]}');
  const q = await quote({ kwkCode: "KWK-7", discountCode: "PROMO" }); assert.equal(q.kwkDiscount, 25.92); assert.equal(q.discount, 166.72); assert.equal(q.total, 241.28);
});
test("native KWK existing customer and self-referral reject before writes", async () => {
  kwkAccount(); existingKwkOrder = true;
  await assert.rejects(caller().quote(payload({ kwkCode: "KWK-7" }) as any), /KWK_NUR_NEUKUNDEN/);
  existingKwkOrder = false; data.kwk_accounts[0].email = payload().customer.email;
  await assert.rejects(caller().quote(payload({ kwkCode: "KWK-7" }) as any), /KWK_SELBSTWERBUNG_NICHT_ERLAUBT/); assert.equal(writes.length, 0);
});
test("native KWK credit requires active productive session; browser account id is ignored", async () => {
  kwkAccount(); const q = await quote({ kwkCreditUsed: 20, kwkCreditKwkId: 999, kwkCreditToken: createKwkToken(7) }); assert.equal(q.kwkCreditUsed, 20); assert.equal(q.total, 348);
  await assert.rejects(caller().quote(payload({ kwkCreditUsed: 20, kwkCreditToken: createKwkDemoToken(7) }) as any), /KWK_GUTHABEN_AUTHENTIFIZIERUNG_ERFORDERLICH/);
  data.kwk_accounts[0].session_version = 1;
  await assert.rejects(caller().quote(payload({ kwkCreditUsed: 20, kwkCreditToken: createKwkToken(7) }) as any), /KWK_GUTHABEN_AUTHENTIFIZIERUNG_ERFORDERLICH/);
});
test("native KWK partner combination and referral-plus-credit stay excluded", async () => {
  kwkAccount(); creator();
  await assert.rejects(caller().quote(payload({ kwkCode: "KWK-7", partnerCode: "CREATOR" }) as any), /KWK_PARTNER_AUSGESCHLOSSEN/);
  await assert.rejects(caller().quote(payload({ kwkCode: "KWK-7", kwkCreditUsed: 1 }) as any), /KWK_NEUKUNDENRABATT_UND_GUTHABEN_NICHT_KOMBINIERBAR/); assert.equal(writes.length, 0);
});
test("regular actual create rolls stock/order/receipt back on item failure; same intent retryable", async () => {
  const q = await quote(); const input = payload({ expectedQuoteHash: q.hash, checkoutIdempotencyKey: "b".repeat(64) }); failItem = true;
  await assert.rejects(caller().create(input as any), /INJECTED_ITEM_FAILURE|Failed query/);
  assert.equal(data.orders.length, 0); assert.equal(data.priority_checkout_receipts.length, 0); assert.equal(data.stock_history.length, 0); assert.equal(data.articles[0].stock, 1000);
  failItem = false; const out = await caller().create(input as any); assert.ok("success" in out && out.success); assert.equal(data.orders.length, 1);
});
test("regular actual create postcommit response-task failure still returns success and durable receipt", async () => {
  const q = await quote(); const input = payload({ expectedQuoteHash: q.hash, checkoutIdempotencyKey: "c".repeat(64) }); claimFailure = true;
  const out = await caller().create(input as any); assert.ok("success" in out && out.success); assert.equal(data.priority_checkout_receipts.length, 1); assert.equal(data.orders.length, 1);
  const count = writes.length; const replay = await caller().create(input as any); assert.equal(replay.orderId, out.orderId); assert.equal(writes.length, count);
});
test("regular actual stock groups paid and gift BAC demand in same transaction", async () => {
  const extra = { items: [...payload().items, { name: "BAC", shopProductId: "bac-wasser-3ml", price: 1, quantity: 2, type: "peptide" }] };
  const q = await quote(extra); data.articles[2].stock = 5;
  await assert.rejects(caller().create(payload({ ...extra, expectedQuoteHash: q.hash, checkoutIdempotencyKey: "a".repeat(64) }) as any), /Bestand|ORDER_STOCK/); assert.equal(data.orders.length, 0); assert.equal(data.articles[0].stock, 1000);
  data.articles[2].stock = 6; await caller().create(payload({ ...extra, expectedQuoteHash: q.hash, checkoutIdempotencyKey: "a".repeat(64) }) as any); assert.equal(data.articles[2].stock, 0);
});

test("regular CREATE native partner credit/commission snapshot/debit commit together", async () => {
  const auth = selfOwner(); global(10); const extra = { partnerNumber: "OWN-9", creditUsed: 20 }; const q = await quote(extra, auth);
  const out = await caller(auth).create(payload({ ...extra, expectedQuoteHash: q.hash, checkoutIdempotencyKey: "d".repeat(64) }) as any);
  assert.ok("success" in out && out.success); assert.equal(data.partner_transactions.length, 1); assert.equal(data.partners[0].credit_balance, "80.00");
  assert.equal(data.orders[0].partner_commission_base_snapshot, "291.60"); assert.equal(data.orders[0].partner_commission, "43.74"); assert.equal(data.orders[0].credit_used, "20.00");
  const count = writes.length; await caller(auth).create(payload({ ...extra, expectedQuoteHash: q.hash, checkoutIdempotencyKey: "d".repeat(64) }) as any); assert.equal(writes.length, count);
});
test("regular CREATE native KWK productive owner/debit/cache stays atomic and ignores browser id", async () => {
  kwkAccount(); const extra = { kwkCreditUsed: 20, kwkCreditKwkId: 999, kwkCreditToken: createKwkToken(7) }; const q = await quote(extra);
  const input = payload({ ...extra, expectedQuoteHash: q.hash, checkoutIdempotencyKey: "e".repeat(64) }); const out = await caller().create(input as any);
  assert.ok("success" in out && out.success); assert.equal(data.orders[0].kwk_credit_owner_id, 7); assert.equal(data.kwk_ledger.length, 1); assert.equal(data.kwk_ledger[0].amount, "-20.00"); assert.equal(data.kwk_accounts[0].credit_available, "80.00");
  const count = writes.length; await caller().create({ ...input, kwkCreditToken: createKwkToken(7) } as any); assert.equal(writes.length, count);
});
for (const malformed of ["inactive", "noidentity", "nocategory"]) test(`actual canonical catalog rejects ${malformed} rather than trusting type/name`, async () => {
  if (malformed === "inactive") data.articles[0].is_active = 0;
  if (malformed === "noidentity") data.articles[0].shop_product_id = "other";
  if (malformed === "nocategory") { data.articles[0].category = null; data.articles[0].categories = []; }
  await assert.rejects(caller().quote(payload() as any), /CHECKOUT_CATALOG/); assert.equal(writes.length, 0);
});
test("real cheap qualifying vial gets BAC independent of price; forged client gift quantity removed", async () => {
  data.articles[0].selling_price = "1"; data.articles[0].variants[0].price = 1;
  const q = await quote({ items: [...payload().items, { name: "BAC Wasser 3ml (GRATIS)", shopProductId: "bac-wasser-3ml", price: 0, quantity: 99999, type: "accessory", isFreeGift: true }] });
  assert.equal(q.subtotal, 4); assert.equal(q.discount, 0.4); assert.equal(q.items.at(-1)?.quantity, 4);
});
test("real fixed restricted code capped at actual eligible residual, never borrows other merchandise", async () => {
  global(10); promo(); data.promo_codes[0].discount_type = "fixed"; data.promo_codes[0].fixed_amount = "999";
  const q = await quote({ discountCode: "PROMO", items: [...payload().items, { name: "Accessory", shopProductId: "acc", price: 1, quantity: 1, type: "peptide" }] });
  assert.equal(q.discountBreakdown.find(e => e.source === "promotion_code")?.amount, 90); assert.equal(q.total, 332);
});
test("actual handler fractional-cent stack conserves subtotal, breakdown and payable total", async () => {
  data.articles[0].selling_price = "0.07"; data.articles[0].variants[0].price = 0.07; global(10); promo('Synthetic | {"restrict":["pep"]}', 20);
  const q = await quote({ discountCode: "PROMO" }); assert.equal(q.subtotal, 0.28); assert.equal(q.discount, 0.1); assert.equal(q.total, 8.18);
  assert.equal(Math.round(q.discountBreakdown.reduce((sum, e) => sum + e.amount, 0) * 100), Math.round(q.discount * 100));
});

// Regression matrix for the independently reproduced findings (actual tRPC handler).
test("H1 hash binds customer address, delivery, payment and zero-value/full code intent", async () => {
  const base = await quote();
  for (const customer of [{ street: "Different" }, { email: "different@example.test" }, { deliveryType: "packstation", dhlPostNumber: "1234567" }, { houseNumber: "2" }]) {
    assert.notEqual((await quote({ customer: { ...payload().customer, ...customer } })).hash, base.hash);
  }
  assert.notEqual((await quote({ paymentMethod: "SEPA" })).hash, base.hash);
  promo('Synthetic | {"freeShipping":[]}', 0);
  assert.notEqual((await quote({ discountCode: "PROMO" })).hash, base.hash);
  assert.equal((await quote({ discountCode: " promo " })).hash, (await quote({ discountCode: "PROMO" })).hash);
});
test("H1 hash binds actual server principal but tolerates refreshed credentials/proofs/key/date", async () => {
  const base = await quote(); const auth = selfOwner();
  const owned = await quote({}, auth); assert.notEqual(owned.hash, base.hash);
  assert.equal((await quote({ checkoutIdempotencyKey: "f".repeat(64), expectedQuoteHash: "e".repeat(64), date: "2030-01-01", customerDataChangeConfirmationToken: "c".repeat(32), addressValidationOverride: { confirmed: true } }, auth)).hash, owned.hash);
  kwkAccount();
  const kwk = await quote({ kwkCreditToken: createKwkToken(7) }); assert.notEqual(kwk.hash, base.hash);
  assert.equal((await quote({ kwkCreditToken: createKwkToken(7), kwkCreditKwkId: 999 })).hash, kwk.hash);
  assert.equal(JSON.stringify(kwk).includes("kwkCreditToken"), false);
});
test("H3 missing/invalid idempotency key fails before database reads, number or write", async () => {
  const q = await quote(); calls = [];
  for (const key of [undefined, "short-key-123", "g".repeat(64)]) {
    await assert.rejects(caller().create(payload({ expectedQuoteHash: q.hash, checkoutIdempotencyKey: key }) as any), /CHECKOUT_INTENT_KEY_REQUIRED|CHECKOUT_INTENT_KEY_INVALID/);
    assert.equal(calls.length, 0); assert.equal(writes.length, 0);
  }
});
function twoDosages() {
  data.articles[0].selling_price = "50"; data.articles[0].sale_price = "40";
  data.articles[0].variants = [{ dosage: "5 mg", price: 50, sku: "PEP-5MG" }, { dosage: "10 mg", price: 100, sku: "PEP-10MG" }];
  data.articles.push({ ...article(4, "PEP-10MG", "pep", "100", "Peptide", "Canonical 10 mg"), shop_visible: 0, variants: [] });
}
for (const reverse of [false, true]) test(`H2 exact selected hidden 10mg inventory retains 100 price, never 5mg sale; reverse=${reverse}`, async () => {
  twoDosages(); if (reverse) data.articles.reverse();
  const extra = { items: [{ ...payload().items[0], dosage: "10 mg" }] };
  const q = await quote(extra); assert.equal(q.items[0].price, 100); assert.equal(q.subtotal, 400); assert.equal(q.items[0].shopProductId, "PEP-10MG");
  await caller().create(payload({ ...extra, expectedQuoteHash: q.hash, checkoutIdempotencyKey: "f".repeat(64) }) as any);
  assert.equal(data.articles.find(a => a.sku === "PEP-10MG")!.stock, 996);
  assert.equal(data.articles.find(a => a.sku === "PEP-5MG")!.stock, 1000);
});
test("H2 exact SKU cannot broaden into other dosage or unrelated configured inventory", async () => {
  twoDosages();
  await assert.rejects(caller().quote(payload({ items: [{ ...payload().items[0], shopProductId: "PEP-5MG", dosage: "10 mg" }] }) as any), /CHECKOUT_CATALOG_SKU_DOSAGE_MISMATCH/);
  data.articles[0].variants[1].sku = "ACC";
  await assert.rejects(caller().quote(payload({ items: [{ ...payload().items[0], dosage: "10 mg" }] }) as any), /CHECKOUT_CATALOG_VARIANT_INVENTORY_REQUIRED/);
});
test("H2 canonical configured price works without optional SKU, no missing inventory fallback", async () => {
  twoDosages(); delete data.articles[0].variants[1].sku; data.articles[0].variants[1].price = 105;
  assert.equal((await quote({ items: [{ ...payload().items[0], dosage: "10 mg" }] })).items[0].price, 105);
  data.articles = data.articles.filter(a => a.sku !== "PEP-10MG");
  await assert.rejects(caller().quote(payload({ items: [{ ...payload().items[0], dosage: "10 mg" }] }) as any), /CHECKOUT_CATALOG_VARIANT_INVENTORY_REQUIRED/);
});
for (const flags of [{ isPlugPlay: true, isNasalSpray: true }, { isPlugPlay: true, isNasalDiySet: true }, { isNasalSpray: true }, { isNasalDiySet: true }]) test(`H5 unsupported/exclusive format ${JSON.stringify(flags)}`, async () => {
  await assert.rejects(caller().quote(payload({ items: [{ ...payload().items[0], ...flags }] }) as any), /CHECKOUT_FORMAT/); assert.equal(writes.length, 0);
});
test("H5 hidden standalone and hidden family parent fail; visible parent permits exact proved child", async () => {
  data.articles[0].shop_visible = 0;
  await assert.rejects(caller().quote(payload() as any), /CHECKOUT_CATALOG_NOT_VISIBLE/);
  data.articles[0].shop_visible = 1; twoDosages();
  assert.equal((await quote({ items: [{ ...payload().items[0], shopProductId: "PEP-10MG", dosage: "10 mg" }] })).items[0].price, 100);
});
for (const category of ["Nasensprays", "Tabletten", "Kapseln / Tabletten", "Fertigpens", "Zubehör"]) test(`H5 canonical ${category} cannot be forged to PlugPlay or BAC vial`, async () => {
  data.articles[0].category = category; data.articles[0].categories = [category];
  await assert.rejects(caller().quote(payload({ items: [{ ...payload().items[0], isPlugPlay: true }] }) as any), /CHECKOUT_FORMAT_UNSUPPORTED/);
  if (category === "Nasensprays") data.articles.push(article(4, "BAC-10ML", "bac-wasser", "5", "Zubehör", "BAC 10 ml"));
  const q = await quote(); assert.equal(q.items.some(i => i.isFreeGift), false);
  assert.equal(q.items[0].isNasalSpray, category === "Nasensprays");
});
test("H5 legit canonical DIY family remains available at 7 surcharge and aggregates tracked kit BAC", async () => {
  data.articles[0].shop_product_id = "semax";
  data.articles.push(article(4, "BAC-10ML", "bac-wasser", "5", "Zubehör", "BAC 10 ml"));
  const extra = { items: [{ ...payload().items[0], shopProductId: "semax", isNasalDiySet: true }] };
  const q = await quote(extra); assert.equal(q.subtotal, 428); assert.equal(q.items.length, 1);
  await caller().create(payload({ ...extra, expectedQuoteHash: q.hash, checkoutIdempotencyKey: "a".repeat(64) }) as any);
  assert.equal(data.articles.find(a => a.sku === "BAC-10ML")!.stock, 996);
});
for (const [restriction, dose, amount] of [["pep-10mg", "5 mg", 0], ["pep-10mg", "10 mg", 72], ["PEP-10MG", "10 mg", 72], ["PeP", "5 mg", 28.8], ["pep-other", "5 mg", 0]] as const) test(`H6 restriction=${restriction} dose=${dose} exact canonical matching`, async () => {
  twoDosages(); promo(`Synthetic | {"restrict":["${restriction}"]}`);
  const q = await quote({ discountCode: "PROMO", items: [{ ...payload().items[0], dosage: dose }] });
  assert.equal(q.discountBreakdown.find(e => e.source === "promotion_code")?.amount || 0, amount);
});
test("shared quote stock preflight aggregates paid/free BAC and rejects missing tracked kit stock", async () => {
  data.articles[2].stock = 5;
  await assert.rejects(caller().quote(payload({ items: [...payload().items, { name: "BAC", shopProductId: "bac-wasser-3ml", quantity: 2, price: 1, type: "accessory" }] }) as any), /CHECKOUT_STOCK_DEMAND_NOT_COVERED/);
  assert.equal(writes.length, 0);
});
test("bundle full configured base ignores sale and adds approved format surcharge AFTER bundle reduction", async () => {
  const items = bundle(); data.bundles[0].allows_plug_play = 1; data.articles[0].sale_price = "10";
  (items[0] as any).isPlugPlay = true;
  const q = await quote({ items }); assert.equal(q.items[0].price, 90); assert.equal(q.items[1].price, 75);
});
function twoForThree(mode = "all", products: string[] = []) {
  data.shop_settings.push({ key: "promo_2for3_enabled", value: "true" }, { key: "promo_2for3_expires_at", value: "2099-01-01T00:00:00Z" }, { key: "promo_2for3_mode", value: mode }, { key: "promo_2for3_products", value: JSON.stringify(products) });
}
test("existing 2for3 config derives exact same-selection gift, no browser authority, inventory aggregated", async () => {
  twoForThree("include", ["pep"]);
  const q = await quote(); const gift = q.items.find(i => i.isFreeGift && i.shopProductId === "PEP-5MG");
  assert.equal(gift?.quantity, 2); assert.equal(gift?.price, 0); assert.equal(q.subtotal, 400); assert.equal(q.discount, 40);
  const extra = { items: [...payload().items, { ...payload().items[0], isFreeGift: true, price: 0, quantity: 2 }] };
  assert.equal((await quote(extra)).subtotal, 400);
  await assert.rejects(caller().quote(payload({ items: [...payload().items, { ...payload().items[0], isFreeGift: true, quantity: 3 }] }) as any), /CHECKOUT_UNTRUSTED_GIFT/);
  await caller().create(payload({ expectedQuoteHash: q.hash, checkoutIdempotencyKey: "a".repeat(64) }) as any);
  assert.equal(data.articles[0].stock, 994);
});
for (const mode of ["exclude", "expired", "invalid", "plug"]) test(`existing 2for3 policy excludes ${mode} without broadening`, async () => {
  twoForThree(mode === "exclude" ? "exclude" : "all", ["pep"]);
  if (mode === "expired") data.shop_settings.find(s => s.key === "promo_2for3_expires_at")!.value = "2000-01-01T00:00:00Z";
  if (mode === "invalid") data.shop_settings.find(s => s.key === "promo_2for3_products")!.value = "invalid-json";
  const q = await quote(mode === "plug" ? { items: [{ ...payload().items[0], isPlugPlay: true }] } : {});
  assert.equal(q.items.some(i => i.isFreeGift && i.shopProductId === "PEP-5MG"), false);
});
for (const changed of ["price", "bundle", "global", "promo"] as const) test(`actual CREATE rejects ${changed} change between preflight and transaction before order number or writes`, async () => {
  global(10); promo();
  const extra = { discountCode: "PROMO", ...(changed === "bundle" ? { items: bundle() } : {}) };
  const q = await quote(extra);
  calls = [];
  beforeWriteTransaction = () => {
    if (changed === "price") data.articles[0].sale_price = "25";
    if (changed === "bundle") data.bundles[0].discount_percent = "30";
    if (changed === "global") {
      const setting = data.shop_settings.find(s => s.key === "global_automatic_discount")!;
      setting.value = JSON.stringify({ ...JSON.parse(setting.value), percentage: 15 });
    }
    if (changed === "promo") data.promo_codes[0].percentage = "25";
  };
  await assert.rejects(caller().create(payload({ ...extra, expectedQuoteHash: q.hash, checkoutIdempotencyKey: "a".repeat(64) }) as any), /CHECKOUT_QUOTE_CHANGED/);
  assert.equal(data.orders.length, 0); assert.equal(data.priority_checkout_receipts.length, 0); assert.equal(data.stock_history.length, 0);
  assert.equal(writes.length, 0); assert.equal(committed, 0); assert.equal(fetches, 0);
  assert.equal(calls.some(c => /next_order_id\(\)/i.test(c)), false);
});
test("H4 scope boundary explicitly preserves legacy shared-product P4P; NOT a verified-origin security fix", async () => {
  calls = [];
  await assert.rejects(caller().quote(payload({ storeKey: "peps4pets", discountBreakdown: [] }) as any), /CHECKOUT_QUOTE_SCOPE_INVALID/);
  assert.equal(calls.length, 0);
  await assert.rejects(caller().create(payload({ storeKey: "peps4pets", discountBreakdown: [], checkoutIdempotencyKey: "p4p-stable-key" }) as any), /bereits verarbeitet/);
  assert.ok(calls.some(c => /pg_try_advisory_lock/.test(c))); assert.equal(data.orders.length, 0);
  // This reachability proves H4 still needs an approved server-verifiable P4P contract.
});
