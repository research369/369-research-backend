import test from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { normalizeWhatsappContactPhone } from "./whatsappContactIdentity.js";
import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { WhatsappWawiAdapter } from "./whatsappWawiAdapter.js";
import { WhatsappOrderService } from "./whatsappOrderService.js";
import { IsolatedPhase1Store } from "./whatsappPhase1Store.js";
import { nextCustomerNumber } from "./customerNumberService.js";
import { getBlockIdentifiers, ensureCustomerOrderBlockSchema, activateCustomerOrderBlock } from "./customerOrderBlockService.js";
import { closeDb } from "./db.js";
import {
  toReleasedBankTransferInstructions,
  type BankTransferPaymentInstructionsConfig,
} from "./paymentInstructionsConfig.js";
const wiseConfig: BankTransferPaymentInstructionsConfig = {
  enabled: true,
  checkoutLabelDe: "Wise", checkoutLabelEn: "Wise",
  checkoutHintDe: "Wise", checkoutHintEn: "Wise",
  accounts: [{ id: "wise-test", labelDe: "Wise Test", labelEn: "Wise Test",
    accountHolder: "ISOLATED TEST", iban: "DE00000000000000000000", bic: "TESTDE00" }],
};
const config = {
  host: process.env.WOP_TEST_DB_HOST || "/tmp/369-whatsapp-hardening-pg/socket",
  port: Number(process.env.WOP_TEST_DB_PORT || 55439),
  user: process.env.WOP_TEST_DB_USER || process.env.USER,
};
if (process.env.NODE_ENV !== "test" || !config.host.startsWith("/"))
  throw Error("isolated_unix_test_environment_required");
const helperUrl = new URL(process.env.DATABASE_URL || "postgresql://invalid/invalid");
if (helperUrl.hostname || helperUrl.pathname !== "/whatsapp_phase1_test_native" ||
    helperUrl.searchParams.get("host") !== config.host ||
    Number(helperUrl.searchParams.get("port") || 5432) !== config.port)
  throw Error("isolated_helper_database_required");
const externalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw Error("external_requests_forbidden"); };
const pool = new Pool({
  ...config,
  database: "whatsapp_phase1_test_native",
  max: 8,
});
let service: WhatsappOrderService;
let migration: string;
let adapter: WhatsappWawiAdapter;
test.before(async () => {
  const admin = new Pool({ ...config, database: "postgres" });
  try {
    await admin.query("CREATE DATABASE whatsapp_phase1_test_native");
  } catch (e: any) {
    if (e.code !== "42P04") throw e;
  } finally {
    await admin.end();
  }
  await IsolatedPhase1Store.connect(pool);
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  const schema = execFileSync(
    "node_modules/.bin/drizzle-kit",
    ["export", "--dialect", "postgresql", "--schema", "./drizzle/schema.ts"],
    { encoding: "utf8" },
  );
  await pool.query(schema);
  await ensureCustomerOrderBlockSchema();
  await pool.query(
    "CREATE SEQUENCE native_test_order_seq; CREATE FUNCTION next_order_id() RETURNS text LANGUAGE sql AS $$SELECT 'TEST-NATIVE-'||nextval('native_test_order_seq')::text$$",
  );
  migration = await readFile(
    new URL("../drizzle/migrations/0030_whatsapp_phase1.sql", import.meta.url),
    "utf8",
  );
  await pool.query(migration);
  await pool.query(
    await readFile(
      new URL("./whatsappPhase1Schema.sql", import.meta.url),
      "utf8",
    ),
  );
  adapter = new WhatsappWawiAdapter(
    pool,
    async () => toReleasedBankTransferInstructions(wiseConfig),
    new Set(["ALPHA", "BETA"]),
    "reference-test-key-".repeat(4),
  );
  service = new WhatsappOrderService(
    await IsolatedPhase1Store.connect(pool),
    adapter,
    "s".repeat(64),
    { user: "1234", chat: "1234" },
  );
});
test.beforeEach(async () => {
  await pool.query(
    "TRUNCATE wop_executions,wop_intents,wop_quotes,wop_test_orders,whatsapp_order_provenance,stock_history,order_items,orders,customers,articles,promo_codes CASCADE",
  );
  await pool.query("TRUNCATE partner_codes,partners CASCADE; DELETE FROM shop_settings WHERE key IN ('global_automatic_discount','bank_transfer_payment_instructions')");
  await pool.query(
    `INSERT INTO articles(sku,name,shop_product_id,selling_price,stock,shop_visible,variants) VALUES('ALPHA','Produkt Alpha','alpha',70,10,1,'[{"dosage":"10 mg","price":70}]'),('BETA','Produkt Beta','beta',50,10,1,'[{"dosage":"20 mg","price":50}]'); UPDATE articles SET variants=jsonb_set(variants,'{0,inventoryArticleId}',to_jsonb(id)); INSERT INTO promo_codes(code,percentage,max_uses) VALUES('TEST10',10,1)`,
  );
});
test.after(async () => {
  globalThis.fetch = externalFetch;
  await closeDb();
  await pool.end();
});
async function request(sku = "ALPHA", extra: any = {}) {
  const search = await service.search({
    query: sku === "ALPHA" ? "Alpha" : "Beta",
    locale: "de",
  });
  return {
    schema_version: "1",
    draft_id: randomUUID(),
    bot_conversation_id: "native-conversation",
    customer: {
      first_name: "Test",
      last_name: "Person",
      email: "native-test@example.invalid",
      phone: "+491700000000",
      language: "de",
    },
    delivery: {
      type: "home",
      street: "Testweg",
      house_number: "1",
      postal_code: "12345",
      city: "Teststadt",
      country_code: "DE",
    },
    lines: [{ catalog_item_id: search.items[0].catalog_item_id, quantity: 1 }],
    promotion: { mode: "explicit_code", code: "TEST10" },
    payment_method: "bank_transfer",
    ...extra,
  };
}
async function ready(r: any) {
  const q = await service.quote("phase1-bot", r);
  const message_id = "inbound-" + randomUUID(),
    confirmed_at = new Date().toISOString();
  await service.confirmCustomer("phase1-bot", {
    quote_id: q.quote_id,
    challenge: q.confirmation_challenge_id,
    conversation: r.bot_conversation_id,
    message_id,
    confirmed_at,
    verified_reply: true,
  });
  const a = await service.approveOwner("phase1-bot", {
    quote_id: q.quote_id,
    quote_hash: q.quote_hash,
    quote_revision: q.quote_revision,
    user: "1234",
    chat: "1234",
    private_chat: true,
    callback_verified: true,
  });
  return {
    execution_id: randomUUID(),
    quote_id: q.quote_id,
    quote_hash: q.quote_hash,
    quote_revision: q.quote_revision,
    customer_confirmation: {
      confirmation_challenge_id: q.confirmation_challenge_id,
      message_id,
      confirmed_at,
    },
    owner_approval: a,
  };
}
test("Native WaWi-Tabellen: ein Auftrag, Position, Bestandshistorie, Promo und Herkunft atomar", async () => {
  const e = await ready(await request());
  const [a, b] = await Promise.all([
    service.execute("phase1-bot", e),
    service.execute("phase1-bot", e),
  ]);
  assert.deepEqual(a, b);
  assert.equal((await pool.query("SELECT * FROM orders")).rowCount, 1);
  const order = (await pool.query("SELECT * FROM orders")).rows[0];
  assert.equal(order.order_origin, "whatsapp_bot");
  assert.equal(order.payment_method, "SEPA");
  assert.equal(Number(order.total), 71);
  assert.equal(
    (await pool.query("SELECT stock FROM articles WHERE sku=$1", ["ALPHA"]))
      .rows[0].stock,
    9,
  );
  assert.equal((await pool.query("SELECT * FROM stock_history")).rowCount, 1);
  assert.equal((await pool.query("SELECT * FROM order_items")).rowCount, 1);
  assert.equal(
    (await pool.query("SELECT current_uses FROM promo_codes")).rows[0]
      .current_uses,
    1,
  );
  assert.equal(
    (await pool.query("SELECT * FROM whatsapp_order_provenance")).rowCount,
    1,
  );
  assert.equal(a.payment.payment_reference, order.order_id);
  assert.equal(a.confirmation.email, "not_requested");
  assert.equal(
    (await pool.query("SELECT street,preferred_delivery_type FROM customers"))
      .rows[0].street,
    null,
  );
});
test("Native Fehler nach Auftragsinsert rollt Kunden, Positionen, Bestand und Verbrauch zurück", async () => {
  const e = await ready(await request());
  await pool.query(
    "CREATE FUNCTION reject_provenance() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'test_fault_after_booking'; END$$; CREATE TRIGGER fail_provenance BEFORE INSERT ON whatsapp_order_provenance FOR EACH ROW EXECUTE FUNCTION reject_provenance()",
  );
  try {
    await assert.rejects(
      () => service.execute("phase1-bot", e),
      /test_fault_after_booking/,
    );
    for (const table of [
      "orders",
      "order_items",
      "stock_history",
      "customers",
      "wop_executions",
    ])
      assert.equal((await pool.query("SELECT * FROM " + table)).rowCount, 0);
    assert.equal(
      (await pool.query("SELECT stock FROM articles WHERE sku=$1", ["ALPHA"]))
        .rows[0].stock,
      10,
    );
    assert.equal(
      (await pool.query("SELECT current_uses FROM promo_codes")).rows[0]
        .current_uses,
      0,
    );
  } finally {
    await pool.query(
      "DROP TRIGGER fail_provenance ON whatsapp_order_provenance; DROP FUNCTION reject_provenance()",
    );
  }
});
test("Kundennummern: parallel eindeutig, Migration wiederholbar, keine Wiederverwendung", async () => {
  await pool.query(
    "INSERT INTO customers(customer_number,name) VALUES('9000','Legacy Test')",
  );
  await pool.query(migration);
  const numbers = await Promise.all(
    Array.from({ length: 32 }, () => nextCustomerNumber(pool)),
  );
  assert.equal(new Set(numbers).size, 32);
  assert(numbers.every((n) => BigInt(n) > 9000n));
  await pool.query(migration);
  assert(
    BigInt(await nextCustomerNumber(pool)) >
      numbers.reduce((m, n) => (BigInt(n) > m ? BigInt(n) : m), 0n),
  );
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const abandoned = await nextCustomerNumber(c);
    await c.query("ROLLBACK");
    assert(BigInt(await nextCustomerNumber(pool)) > BigInt(abandoned));
  } finally {
    c.release();
  }
});
test("Kontaktabgleich: normalisierte Nummer, keine Profiländerung, Konflikt gesperrt", async () => {
  await pool.query(
    "INSERT INTO customers(customer_number,name,email,phone,street) VALUES('8001','Unchanged','native-test@example.invalid','0170 0000000','Altstraße')",
  );
  const e = await ready(await request());
  await service.execute("phase1-bot", e);
  assert.equal((await pool.query("SELECT * FROM customers")).rowCount, 1);
  assert.equal(
    (await pool.query("SELECT street FROM customers")).rows[0].street,
    "Altstraße",
  );
  await pool.query(
    "INSERT INTO customers(customer_number,name,email,phone) VALUES('8002','Other','other@example.invalid','+491711111111')",
  );
  const r = await request();
  r.customer.email = "other@example.invalid";
  await assert.rejects(
    () => service.quote("phase1-bot", r),
    /customer_review_required/,
  );
});
test("Zwei gleichzeitige Erstaufträge desselben Kontakts erzeugen höchstens einen Kunden", async () => {
  const a = await ready(
      await request("ALPHA", { promotion: { mode: "none" } }),
    ),
    b = await ready(
      await request("BETA", {
        promotion: { mode: "none" },
        bot_conversation_id: "second-native-chat",
      }),
    );
  const result = await Promise.allSettled([
    service.execute("phase1-bot", a),
    service.execute("phase1-bot", b),
  ]);
  assert(result.some((x) => x.status === "fulfilled"));
  assert.equal((await pool.query("SELECT * FROM customers")).rowCount, 1);
  const orders = (await pool.query("SELECT * FROM orders")).rows;
  assert(orders.length >= 1 && orders.length <= 2);
  assert.equal(new Set(orders.map((x) => x.customer_id)).size, 1);
});
test("Packstation, Länder und erlaubte Produkte: kein geratenes Fulfilment", async () => {
  const r = await request("ALPHA", {
    promotion: { mode: "none" },
    delivery: {
      type: "dhl_packstation",
      packstation_number: "123",
      dhl_post_number: "12345678",
      postal_code: "12345",
      city: "Teststadt",
      country_code: "DE",
    },
  });
  await service.execute("phase1-bot", await ready(r));
  const o = (await pool.query("SELECT * FROM orders")).rows[0];
  assert.equal(o.delivery_type, "packstation");
  assert.equal(o.street, "Packstation");
  assert.equal(o.house_number, "123");
  assert.equal(o.dhl_post_number, "12345678");
  assert.equal(o.company, null);
  await pool.query(
    "UPDATE articles SET name='Plug&Play Patrone' WHERE sku='ALPHA'",
  );
  assert.equal(
    (await service.search({ query: "Patrone", locale: "de" })).items.length,
    0,
  );
});
test("Promo-Limit zwischen Quote und Execute: keine zweite native Bestellung", async () => {
  const e = await ready(await request());
  await pool.query("UPDATE promo_codes SET current_uses=1");
  await assert.rejects(
    () => service.execute("phase1-bot", e),
    /promotion_not_eligible/,
  );
  assert.equal((await pool.query("SELECT * FROM orders")).rowCount, 0);
});

test("PG- und Drizzle-Wege teilen dieselbe Sequenz; Telefonformate stimmen überein", async () => {
  const values = await Promise.all([
    nextCustomerNumber(pool),
    nextCustomerNumber(drizzle(pool)),
  ]);
  assert.notEqual(values[0], values[1]);
  for (const phone of [
    "0170 0000000",
    "00491700000000",
    "+49 (0)1700000000",
    "00441234567890",
    "+441234567890",
  ]) {
    const expected = normalizeWhatsappContactPhone(phone);
    assert.equal(
      (
        await pool.query("SELECT normalize_whatsapp_contact_phone($1) AS n", [
          phone,
        ])
      ).rows[0].n,
      expected,
    );
  }
});
test("Native Preise und Bestand werden vor Ausführung erneut geprüft", async () => {
  const e = await ready(await request());
  await pool.query(
    "UPDATE articles SET selling_price=80,variants=jsonb_set(variants,'{0,price}','80') WHERE sku='ALPHA'",
  );
  await assert.rejects(() => service.execute("phase1-bot", e), /quote_stale/);
  assert.equal((await pool.query("SELECT * FROM orders")).rowCount, 0);
});
test("Neue native Kundennummern dürfen ohne Migration nicht auf MAX+1 zurückfallen", async () => {
  await pool.query(
    "ALTER FUNCTION next_customer_number() RENAME TO next_customer_number_temporarily_disabled",
  );
  try {
    await assert.rejects(
      () => nextCustomerNumber(pool),
      /next_customer_number/,
    );
  } finally {
    await pool.query(
      "ALTER FUNCTION next_customer_number_temporarily_disabled() RENAME TO next_customer_number",
    );
  }
});

test("Wechsel des bestehenden Kontaktziels nach Quote wird nicht still übernommen", async () => {
  await pool.query(
    "INSERT INTO customers(customer_number,name,email,phone) VALUES('7001','Original','native-test@example.invalid','+491700000000')",
  );
  const e = await ready(await request());
  await pool.query(
    "UPDATE customers SET email='old@example.invalid',phone='+491799999999' WHERE customer_number='7001'; INSERT INTO customers(customer_number,name,email,phone) VALUES('7002','Other','native-test@example.invalid','+491700000000')",
  );
  await assert.rejects(() => service.execute("phase1-bot", e), /quote_stale/);
  assert.equal((await pool.query("SELECT * FROM orders")).rowCount, 0);
});

test("Native Mehrpositionsquote übernimmt Sale, Dauerrabatt und Code aus den kanonischen Helfern", async () => {
  await pool.query("UPDATE articles SET sale_price=60 WHERE sku='ALPHA'");
  await pool.query(
    "INSERT INTO shop_settings(key,value) VALUES('global_automatic_discount',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [
      JSON.stringify({
        enabled: true,
        percentage: 20,
        startsAt: null,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        stackWithPromotionCodes: true,
        labelDe: "Test",
        labelEn: "Test",
      }),
    ],
  );
  try {
    const r = await request();
    const b = await service.search({ query: "Beta", locale: "de" });
    r.lines.push({ catalog_item_id: b.items[0].catalog_item_id, quantity: 1 });
    const e = await ready(r);
    const result = await service.execute("phase1-bot", e);
    assert.equal(result.order.total_cents, 8720);
    assert.equal((await pool.query("SELECT * FROM order_items")).rowCount, 2);
    assert.equal((await pool.query("SELECT * FROM stock_history")).rowCount, 2);
    assert.equal(
      (await pool.query("SELECT current_uses FROM promo_codes")).rows[0]
        .current_uses,
      1,
    );
  } finally {
    await pool.query(
      "DELETE FROM shop_settings WHERE key='global_automatic_discount'",
    );
  }
});

test("WhatsApp-Quote respektiert nicht kombinierbare Codes und globalen Freiversand", async () => {
  await pool.query(
    "INSERT INTO shop_settings(key,value) VALUES('global_automatic_discount',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [
      JSON.stringify({
        enabled: true,
        percentage: 20,
        startsAt: null,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        freeShippingEnabled: true,
        freeShippingMinOrder: 50,
        freeShippingRegions: ["de"],
        stackWithPromotionCodes: false,
        stackWithPartnerCreatorCodes: true,
        stackWithKwk: true,
        labelDe: "Test",
        labelEn: "Test",
      }),
    ],
  );
  try {
    const withoutCode = await service.quote(
      "phase1-bot",
      await request("ALPHA", { promotion: { mode: "none" } }),
    );
    assert.equal(withoutCode.order_summary.discount_total_cents, 1400);
    assert.equal(withoutCode.order_summary.shipping_cents, 0);
    assert.equal(withoutCode.order_summary.total_cents, 5600);

    const withCode = await service.quote("phase1-bot", await request("ALPHA"));
    // Der Code bleibt gültig; er ersetzt bei ausgeschalteter Kombination sowohl
    // Dauerrabatt als auch dessen Freiversand.
    assert.equal(withCode.order_summary.discount_total_cents, 700);
    assert.equal(withCode.order_summary.shipping_cents, 800);
    assert.equal(withCode.order_summary.total_cents, 7100);
  } finally {
    await pool.query(
      "DELETE FROM shop_settings WHERE key='global_automatic_discount'",
    );
  }
});

async function nativeState() {
  const counts: Record<string, number> = {};
  for (const table of ["customers", "orders", "order_items", "stock_history", "whatsapp_order_provenance", "wop_quotes", "wop_executions", "wop_intents"])
    counts[table] = Number((await pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
  return {
    counts,
    stock: (await pool.query("SELECT sku,stock FROM articles ORDER BY sku")).rows,
    promos: (await pool.query("SELECT code,current_uses FROM promo_codes ORDER BY code")).rows,
    customerSequence: (await pool.query("SELECT last_value,is_called FROM customer_number_seq")).rows,
    orderSequence: (await pool.query("SELECT last_value,is_called FROM native_test_order_seq")).rows,
  };
}
async function blockContact(customer: { email?: string; phone?: string }) {
  const { rows: [row] } = await pool.query("INSERT INTO customers(customer_number,name) VALUES($1,'Explicit blocked identity') RETURNING id", ["BLOCK-" + randomUUID().slice(0, 12)]);
  return activateCustomerOrderBlock({ customerId: row.id, ...customer, reason: "isolated test", actor: "test" });
}
async function campaign(extra: Record<string, unknown> = {}) {
  await pool.query("INSERT INTO shop_settings(key,value) VALUES('global_automatic_discount',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [JSON.stringify({
    enabled: true, percentage: 20, startsAt: null,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    labelDe: "Isolated", labelEn: "Isolated", ...extra,
  })]);
}
const bookContext = () => ({ execution_id: randomUUID(), quote_id: randomUUID(), quote_revision: 1,
  quote_hash: "a".repeat(64), conversation: "isolated", owner: "1234" });

test("Aktive Kontakt-Sperre vor Preview und direkt in book: keinerlei Writes oder Sequenzverbrauch", async () => {
  const r = await request("ALPHA", { promotion: { mode: "none" } });
  const priced = await adapter.quote(r as any, ["ALPHA"]);
  await blockContact({ email: r.customer.email.toUpperCase(), phone: "0170 0000000" });
  const before = await nativeState();
  await assert.rejects(() => service.quote("phase1-bot", r), /CUSTOMER_ORDER_BLOCKED/);
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await assert.rejects(() => adapter.book(c, r as any, priced, bookContext()), /CUSTOMER_ORDER_BLOCKED/);
    await c.query("ROLLBACK");
  } finally { c.release(); }
  assert.deepEqual(await nativeState(), before);
});

test("Nach Quote aktivierte Kundensperre wird bei Execute unter kanonischen Locks erneut geprüft", async () => {
  const r = await request("ALPHA", { promotion: { mode: "none" } });
  const e = await ready(r);
  await blockContact({ phone: "00491700000000" });
  const before = await nativeState();
  await assert.rejects(() => service.execute("phase1-bot", e), /CUSTOMER_ORDER_BLOCKED/);
  assert.deepEqual(await nativeState(), before);
});

test("Book wartet auf die tatsächlichen Aktivierungs-Keys und sieht eine gleichzeitig aktivierte Sperre", async () => {
  const r = await request("ALPHA", { promotion: { mode: "none" } });
  const priced = await adapter.quote(r as any, ["ALPHA"]);
  const { rows: [customer] } = await pool.query("INSERT INTO customers(customer_number,name) VALUES('LOCK-BLOCK','Test') RETURNING id");
  const ids = getBlockIdentifiers(r.customer);
  const blocker = await pool.connect(), booking = await pool.connect();
  const before = await nativeState();
  try {
    await blocker.query("BEGIN");
    // Exactly the hashtext and key contract used by activateCustomerOrderBlock.
    await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["customer-order-block:email:" + ids.emailNormalized]);
    await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["customer-order-block:phone:" + ids.phoneNormalized]);
    await booking.query("BEGIN; SET LOCAL statement_timeout='3000ms'");
    let settled = false;
    const attempt = adapter.book(booking, r as any, priced, bookContext()).then(
      () => { settled = true; return null; }, (e: Error) => { settled = true; return e; });
    let observed = false;
    for (let i = 0; i < 50; i++) {
      const waiting = await pool.query("SELECT wait_event FROM pg_stat_activity WHERE pid=$1", [(booking as any).processID]);
      if (waiting.rows[0]?.wait_event === "advisory") { observed = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(observed, true, "book must wait on the canonical block lock");
    assert.equal(settled, false);
    await blocker.query("INSERT INTO customer_order_blocks(customer_id,reason,email_normalized,phone_normalized,created_by) VALUES($1,'isolated',$2,$3,'test')", [customer.id, ids.emailNormalized, ids.phoneNormalized]);
    await blocker.query("COMMIT");
    assert.match((await attempt)?.message || "", /CUSTOMER_ORDER_BLOCKED/);
    await booking.query("ROLLBACK");
  } finally {
    await blocker.query("ROLLBACK"); await booking.query("ROLLBACK");
    blocker.release(); booking.release();
  }
  assert.deepEqual(await nativeState(), before);
});

test("Kein Namensmatching: fremde Sperre und widerrufene Kontakt-Sperre erlauben Preview", async () => {
  const r = await request("ALPHA", { promotion: { mode: "none" } });
  await blockContact({ email: "other@example.invalid", phone: "+491799999999" });
  assert.equal((await service.quote("phase1-bot", r)).customer_resolution.status, "new");
  await blockContact(r.customer);
  await pool.query("UPDATE customer_order_blocks SET status='revoked'");
  assert.equal((await service.quote("phase1-bot", r)).customer_resolution.status, "new");
});

test("Strict exclusive: expliziter Code vor Preview abgelehnt, none und deaktivierte/Legacy-Aktion bleiben gültig", async () => {
  const r = await request();
  await campaign({ exclusiveCampaign: true });
  const before = await nativeState();
  await assert.rejects(() => service.quote("phase1-bot", r), /Diese Aktion ist exklusiv/);
  assert.deepEqual(await nativeState(), before);
  assert.equal((await service.quote("phase1-bot", { ...r, promotion: { mode: "none" } })).order_summary.discount_total_cents, 1400);
  for (const extra of [{ exclusiveCampaign: true, enabled: false }, { exclusiveCampaign: true, expiresAt: new Date(Date.now() - 1000).toISOString() }, { exclusiveCampaign: false }]) {
    await campaign(extra);
    const q = await service.quote("phase1-bot", { ...r, draft_id: randomUUID() });
    assert.equal(q.promotion_selection.selected_code, "TEST10");
  }
});

test("Zwischen Quote und Execute aktivierte Strict-Aktion verweigert ohne native Writes oder Sequenzen", async () => {
  const e = await ready(await request());
  await campaign({ exclusiveCampaign: true });
  const before = await nativeState();
  await assert.rejects(() => service.execute("phase1-bot", e), /Diese Aktion ist exklusiv/);
  assert.deepEqual(await nativeState(), before);
});

test("Partner-/Creator-Kollisionen sind auch inaktiven und anders geschriebenen Codes nicht als Promo zugänglich", async () => {
  const r = await request();
  await pool.query("INSERT INTO partners(name,code,partner_number,is_active) VALUES('Isolated','test10','TEST-PARTNER',0)");
  const before = await nativeState();
  await assert.rejects(() => service.quote("phase1-bot", r), /promotion_not_eligible/);
  assert.deepEqual(await nativeState(), before);
  await pool.query("DELETE FROM partners; INSERT INTO partner_codes(partner_id,display_code,code_normalized,commission_percent,customer_discount_percent,is_active) VALUES(999,'TeSt10','test10',10,10,false)");
  await assert.rejects(() => service.quote("phase1-bot", r), /promotion_not_eligible/);
  await pool.query("DELETE FROM partner_codes");
  const e = await ready(r);
  await pool.query("INSERT INTO partner_codes(partner_id,display_code,code_normalized,commission_percent,customer_discount_percent) VALUES(999,'TEST10','TEST10',10,10)");
  const beforeExecute = await nativeState();
  await assert.rejects(() => service.execute("phase1-bot", e), /promotion_not_eligible/);
  assert.deepEqual(await nativeState(), beforeExecute);
});

test("Promo-Scope: private Beschreibungen und ungeprüfte Neukunden-/Kundenlimitberechtigung fail closed", async () => {
  const r = await request();
  for (const description of ["Follow-up", "persönlich", "individuell", "Bestellung", "Creator", "Partner", "intern", "Testaktion", "Neukunden", 'Public | {"maxPerCustomer":1}']) {
    await pool.query("UPDATE promo_codes SET description=$1", [description]);
    const before = await nativeState();
    await assert.rejects(() => service.quote("phase1-bot", r), /promotion_not_eligible/, description);
    assert.deepEqual(await nativeState(), before);
  }
  await pool.query("UPDATE promo_codes SET description='Neukunden'");
  await pool.query("INSERT INTO customers(customer_number,name,email,phone,total_orders) VALUES('RETURNING','Test','native-test@example.invalid','+491700000000',3)");
  await assert.rejects(() => service.quote("phase1-bot", r), /promotion_not_eligible/);
});

test("Wise: Default nutzt die zentrale freigegebene Quelle; fehlend, deaktiviert, nicht-Wise und mehrdeutig ohne Writes", async () => {
  const central = new WhatsappWawiAdapter(pool, undefined, new Set(["ALPHA"]), "r".repeat(64));
  const centralService = new WhatsappOrderService(await IsolatedPhase1Store.connect(pool), central, "s".repeat(64), { user: "1234", chat: "1234" });
  const e = await ready(await request("ALPHA", { promotion: { mode: "none" } }));
  const nonWise = { ...wiseConfig.accounts[0], id: "other", labelDe: "Other", labelEn: "Other" };
  for (const config of [null, { ...wiseConfig, enabled: false }, { ...wiseConfig, accounts: [nonWise] }, { ...wiseConfig, accounts: [wiseConfig.accounts[0], { ...wiseConfig.accounts[0], id: "wise-two" }] }]) {
    await pool.query("DELETE FROM shop_settings WHERE key='bank_transfer_payment_instructions'");
    if (config) await pool.query("INSERT INTO shop_settings(key,value) VALUES('bank_transfer_payment_instructions',$1)", [JSON.stringify(config)]);
    const before = await nativeState();
    await assert.rejects(() => centralService.execute("phase1-bot", e), /payment_configuration_required/);
    assert.deepEqual(await nativeState(), before);
  }
  await pool.query("UPDATE shop_settings SET value=$1 WHERE key='bank_transfer_payment_instructions'", [JSON.stringify(wiseConfig)]);
  const result = await centralService.execute("phase1-bot", e);
  assert.deepEqual(result.payment.instructions, { recipient: "ISOLATED TEST", iban: wiseConfig.accounts[0].iban, bic: "TESTDE00" });
  assert.deepEqual(await centralService.execute("phase1-bot", e), result);
  assert.equal(result.confirmation.email, "not_requested");
});

test("Wise-Injection: keine freien Strings, keine Production-Injection, keine FremdDB-Injection", async () => {
  assert.throws(() => new WhatsappWawiAdapter(pool, { recipient: "Arbitrary" } as any, new Set(), "r".repeat(64)), /isolated_payment_source_required/);
  const prior = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    assert.throws(() => new WhatsappWawiAdapter(pool, async () => toReleasedBankTransferInstructions(wiseConfig), new Set(), "r".repeat(64)), /isolated_payment_source_required/);
  } finally { process.env.NODE_ENV = prior; }
  const invalid = new WhatsappWawiAdapter(pool, async () => ({ accountCount: 1, accounts: [{ ...wiseConfig.accounts[0], id: "other", labelDe: "Other", labelEn: "Other" }] }), new Set(["ALPHA"]), "r".repeat(64));
  const r = await request("ALPHA", { promotion: { mode: "none" } });
  const priced = await adapter.quote(r as any, ["ALPHA"]);
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const before = await nativeState();
    await assert.rejects(() => invalid.book(c, r as any, priced, bookContext()), /payment_configuration_required/);
    const foreign = new WhatsappWawiAdapter({ query: async () => ({ rows: [{ db: "forbidden" }] }) } as any, async () => toReleasedBankTransferInstructions(wiseConfig), new Set(), "r".repeat(64));
    await assert.rejects(() => foreign.book(c, r as any, priced, bookContext()), /isolated_database_required/);
    await c.query("ROLLBACK");
    assert.deepEqual(await nativeState(), before);
  } finally { c.release(); }
});
