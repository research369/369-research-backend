import { runPartnerAudit } from "./partnerAudit.js";
import { isolatedOperationsDatabase } from "./operationsTestDatabase.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPool, closeDb } from "./db.js";
import { simulateCheckout } from "./operationsSimulation.js";
import { diagnosePartner } from "./operationsPartner.js";
import { bookPaidPartnerCommission } from "./partnerCreditService.js";
import { hasOtherPaidCodeOrder } from "./partnerCodeHistory.js";

test(
  "isolated public code checkout, individual rules, paid-and-dispatched ledger and immutable preview",
  { skip: process.env.OPS_ISOLATED_REHEARSAL !== "true" },
  async () => {
    assert.equal(process.env.DATABASE_URL, isolatedOperationsDatabase());
    const pool = await getPool();
    assert(pool);
    const tag = randomUUID().slice(0, 8);
    const family = "audit-" + tag;
    const email = "customer-" + tag + "@example.invalid";
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = async () => {
      throw Error("No external calls allowed");
    };
    try {
      await pool.query(
        `INSERT INTO partner_programs(key,label,customer_discount_policy,commission_policy,settlement_method,allow_self_order_credit) VALUES ('creator','Creator','each_valid_code_use','each_paid_code_order','payout',false),('partner','Partner','first_paid_code_use','first_paid_code_order','shop_credit',true) ON CONFLICT(key) DO UPDATE SET customer_discount_policy=EXCLUDED.customer_discount_policy,commission_policy=EXCLUDED.commission_policy,settlement_method=EXCLUDED.settlement_method,active=true`,
      );
      await pool.query(
        `INSERT INTO shop_settings(key,value) VALUES('global_automatic_discount','{"enabled":false}') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
      );
      const partner = (
        await pool.query(
          `INSERT INTO partners(name,email,code,partner_number,program_key,commission_percent,customer_discount_percent) VALUES ('Synthetic audit',$1,$2,$3,'creator',99,99) RETURNING id`,
          ["owner-" + tag + "@example.invalid", family, "P-" + tag],
        )
      ).rows[0].id;
      const codes: Array<{ id: number; display_code: string }> = [];
      for (const [suffix, discount, commission] of [
        ["A", 10, 20],
        ["B", 15, 7.5],
      ] as const) {
        codes.push(
          (
            await pool.query(
              `INSERT INTO partner_codes(partner_id,display_code,code_normalized,customer_discount_percent,commission_percent) VALUES($1,$2::varchar,upper($2::varchar),$3,$4) RETURNING id,display_code`,
              [partner, family + suffix, discount, commission],
            )
          ).rows[0],
        );
      }
      const article = (
        await pool.query(
          `INSERT INTO articles(sku,name,stock,shop_product_id,shop_visible,selling_price,category) VALUES($1,'Synthetic (10 mg)',7,$2,1,100,'Zubehör') RETURNING id`,
          [family, family],
        )
      ).rows[0].id;
      await pool.query("UPDATE articles SET variants=$2 WHERE id=$1", [
        article,
        JSON.stringify([
          {
            dosage: "10 mg",
            price: 100,
            inventoryArticleId: article,
            sku: family,
          },
        ]),
      ]);
      const input = {
        items: [
          {
            articleId: article,
            sku: family,
            shopProductId: family,
            variantKey: "10 mg",
            quantity: 1,
          },
        ],
        country: "Schweiz",
        publicPartnerId: partner,
        partnerCode: codes[0].display_code,
        contact: { email, phone: "" },
      };
      const snapshot = async () =>
        (
          await pool.query(
            `SELECT (SELECT count(*) FROM orders) AS orders,(SELECT count(*) FROM partner_transactions) AS ledger,(SELECT count(*) FROM stock_history) AS stock_history,(SELECT credit_balance FROM partners WHERE id=$1) AS balance,(SELECT stock FROM articles WHERE id=$2) AS stock`,
            [partner, article],
          )
        ).rows[0];
      const before = await snapshot();
      const preview = () => simulateCheckout(input, {} as any, {} as any);
      let r = await preview();
      assert.equal(r.checkoutCodeValidation?.consistent, true);
      assert.equal(r.discount, 10);
      assert.equal(r.partnerCustomerCheck.expectedAmount, 18);
      assert.equal(r.partnerCustomerCheck.program.settlementMethod, "payout");
      assert.equal(r.partnerCustomerCheck.booking, "not_performed");
      input.partnerCode = codes[1].display_code;
      r = await preview();
      assert.equal(r.discount, 15);
      assert.equal(r.partnerCustomerCheck.expectedAmount, 6.38);
      assert.equal(r.partnerCustomerCheck.base, 85);
      assert.deepEqual(await snapshot(), before);
      await assert.rejects(
        simulateCheckout(
          { ...input, publicPartnerId: partner + 999999 },
          {} as any,
          {} as any,
        ),
        /gehört/,
      );
      await assert.rejects(
        simulateCheckout(
          { ...input, partnerId: partner },
          {} as any,
          {} as any,
        ),
        /getrennte/,
      );
      await assert.rejects(
        simulateCheckout(
          { ...input, contact: { email: "owner-" + tag + "@example.invalid" } },
          {} as any,
          {} as any,
        ),
        /anderen Kunden/,
      );
      await pool.query("UPDATE partner_codes SET is_active=false WHERE id=$1", [
        codes[1].id,
      ]);
      await assert.rejects(preview(), /nicht aktiv/);
      await pool.query("UPDATE partner_codes SET is_active=true WHERE id=$1", [
        codes[1].id,
      ]);
      await pool.query(
        "UPDATE partners SET program_key='partner' WHERE id=$1",
        [partner],
      );
      await assert.rejects(
        simulateCheckout(
          { ...input, contact: undefined },
          {} as any,
          {} as any,
        ),
        /E-Mail/,
      );
      r = await preview();
      assert.equal(r.partnerCustomerCheck.eligible, true);
      assert.equal(r.checkoutCodeValidation?.consistent, true);
      const insertOrder = async (id: string, status: string, paid: boolean) =>
        pool.query(
          `INSERT INTO orders(order_date,order_id,first_name,last_name,email,phone,street,house_number,zip,city,country,subtotal,discount,shipping,shipping_country,total,payment_method,status,paid_at,partner_code,partner_source_id,partner_code_id_snapshot,partner_commission,partner_program_snapshot,partner_settlement_method_snapshot,partner_commission_policy_snapshot,partner_commission_percent_snapshot,partner_commission_base_snapshot) VALUES(now(),$1,'Synthetic','Audit',$2,'','','','','','Schweiz',100,15,25,'CH',110,'SEPA',$3,CASE WHEN $4 THEN now() ELSE NULL END,$5,$6,$7,6.38,'partner','shop_credit','first_paid_code_order',7.5,85)`,
          [id, email, status, paid, input.partnerCode, partner, codes[1].id],
        );
      const orderId = "AUD-" + tag;
      await insertOrder(orderId, "bezahlt", false);
      r = await preview();
      assert.equal(r.discount, 15);
      assert.equal(r.checkoutCodeValidation?.consistent, true);
      assert.equal(
        (await bookPaidPartnerCommission(orderId)).reason,
        "order_not_paid",
      );
      await assert.rejects(bookPaidPartnerCommission("ABSENT-" + tag), /nicht gefunden/);
      for (const [status, paid, shipped, reason] of [
        ["offen", false, false, "order_not_paid"],
        ["bezahlt", true, false, "order_not_shipped"],
        ["gepackt", true, false, "order_not_shipped"],
        ["abgeholt", true, false, "order_not_shipped"],
        ["versendet", false, true, "order_not_paid"],
        ["versendet", true, false, "order_not_shipped"],
        ["zugestellt", true, false, "order_not_shipped"],
        ["storniert", true, true, "order_not_paid"],
      ] as const) {
        await pool.query("UPDATE orders SET status=$2,paid_at=CASE WHEN $3 THEN now() ELSE NULL END,shipped_at=CASE WHEN $4 THEN now() ELSE NULL END WHERE order_id=$1", [orderId,status,paid,shipped]);
        const before = await snapshot();
        assert.equal((await bookPaidPartnerCommission(orderId)).reason, reason);
        assert.deepEqual(await snapshot(), before, status + ": no financial writes");
      }
      await pool.query(
        "UPDATE orders SET status='versendet',paid_at=now(),shipped_at=now() WHERE order_id=$1",
        [orderId],
      );
      assert.equal(
        await hasOtherPaidCodeOrder(
          (q, v) => pool.query(q, v),
          input.partnerCode,
          email,
          orderId,
        ),
        false,
      );
      r = await preview();
      assert.equal(r.discount, 0);
      assert.equal(r.partnerCustomerCheck.eligible, false);
      assert.equal(r.partnerCustomerCheck.expectedAmount, 0);
      assert.equal(r.checkoutCodeValidation?.consistent, true);
      const concurrent = await Promise.all([bookPaidPartnerCommission(orderId), bookPaidPartnerCommission(orderId)]);
      assert.equal(concurrent.filter(r=>r.booked).length,1);
      const booked = concurrent.find(r=>r.booked)!;
      assert.equal(booked.amount, 6.38);
      assert.equal(
        (await bookPaidPartnerCommission(orderId)).reason,
        "already_booked",
      );
      const second = "AUB-" + tag;
      await insertOrder(second, "versendet", true);
      await pool.query("UPDATE orders SET shipped_at=now()-interval '1 day' WHERE order_id=$1",[second]);
      assert.equal(
        (await bookPaidPartnerCommission(second)).reason,
        "one_time_already_paid",
      );
      // The oldest missing booking must remain visible beyond the old 20-order slice.
      await pool.query(
        "UPDATE orders SET partner_commission_policy_snapshot='each_paid_code_order',paid_at=now()-interval '1 day' WHERE order_id=$1",
        [second],
      );
      for (let n = 0; n < 21; n++)
        await insertOrder("AU-" + tag + "-" + n, "offen", false);
      await pool.query(`CREATE TABLE IF NOT EXISTS failed_orders (
        id SERIAL PRIMARY KEY, attempted_order_id VARCHAR(50), customer_name VARCHAR(200),
        customer_email VARCHAR(320), customer_phone VARCHAR(50), total DECIMAL(10,2),
        items_json TEXT,input_json TEXT,error_message TEXT,created_at TIMESTAMP DEFAULT NOW())`);
      const beforeAudit = await snapshot();
      const audit = await runPartnerAudit({} as any, {} as any);
      assert.equal(audit.sideEffects, false);
      assert(audit.counts.partners >= 1);
      assert(
        audit.findings.some(
          (f) => f.orderId === second && f.kind === "missing",
        ),
      );
      assert(
        audit.cases.some(
          (c) => c.partnerId === partner && c.status === "passed",
        ),
      );
      assert(!JSON.stringify(audit).includes(email));
      const originalDigest = audit.findings.find(f=>f.orderId===second)?.evidenceDigest;
      assert.match(originalDigest ?? "",/^[a-f0-9]{64}$/);
      assert.deepEqual(await snapshot(),beforeAudit);
      await pool.query("INSERT INTO failed_orders(attempted_order_id,customer_email,error_message) VALUES($1,$2,'Synthetic blocked attempt')",[second,email]);
      const revisedEvidence = await runPartnerAudit({} as any,{} as any);
      const changedDigest = revisedEvidence.findings.find(f=>f.orderId===second)?.evidenceDigest;
      assert.notEqual(changedDigest,originalDigest,"Changed failed-checkout evidence must invalidate a review");
      assert(!JSON.stringify(revisedEvidence).includes(email));
      assert(!JSON.stringify(revisedEvidence).includes('Synthetic blocked attempt'));
      await pool.query("DELETE FROM failed_orders WHERE attempted_order_id=$1",[second]);

      await pool.query(
        "UPDATE partner_codes SET code_normalized=code_normalized||'-BROKEN' WHERE id=$1",
        [codes[1].id],
      );
      const brokenAudit = await runPartnerAudit({} as any, {} as any);
      assert(
        brokenAudit.findings.some(
          (f) =>
            f.partnerId === partner &&
            f.code === codes[1].display_code &&
            f.kind === "checkout_failed",
        ),
      );
      await pool.query(
        "UPDATE partner_codes SET code_normalized=upper(display_code) WHERE id=$1",
        [codes[1].id],
      );
      assert.deepEqual(await snapshot(), beforeAudit);
      await pool.query("DELETE FROM orders WHERE order_id=ANY($1::text[])", [
        Array.from({ length: 21 }, (_, n) => "AU-" + tag + "-" + n),
      ]);
      await pool.query(
        "UPDATE orders SET partner_commission_policy_snapshot='first_paid_code_order',paid_at=now() WHERE order_id=$1",
        [second],
      );
      const afterBooking = await snapshot();
      const diag = await diagnosePartner({ partnerId: partner });
      assert.equal(diag.codes.length, 2);
      const evidence = diag.bookingEvidence.find((o) => o.order_id === orderId);
      assert(evidence);
      assert.equal(evidence.audit, "booked");
      assert.equal(evidence.booking_count, 1);
      assert.equal(Number(evidence.booked_amount), 6.38);
      assert.equal(Number(evidence.expected_amount), 6.38);
      assert.equal(
        diag.bookingEvidence.find((o) => o.order_id === second)?.audit,
        "repeat_excluded",
      );
      await pool.query(
        "UPDATE partner_transactions SET amount=1 WHERE order_id=$1 AND type='provision'",
        [orderId],
      );
      assert.equal(
        (await diagnosePartner({ partnerId: partner })).bookingEvidence.find(
          (o) => o.order_id === orderId,
        )?.audit,
        "amount_mismatch",
      );
      await pool.query(
        "UPDATE partner_transactions SET amount=6.38 WHERE order_id=$1 AND type='provision'",
        [orderId],
      );
      await pool.query(
        "UPDATE partners SET program_key='creator' WHERE id=$1",
        [partner],
      );
      r = await preview();
      assert.equal(r.discount, 15);
      assert.equal(r.partnerCustomerCheck.eligible, true);
      assert.equal(r.partnerCustomerCheck.expectedAmount, 6.38);
      assert.equal(r.checkoutCodeValidation?.consistent, true);
      await pool.query(
        "UPDATE orders SET partner_commission_policy_snapshot=NULL,partner_commission=0 WHERE order_id=$1",
        [second],
      );
      assert.equal(
        (await diagnosePartner({ partnerId: partner })).bookingEvidence.find(
          (o) => o.order_id === second,
        )?.audit,
        "legacy_unknown",
      );
      await preview();
      await diagnosePartner({ partnerId: partner });
      assert.deepEqual(await snapshot(), afterBooking);
    } finally {
      globalThis.fetch = fetchBefore;
      await closeDb();
    }
  },
);
