import { isolatedOperationsDatabase } from "./operationsTestDatabase.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPool, closeDb, withReadOnlyDatabase } from "./db.js";
import { searchOperations } from "./operationsSearch.js";
import { simulateCheckout } from "./operationsSimulation.js";
test(
  "isolated canonical simulation: discount and stock, no writes or external calls",
  { skip: process.env.OPS_ISOLATED_REHEARSAL !== "true" },
  async () => {
    assert.equal(process.env.DATABASE_URL, isolatedOperationsDatabase());
    const pool = await getPool();
    assert(pool);
    const family = "sim-" + randomUUID().slice(0, 8);
    const sku = family + "-10";
    const id = (
      await pool.query(
        "INSERT INTO articles(sku,name,stock,shop_product_id,shop_visible,selling_price,category) VALUES($1,'Test (10 mg)',7,$2,1,100,'Zubehör') RETURNING id",
        [sku, family],
      )
    ).rows[0].id;
    await pool.query("UPDATE articles SET variants=$2 WHERE id=$1", [
      id,
      JSON.stringify([
        { dosage: "10 mg", price: 100, inventoryArticleId: id, sku },
      ]),
    ]);
    await pool.query(
      "INSERT INTO shop_settings(key,value) VALUES('global_automatic_discount',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
      [
        JSON.stringify({
          enabled: true,
          percentage: 20,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          stackWithPromotionCodes: true,
          labelDe: "Testaktion",
          labelEn: "Test discount",
        }),
      ],
    );
    const before = (
      await pool.query(
        "SELECT (SELECT count(*) FROM orders) AS orders,(SELECT count(*) FROM stock_history) AS history",
      )
    ).rows[0];
    for (const kind of [
      "articles",
      "orders",
      "customers",
      "partners",
    ] as const) {
      const r = await searchOperations({ q: "Synthetic", kind });
      assert(Array.isArray(r.results));
    }
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      throw Error("External call forbidden");
    };
    try {
      const r = await simulateCheckout(
        {
          items: [
            {
              articleId: id,
              sku,
              shopProductId: family,
              variantKey: "10 mg",
              quantity: 2,
            },
          ],
          country: "Deutschland",
        },
        {} as any,
        {} as any,
      );
      assert.equal(r.subtotal, 200);
      assert.equal(r.discount, 40);
      assert.equal(r.shipping, 8);
      assert.equal(r.total, 168);
      assert.equal(r.available, true);
      assert.equal(r.sideEffects, false);
    assert.equal(r.addressChecked,true);assert.equal(r.addressValidation.status,'warning');assert(r.addressValidation.warnings.some((w:any)=>w.code==='street_missing'));
      assert.deepEqual(
        (
          await pool.query(
            "SELECT (SELECT count(*) FROM orders) AS orders,(SELECT count(*) FROM stock_history) AS history",
          )
        ).rows[0],
        before,
      );
      assert.equal(
        (await pool.query("SELECT stock FROM articles WHERE id=$1", [id]))
          .rows[0].stock,
        7,
      );
      await assert.rejects(
        withReadOnlyDatabase(async () => {
          const p = await getPool();
          await p!.query("UPDATE articles SET stock=99 WHERE id=$1", [id]);
        }),
        /read-only transaction/,
      );
    } finally {
      globalThis.fetch = original;
      await closeDb();
    }
  },
);
test(
  "isolated identified KWK preview uses shared entitlement/ledger checks without reservation",
  { skip: process.env.OPS_ISOLATED_REHEARSAL !== "true" },
  async () => {
    assert.equal(process.env.DATABASE_URL, isolatedOperationsDatabase());
    process.env.FEATURE_KWK_ENABLED = "true";
    const pool = await getPool();
    assert(pool);
    const unique = randomUUID().slice(0, 8),
      family = "kwk-sim-" + unique,
      sku = family + "-10",
      email = unique + "@example.test",
      code = ("TEST-" + unique).toUpperCase();
    await pool.query(
      "CREATE TABLE IF NOT EXISTS kwk_accounts(id serial PRIMARY KEY,kwk_number varchar NOT NULL,referral_code varchar UNIQUE NOT NULL,name varchar NOT NULL,email varchar NOT NULL,phone varchar NOT NULL,password_hash text NOT NULL,status varchar DEFAULT 'aktiv',deleted_at timestamp)",
    );
    await pool.query(
      "CREATE TABLE IF NOT EXISTS kwk_ledger(id serial PRIMARY KEY,kwk_id integer NOT NULL,amount numeric NOT NULL,type varchar NOT NULL,status varchar DEFAULT 'confirmed')",
    );
    const article = (
      await pool.query(
        "INSERT INTO articles(sku,name,stock,shop_product_id,shop_visible,selling_price,category) VALUES($1,'Synthetic (10 mg)',10,$2,1,100,'Zubehör') RETURNING id",
        [sku, family],
      )
    ).rows[0].id;
    await pool.query("UPDATE articles SET variants=$2 WHERE id=$1", [
      article,
      JSON.stringify([
        { dosage: "10 mg", price: 100, inventoryArticleId: article, sku },
      ]),
    ]);
    const customer = (
      await pool.query(
        "INSERT INTO customers(name,email,phone,country) VALUES('Synthetic customer',$1,'+491234567891','Deutschland') RETURNING id",
        [email],
      )
    ).rows[0].id;
    const account = (
      await pool.query(
        "INSERT INTO kwk_accounts(kwk_number,referral_code,name,email,phone,password_hash) VALUES($1,$1,'Synthetic account',$2,'+491234567891','not-a-login') RETURNING id",
        [code, email],
      )
    ).rows[0].id;
    await pool.query(
      "INSERT INTO kwk_ledger(kwk_id,amount,type,status) VALUES($1,50,'manual_correction','confirmed')",
      [account],
    );
    await pool.query(
      "INSERT INTO orders(order_id,first_name,last_name,email,phone,street,house_number,zip,city,country,subtotal,discount,shipping,shipping_country,total,payment_method,order_date) VALUES($1,'Synthetic','Previous',$2,'+492222222222','Test','1','10115','Berlin','Deutschland',10,0,8,'de',18,'SEPA',now())",
      ["synthetic-" + unique, "existing-" + email],
    );
    const body = {
      items: [
        {
          articleId: article,
          sku,
          shopProductId: family,
          variantKey: "10 mg",
          quantity: 2,
        },
      ],
      country: "Deutschland",
    };
    const before = (
      await pool.query(
        "SELECT (SELECT count(*) FROM orders) AS orders,(SELECT count(*) FROM stock_history) AS stock,(SELECT count(*) FROM kwk_ledger) AS ledger",
      )
    ).rows[0];
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      throw Error("External call forbidden");
    };
    try {
      const credit = await simulateCheckout(
        { ...body, customerId: customer, kwkCreditUsed: 30 },
        {} as any,
        {} as any,
      );
      assert.equal(credit.total, 138);
      assert.equal(credit.discount, 70);
      const referral = await simulateCheckout(
        {
          ...body,
          kwkCode: code,
          contact: { email: "new-" + email, phone: "+491999999999" },
        },
        {} as any,
        {} as any,
      );
      assert.equal(referral.total, 152);
      assert.equal(referral.discount, 56);
      await assert.rejects(
        simulateCheckout(
          {
            ...body,
            kwkCode: code,
            contact: { email: "existing-" + email, phone: "+493333333333" },
          },
          {} as any,
          {} as any,
        ),
        /KWK_NUR_NEUKUNDEN/,
      );
      await assert.rejects(
        simulateCheckout(
          { ...body, kwkCode: code, customerId: customer },
          {} as any,
          {} as any,
        ),
        /KWK_SELBSTWERBUNG/,
      );
      await assert.rejects(
        simulateCheckout(
          { ...body, customerId: customer, kwkCreditUsed: 60 },
          {} as any,
          {} as any,
        ),
        /KWK_GUTHABEN_NICHT_AUSREICHEND/,
      );
      await assert.rejects(
        simulateCheckout({ ...body, kwkCode: code }, {} as any, {} as any),
        /Kontakt angeben/,
      );
      assert.deepEqual(
        (
          await pool.query(
            "SELECT (SELECT count(*) FROM orders) AS orders,(SELECT count(*) FROM stock_history) AS stock,(SELECT count(*) FROM kwk_ledger) AS ledger",
          )
        ).rows[0],
        before,
      );
      assert.equal(
        Number(
          (
            await pool.query(
              "SELECT sum(amount) AS available FROM kwk_ledger WHERE kwk_id=$1",
              [account],
            )
          ).rows[0].available,
        ),
        50,
      );
    } finally {
      globalThis.fetch = original;
      delete process.env.FEATURE_KWK_ENABLED;
      await closeDb();
    }
  },
);
test(
  "isolated partner own-order preview retains discount plus credit and enforces program exclusion",
  { skip: process.env.OPS_ISOLATED_REHEARSAL !== "true" },
  async () => {
    assert.equal(process.env.DATABASE_URL, isolatedOperationsDatabase());
    const pool = await getPool();
    assert(pool);
    const unique = randomUUID().slice(0, 8),
      family = "partner-sim-" + unique,
      sku = family + "-10";
    await pool.query(
      "INSERT INTO partner_programs(key,label,customer_discount_policy,commission_policy,settlement_method,allow_self_order_credit,active) VALUES('partner','Synthetic partner','each_valid_code_use','each_paid_code_order','shop_credit',true,true),('creator','Synthetic creator','each_valid_code_use','each_paid_code_order','payout',false,true) ON CONFLICT(key) DO UPDATE SET settlement_method=EXCLUDED.settlement_method,allow_self_order_credit=EXCLUDED.allow_self_order_credit,active=true",
    );
    const article = (
      await pool.query(
        "INSERT INTO articles(sku,name,stock,shop_product_id,shop_visible,selling_price,category) VALUES($1,'Synthetic (10 mg)',10,$2,1,100,'Zubehör') RETURNING id",
        [sku, family],
      )
    ).rows[0].id;
    await pool.query("UPDATE articles SET variants=$2 WHERE id=$1", [
      article,
      JSON.stringify([
        { dosage: "10 mg", price: 100, inventoryArticleId: article, sku },
      ]),
    ]);
    const partner = (
      await pool.query(
        "INSERT INTO partners(name,email,code,partner_number,program_key,credit_balance,customer_discount_percent,commission_percent,country) VALUES('Synthetic partner',$1,$2,$2,'partner',50,15,10,'Deutschland') RETURNING id",
        [unique + "@example.test", "TEST-" + unique],
      )
    ).rows[0].id;
    const body = {
      items: [
        {
          articleId: article,
          sku,
          shopProductId: family,
          variantKey: "10 mg",
          quantity: 2,
        },
      ],
      country: "Deutschland",
      partnerId: partner,
    };
    const before = (
      await pool.query(
        "SELECT (SELECT count(*) FROM orders) AS orders,(SELECT count(*) FROM stock_history) AS stock",
      )
    ).rows[0];
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      throw Error("External call forbidden");
    };
    try {
      const r = await simulateCheckout(
        { ...body, creditUsed: 20 },
        {} as any,
        {} as any,
      );
      assert.equal(r.total, 124);
      assert.equal(r.discount, 84);
      assert.equal(
        Number(
          (
            await pool.query(
              "SELECT credit_balance FROM partners WHERE id=$1",
              [partner],
            )
          ).rows[0].credit_balance,
        ),
        50,
      );
      await pool.query(
        "UPDATE partners SET program_key='creator' WHERE id=$1",
        [partner],
      );
      await assert.rejects(
        simulateCheckout({ ...body, creditUsed: 20 }, {} as any, {} as any),
        /PARTNER_GUTHABEN_PROGRAMM_AUSGESCHLOSSEN/,
      );
      const creator = await simulateCheckout(body, {} as any, {} as any);
      assert.equal(creator.total, 128);
      assert.deepEqual(
        (
          await pool.query(
            "SELECT (SELECT count(*) FROM orders) AS orders,(SELECT count(*) FROM stock_history) AS stock",
          )
        ).rows[0],
        before,
      );
    } finally {
      globalThis.fetch = original;
      await closeDb();
    }
  },
);
test(
  "isolated expired 20 percent reference uses real checkout price engine: 219, partner 10 percent, credit 12.06, cold Swiss shipping 25",
  { skip: process.env.OPS_ISOLATED_REHEARSAL !== "true" },
  async () => {
    assert.equal(process.env.DATABASE_URL, isolatedOperationsDatabase());
    const pool = await getPool();
    assert(pool);
    const unique = randomUUID().slice(0, 8),
      sku = "expiry-" + unique;
    try {
      const id = (
        await pool.query(
          "INSERT INTO articles(sku,name,stock,shop_product_id,shop_visible,selling_price,category) VALUES($1,'Synthetic Nasenspray (10 mg)',7,$1,1,219,'Zubehör') RETURNING id",
          [sku],
        )
      ).rows[0].id;
      await pool.query("UPDATE articles SET variants=$2 WHERE id=$1", [
        id,
        JSON.stringify([
          { dosage: "10 mg", price: 219, inventoryArticleId: id, sku },
        ]),
      ]);
      const partner = (
        await pool.query(
          "INSERT INTO partners(name,email,code,partner_number,program_key,credit_balance,customer_discount_percent,commission_percent,country) VALUES('Synthetic expiry',$1,$2,$2,'partner',12.06,10,0,'Schweiz') RETURNING id",
          [unique + "@example.test", sku],
        )
      ).rows[0].id;
      await pool.query(
        "INSERT INTO shop_settings(key,value) VALUES('global_automatic_discount',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
        [
          JSON.stringify({
            enabled: true,
            percentage: 20,
            expiresAt: new Date(Date.now() - 60000).toISOString(),
            stackWithPromotionCodes: true,
            labelDe: "Abgelaufen",
            labelEn: "Expired",
          }),
        ],
      );
      const r = await simulateCheckout(
        {
          items: [
            {
              articleId: id,
              sku,
              shopProductId: sku,
              variantKey: "10 mg",
              quantity: 1,
            },
          ],
          country: "Schweiz",
          partnerId: partner,
          creditUsed: 12.06,
        },
        {} as any,
        {} as any,
      );
      assert.equal(r.subtotal, 219);
      assert.equal(r.discount, 33.96);
      assert.equal(r.shipping, 25);
      assert.equal(r.total, 210.04);
      assert.equal(r.shippingDetails.cooled, true);
      assert.equal(
        Number(
          (
            await pool.query(
              "SELECT credit_balance FROM partners WHERE id=$1",
              [partner],
            )
          ).rows[0].credit_balance,
        ),
        12.06,
      );
    } finally {
      await closeDb();
    }
  },
);
