import { test } from "node:test";
import assert from "node:assert/strict";
import { getPool, closeDb } from "./db.js";
import { operationsDetail } from "./operationsDetails.js";
import { isolatedOperationsDatabase } from "./operationsTestDatabase.js";
import { randomUUID } from "node:crypto";
test(
  "isolated details are scoped, read only, and exclude credentials and label content",
  { skip: process.env.OPS_ISOLATED_REHEARSAL !== "true" },
  async () => {
    assert.equal(process.env.DATABASE_URL, isolatedOperationsDatabase());
    const pool = await getPool();
    assert(pool);
    const unique = randomUUID().slice(0, 8),
      actor = {
        id: randomUUID(),
        username: "synthetic",
        role: "operator" as const,
      };
    try {
      const article = (
        await pool.query(
          "INSERT INTO articles(sku,name,stock,shop_product_id,shop_visible,selling_price,category) VALUES($1,'Synthetic details',0,$1,1,100,'Zubehör') RETURNING id",
          ["details-" + unique],
        )
      ).rows[0];
      const customer = (
        await pool.query(
          "INSERT INTO customers(name,email,country) VALUES('Synthetic details',$1,'Deutschland') RETURNING id",
          [unique + "@example.test"],
        )
      ).rows[0];
      const order = (
        await pool.query(
          "INSERT INTO orders(order_id,customer_id,first_name,last_name,email,phone,street,house_number,zip,city,country,subtotal,discount,shipping,shipping_country,total,payment_method,order_date) VALUES($1,$2,'Synthetic','Details',$3,'+49123456789','Test','1','10115','Berlin','Deutschland',10,0,8,'de',18,'SEPA',now()) RETURNING order_id",
          ["details-" + unique, customer.id, unique + "@example.test"],
        )
      ).rows[0];
      const before = (
        await pool.query(
          "SELECT (SELECT count(*) FROM orders) AS orders,(SELECT count(*) FROM stock_history) AS history",
        )
      ).rows[0];
      for (const [kind, id] of [
        ["articles", article.id],
        ["customers", customer.id],
        ["orders", order.order_id],
      ] as const) {
        const d = await operationsDetail({ kind, id }, actor);
        assert(d.record);
        assert(!JSON.stringify(d).includes("password_hash"));
        assert(!Object.hasOwn(d.record, "shipping_label_content"));
        if (kind === "customers")
          assert.equal(d.related[0].order_id, order.order_id);
      }
      await assert.rejects(
        operationsDetail({ kind: "runs", id: randomUUID() }, actor),
        /record_not_found/,
      );
      assert.deepEqual(
        (
          await pool.query(
            "SELECT (SELECT count(*) FROM orders) AS orders,(SELECT count(*) FROM stock_history) AS history",
          )
        ).rows[0],
        before,
      );
    } finally {
      await closeDb();
    }
  },
);
