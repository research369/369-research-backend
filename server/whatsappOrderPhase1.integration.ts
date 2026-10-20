import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import express from "express";
import { createServer } from "node:http";
import { IsolatedPhase1Store } from "./whatsappPhase1Store.js";
import {
  WhatsappOrderService,
  type Phase1Backend,
} from "./whatsappOrderService.js";
import { quoteRequest } from "./whatsappOrderContract.js";
import { createWhatsappOrderRouter } from "./whatsappOrderRouter.js";
import { projectOffers } from "./pepgptOffers.js";
const pool = new Pool({
  host: "127.0.0.1",
  port: 55439,
  database: "whatsapp_phase1_test_rehearsal",
  user: process.env.WOP_TEST_DB_USER || process.env.USER,
  max: 5,
});
const tenant = "phase1-bot";
let service: WhatsappOrderService,
  store: IsolatedPhase1Store,
  price = 70;
let contactStatus: "new" | "conflict" = "new";
const backend: Phase1Backend = {
  catalog: async () => [
    {
      sku: "ALPHA",
      name: "Produkt Alpha",
      variant: "10 mg",
      available: true,
      max_quantity: 10,
      requires_home_address: false,
    },
  ],
  quote: async (request) => {
    const code =
      request.promotion.mode === "explicit_code"
        ? request.promotion.code
        : null;
    const article = {
      id: 1,
      name: "Produkt Alpha",
      sku: "ALPHA",
      shop_product_id: "alpha",
      selling_price: String(price),
      sale_price: null,
      stock: 10,
      is_active: 1,
      shop_visible: 1,
      variants: [{ dosage: "10 mg", price, inventoryArticleId: 1 }],
    };
    const promos =
      code === "TEST10"
        ? [
            {
              code,
              discount_type: "percent",
              percentage: "10",
              fixed_amount: "0",
              min_order: "0",
              max_uses: 10,
              current_uses: 0,
              valid_from: null,
              valid_until: null,
              valid_until_exact: 0,
              is_active: 1,
              description: "",
            },
          ]
        : [];
    const result = projectOffers(
      [article],
      promos,
      null,
      {
        search: "Produkt Alpha",
        dosage: "10 mg",
        quantity: request.lines[0].quantity,
        country: request.delivery.country_code,
        promotion: request.promotion,
      },
      new Date(),
    );
    const o = result.offers[0],
      p = o.promotions[0];
    const cents = (v: number) => Math.round(v * 100);
    return {
      order_summary: {
        currency: "EUR",
        lines: [
          {
            sku: "ALPHA",
            display_name: o.name,
            variant_label: o.variant,
            quantity: o.quantity,
            unit_price_cents: cents(o.unit_price),
            line_total_cents: cents(o.subtotal),
          },
        ],
        subtotal_cents: cents(o.subtotal),
        discount_total_cents: cents(p?.discount ?? 0),
        shipping_cents: cents(p?.shipping ?? o.shipping),
        total_cents: cents(p?.total ?? o.total),
        discounts: p ? [{ code: p.code, amount_cents: cents(p.discount) }] : [],
      },
      promotion_selection: {
        mode: request.promotion.mode,
        selected_code: code,
      },
      customer_resolution: { status: contactStatus },
    };
  },
};
async function request() {
  const catalog = await service.search({ query: "Alpha", locale: "de" });
  return {
    schema_version: "1",
    draft_id: randomUUID(),
    bot_conversation_id: "test-conversation",
    customer: {
      first_name: "Test",
      last_name: "Person",
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
    lines: [{ catalog_item_id: catalog.items[0].catalog_item_id, quantity: 1 }],
    promotion: { mode: "explicit_code", code: "TEST10" },
    payment_method: "bank_transfer",
  };
}
async function confirmed(q: any) {
  const e = {
    quote_id: q.quote_id,
    challenge: q.confirmation_challenge_id,
    conversation: "test-conversation",
    message_id: "wa-confirm-" + randomUUID(),
    confirmed_at: new Date().toISOString(),
    verified_reply: true,
  };
  await service.confirmCustomer(tenant, e);
  return e;
}
async function ready(q: any) {
  const e = await confirmed(q);
  const approval = await service.approveOwner(tenant, {
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
      message_id: e.message_id,
      confirmed_at: e.confirmed_at,
    },
    owner_approval: approval,
  };
}
test.before(async () => {
  store = await IsolatedPhase1Store.connect(pool);
  await pool.query(
    "DROP TABLE IF EXISTS wop_executions,wop_intents,wop_quotes,wop_test_inventory,wop_test_promos,wop_test_orders CASCADE",
  );
  await pool.query(
    await readFile(
      new URL("./whatsappPhase1Schema.sql", import.meta.url),
      "utf8",
    ),
  );
  service = new WhatsappOrderService(store, backend, "s".repeat(64), {
    user: "1234",
    chat: "1234",
  });
});
test.beforeEach(async () => {
  await pool.query(
    "TRUNCATE wop_executions,wop_intents,wop_quotes,wop_test_inventory,wop_test_promos,wop_test_orders CASCADE",
  );
  await pool.query(
    "INSERT INTO wop_test_inventory VALUES('ALPHA',10);INSERT INTO wop_test_promos VALUES('TEST10',0,10)",
  );
  price = 70;
  contactStatus = "new";
});
test.after(async () => {
  await pool.end();
});
test("Automatik, Clientpreise, Kunden-ID und E-Mail-Opt-in abgewiesen", async () => {
  const r = await request();
  for (const v of [
    { ...r, promotion: { mode: "automatic_best_public" } },
    { ...r, total_cents: 1 },
    { ...r, customer_id: 1 },
    { ...r, sendOrderConfirmation: true },
  ])
    assert.equal(quoteRequest.safeParse(v).success, false);
});
test("Expliziter Code serverseitig centgenau; none ohne empfohlenen Code", async () => {
  const r = await request();
  const q = await service.quote(tenant, r);
  assert.equal(q.order_summary.total_cents, 7100);
  assert.equal(q.promotion_selection.selected_code, "TEST10");
  const n = await service.quote(tenant, {
    ...r,
    draft_id: randomUUID(),
    promotion: { mode: "none" },
  });
  assert.equal(n.order_summary.total_cents, 7800);
  assert.equal(n.promotion_selection.selected_code, null);
  await assert.rejects(
    () =>
      service.quote(tenant, {
        ...r,
        promotion: { mode: "explicit_code", code: "UNGUELTIG" },
      }),
    /promotion_not_eligible/,
  );
});
test("Keine Ausführung ohne beide nachgewiesenen Freigaben", async () => {
  const q = await service.quote(tenant, await request());
  await assert.rejects(
    () =>
      service.approveOwner(tenant, {
        quote_id: q.quote_id,
        quote_hash: q.quote_hash,
        quote_revision: 1,
        user: "1234",
        chat: "1234",
        private_chat: true,
        callback_verified: true,
      }),
    /approval_mismatch/,
  );
  await confirmed(q);
  await assert.rejects(
    () =>
      service.approveOwner(tenant, {
        quote_id: q.quote_id,
        quote_hash: q.quote_hash,
        quote_revision: 1,
        user: "9999",
        chat: "1234",
        private_chat: true,
        callback_verified: true,
      }),
    /owner_not_authorized/,
  );
  await assert.rejects(
    () =>
      service.execute(tenant, {
        execution_id: randomUUID(),
        quote_id: q.quote_id,
        quote_hash: q.quote_hash,
        quote_revision: 1,
        customer_confirmation: {
          confirmation_challenge_id: q.confirmation_challenge_id,
          message_id: "forged",
          confirmed_at: new Date().toISOString(),
        },
        owner_approval: { approval_token: "f".repeat(64) },
      }),
    /both_approvals_required/,
  );
  assert.equal((await pool.query("SELECT * FROM wop_test_orders")).rowCount, 0);
});
test("Parallel: dieselbe Execution genau einmal, zweite ID für Quote gesperrt", async () => {
  const q = await service.quote(tenant, await request()),
    e = await ready(q);
  const results = await Promise.all([
    service.execute(tenant, e),
    service.execute(tenant, e),
  ]);
  assert.deepEqual(results[0], results[1]);
  assert.equal((await pool.query("SELECT * FROM wop_test_orders")).rowCount, 1);
  assert.equal(
    (await pool.query("SELECT stock FROM wop_test_inventory")).rows[0].stock,
    9,
  );
  assert.equal(
    (await pool.query("SELECT used FROM wop_test_promos")).rows[0].used,
    1,
  );
  await assert.rejects(
    () => service.execute(tenant, { ...e, execution_id: randomUUID() }),
    /quote_already_executed/,
  );
  assert.deepEqual(await service.status(tenant, e.execution_id), results[0]);
  assert.equal(
    (await service.status("foreign", e.execution_id)).state,
    "not_found",
  );
});
test("Preisänderung erfordert neue Quote und beide neuen Freigaben", async () => {
  const r = await request(),
    q = await service.quote(tenant, r),
    e = await ready(q);
  price = 80;
  await assert.rejects(() => service.execute(tenant, e), /quote_stale/);
  const n = await service.quote(tenant, r);
  assert.equal(n.quote_revision, 2);
  await assert.rejects(() => service.execute(tenant, e), /quote_stale/);
  assert.equal((await pool.query("SELECT * FROM wop_test_orders")).rowCount, 0);
});
test("Bestandskonkurrenz rollt Auftrag und Rabattverbrauch zurück", async () => {
  const q = await service.quote(tenant, await request()),
    e = await ready(q);
  await pool.query("UPDATE wop_test_inventory SET stock=0");
  await assert.rejects(() => service.execute(tenant, e), /stock_changed/);
  assert.equal(
    (await pool.query("SELECT used FROM wop_test_promos")).rows[0].used,
    0,
  );
  assert.equal((await pool.query("SELECT * FROM wop_test_orders")).rowCount, 0);
});
test("Kundenkonflikt und fremde Katalogsignatur werden blockiert", async () => {
  const r = await request();
  contactStatus = "conflict";
  await assert.rejects(
    () => service.quote(tenant, r),
    /customer_review_required/,
  );
  contactStatus = "new";
  r.lines[0].catalog_item_id += "x";
  await assert.rejects(() => service.quote(tenant, r), /invalid_catalog_item/);
});
test("Produkt- und Packstationsschema lehnt unklare Lieferung ab", async () => {
  const r = await request();
  assert.equal(
    quoteRequest.safeParse({
      ...r,
      delivery: {
        type: "dhl_packstation",
        packstation_number: "123",
        dhl_post_number: "12345678",
        postal_code: "12345",
        city: "Teststadt",
        country_code: "AT",
      },
    }).success,
    false,
  );
});
test("Router: Schlüssel getrennt, kein gefälschter Telegram-Callback", async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/whatsapp-orders",
    createWhatsappOrderRouter(
      service,
      { read: "r".repeat(64), write: "w".repeat(64), owner: "o".repeat(64) },
      async () => {
        throw Error("invalid_receipt");
      },
    ),
  );
  const http = createServer(app);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const base =
    "http://127.0.0.1:" + (http.address() as any).port + "/api/whatsapp-orders";
  try {
    const body = JSON.stringify({ query: "Alpha", locale: "de" });
    assert.equal(
      (
        await fetch(base + "/catalog/search", {
          method: "POST",
          body,
          headers: { "Content-Type": "application/json" },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(base + "/catalog/search", {
          method: "POST",
          body,
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + "r".repeat(64),
          },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(base + "/owner-approvals", {
          method: "POST",
          body: "{}",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + "w".repeat(64),
          },
        })
      ).status,
      401,
    );
  } finally {
    await new Promise<void>((r) => http.close(() => r()));
  }
});
