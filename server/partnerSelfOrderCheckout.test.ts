import assert from "node:assert/strict";
import test, { after, before, beforeEach, mock } from "node:test";
import { readFileSync } from "node:fs";
import pg from "pg";
import { getTableColumns } from "drizzle-orm";
import { partners } from "../drizzle/schema.js";
import { ENV } from "./env.js";
import { closeDb } from "./db.js";
import { createPartnerToken } from "./partnerAuth.js";
import { orderRouter } from "./orderRouter.js";
import { calculateProgramDiscount, resolveSelfOrderTerms, type PartnerProgram } from "./partnerProgramService.js";
import { calculateAuthoritativeShopCheckoutPricing } from "./shopCheckoutPricing.js";
import { calculateCommissionAmount } from "./partnerCreditService.js";

const originalDatabaseUrl = ENV.databaseUrl;
const calls: string[] = [];
const partnerRow: Record<string, unknown> = {
  id: 9, name: "Synthetic owner", partnerNumber: "OWN-9", email: "owner@example.test",
  commissionPercent: "10.00", customerDiscountPercent: "10.00", creditBalance: "12.06",
  isActive: 1, sessionVersion: 0, programKey: "creator", country: "Deutschland",
};
let program: PartnerProgram;
let writes = 0;
let externalCalls = 0;
const partnerColumns = Object.keys(getTableColumns(partners));

before(async () => {
  // All driver operations are mocked before a pool can initialize. No sockets,
  // real databases, messages, sequences, orders or stock movements are possible.
  mock.method(pg.Pool.prototype as any, "query", async (query: string | { text: string }) => {
    const text = typeof query === "string" ? query : query.text;
    calls.push(text);
    if (!/^\s*select\b/i.test(text)) { writes++; throw new Error("WRITE_FORBIDDEN"); }
    if (/\bFROM partners p\s+JOIN partner_programs/i.test(text)) {
      return { rows: [{
        key: program.key, label: program.label, customer_discount_policy: program.customerDiscountPolicy,
        commission_policy: program.commissionPolicy, settlement_method: program.settlementMethod,
        allow_self_order_credit: program.allowSelfOrderCredit, active: program.active,
      }] };
    }
    if (/from "partners"/i.test(text)) return { rows: [partnerColumns.map(key => partnerRow[key] ?? null)] };
    if (/from "articles"/i.test(text)) throw new Error("PRICING_REACHED_NO_WRITES");
    if (/from "customers"|from "shop_settings"|FROM shop_settings/i.test(text)) return { rows: [] };
    throw new Error(`UNEXPECTED_QUERY: ${text}`);
  });
  mock.method(pg.Pool.prototype as any, "connect", async () => { writes++; throw new Error("TRANSACTION_FORBIDDEN"); });
  mock.method(pg.Pool.prototype as any, "end", async () => {});
  mock.method(globalThis, "fetch", async () => { externalCalls++; throw new Error("HTTP_FORBIDDEN"); });
  await closeDb();
  ENV.databaseUrl = "postgresql://mock:mock@127.0.0.1:1/mock_no_network";
});

beforeEach(() => {
  calls.length = 0;
  writes = 0;
  externalCalls = 0;
  partnerRow.creditBalance = "12.06";
  program = {
    key: "creator", label: "Synthetic", customerDiscountPolicy: "each_valid_code_use",
    commissionPolicy: "each_paid_code_order", settlementMethod: "shop_credit",
    allowSelfOrderCredit: true, active: true,
  };
});

after(async () => {
  await closeDb();
  ENV.databaseUrl = originalDatabaseUrl;
  mock.restoreAll();
});

function checkout(preview: boolean, extra: Record<string, unknown> = {}) {
  const token = createPartnerToken(9);
  const caller = orderRouter.createCaller({
    req: { headers: { authorization: `Bearer ${token}` } }, res: {}, user: null,
    ...(preview ? { operationsPreview: { partnerId: 9 } } : {}),
  } as any);
  return caller.create({
    orderSource: "shop", items: [{ name: "Synthetic", price: 100, quantity: 1, type: "vial", shopProductId: "synthetic" }],
    customer: { firstName: "Synthetic", lastName: "Owner", email: "owner@example.test", phone: "+491234567890",
      street: "Test", houseNumber: "1", zip: "10115", city: "Berlin", country: "Deutschland" },
    subtotal: 100, discount: 22.06, discountCode: null, shipping: 8, shippingCountry: "de",
    total: 85.94, paymentMethod: "SEPA", date: "2026-11-06", partnerNumber: "OWN-9", creditUsed: 12.06,
    ...extra,
  } as any);
}

for (const preview of [false, true]) {
  const mode = preview ? "preview" : "real create";
  test(`${mode}: payout balance cannot authorize shop-credit redemption before pricing/persistence`, async () => {
    program.settlementMethod = "payout";
    program.allowSelfOrderCredit = false;
    partnerRow.creditBalance = "1000";
    await assert.rejects(checkout(preview), /PARTNER_GUTHABEN_PROGRAMM_AUSGESCHLOSSEN/);
    assert.equal(writes, 0);
    assert.equal(externalCalls, 0);
    assert.ok(!calls.some(sql => /\bfrom\s+"?(articles|orders|stock_history)"?\b|next_order_id/i.test(sql)));
  });

  test(`${mode}: insufficient requested credit fails before price clamping or persistence`, async () => {
    await assert.rejects(checkout(preview, { creditUsed: 1000 }), /PARTNER_GUTHABEN_NICHT_AUSREICHEND/);
    assert.equal(writes, 0);
    assert.equal(externalCalls, 0);
    assert.ok(!calls.some(sql => /\bfrom\s+"?(articles|orders|stock_history)"?\b|next_order_id/i.test(sql)));
  });

  test(`${mode}: disabled or inactive shop-credit policies fail closed`, async () => {
    program.allowSelfOrderCredit = false;
    await assert.rejects(checkout(preview), /PARTNER_GUTHABEN_PROGRAMM_AUSGESCHLOSSEN/);
    program.allowSelfOrderCredit = true;
    program.active = false;
    await assert.rejects(checkout(preview), /PARTNER_PROGRAMM_NICHT_VERFUEGBAR/);
    assert.equal(writes, 0);
    assert.equal(externalCalls, 0);
  });

  test(`${mode}: mixed public code plus self-number/credit fails even before DB lookup`, async () => {
    await assert.rejects(checkout(preview, { partnerCode: "FOREIGN" }), /PARTNER_CODE_SELBSTBESTELLUNG_AUSGESCHLOSSEN/);
    await assert.rejects(checkout(preview, { partnerCode: "FOREIGN", partnerNumber: null }), /PARTNER_CODE_SELBSTBESTELLUNG_AUSGESCHLOSSEN/);
    await assert.rejects(checkout(preview, { partnerCode: "FOREIGN", creditUsed: 0 }), /PARTNER_CODE_SELBSTBESTELLUNG_AUSGESCHLOSSEN/);
    assert.equal(calls.length, 0);
    assert.equal(writes, 0);
    assert.equal(externalCalls, 0);
  });

  test(`${mode}: explicit Creator-key shop credit passes preflight; payout self-discount needs no redemption`, async () => {
    const reachedPricing = (error: any) => error.cause?.cause?.message === "PRICING_REACHED_NO_WRITES";
    await assert.rejects(checkout(preview), reachedPricing);
    program.settlementMethod = "payout";
    program.allowSelfOrderCredit = false;
    await assert.rejects(checkout(preview, { creditUsed: 0 }), reachedPricing);
    assert.equal(writes, 0);
    assert.equal(externalCalls, 0);
  });
}

test("10/10 Creator-key shop-credit pricing and snapshot earning stay separate even when credit is redeemed", () => {
  const terms = resolveSelfOrderTerms(program, 10, 10);
  const pricing = calculateAuthoritativeShopCheckoutPricing({
    subtotal: 100, shipping: 8, automaticGlobalDiscount: 0, promotionDiscount: 0,
    partnerDiscount: calculateProgramDiscount(100, 0, terms.discountPercent), partnerCreditUsed: 12.06,
  });
  assert.equal(pricing.partnerDiscount, 10);
  assert.equal(pricing.partnerCreditUsed, 12.06);
  assert.equal(pricing.total, 85.94);
  assert.equal(calculateCommissionAmount({
    subtotal: 100, totalProductDiscount: pricing.totalDiscount, creditUsed: pricing.partnerCreditUsed,
    commissionPercent: terms.commissionPercent,
  }), 9);
});

test("router snapshots use canonical earning and retain the final historical payout ledger guard", () => {
  const source = readFileSync(new URL("./orderRouter.ts", import.meta.url), "utf8");
  assert.match(source, /partnerCommissionPercentSnapshot = authenticatedSelfOrderTerms\?\.commissionPercent \?\? 0/);
  const preflight = source.indexOf("assertPartnerShopCreditAvailable(");
  assert.ok(preflight > 0 && preflight < source.indexOf("if(ctx.operationsPreview){"));
  assert.ok(preflight < source.indexOf("SELECT next_order_id()"));
  assert.ok(preflight < source.indexOf("await db.transaction("));
  assert.match(source, /if \(parseFloat\(existingOrder\[0\]\.creditUsed \|\| "0"\) > 0\) \{\s*await redeemPartnerCreditForOrder\(orderId\)/);
  assert.match(source, /if \(creditUsed > 0\) \{\s*await redeemPartnerCreditInTransaction\(\s*orderId,\s*createPartnerCreditTransactionQueryClient\(query => tx.execute\(query\)\)/);
  const finalLedgerCheck = source.indexOf("await redeemPartnerCreditInTransaction(");
  assert.ok(finalLedgerCheck > source.indexOf("await db.transaction("));
  assert.ok(finalLedgerCheck < source.indexOf("// This must run after the persistence transaction commits."));
  assert.equal([...source.matchAll(/await redeemPartnerCreditForOrder\(orderId\)/g)].length, 1, "only duplicate recovery uses the standalone wrapper");
  const ledger = readFileSync(new URL("./partnerCreditService.ts", import.meta.url), "utf8");
  assert.match(ledger, /FOR UPDATE/);
  assert.match(ledger, /order.partner_settlement_method_snapshot === "payout"/);
  for (const filename of ["partnerRouter.ts", "operationsPartner.ts"]) {
    const response = readFileSync(new URL(filename, import.meta.url), "utf8");
    assert.match(response, /resolveSelfOrderTerms\(/);
    assert.doesNotMatch(response, /calculateSelfOrderDiscountPercent\(/);
  }
});
