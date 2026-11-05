import { z } from "zod";
import { getPool } from "./db.js";
import type { OpsActor } from "./operationsAuth.js";
export async function operationsDetail(body: unknown, actor: OpsActor) {
  const i = z
    .object({
      kind: z.enum(["articles", "orders", "customers", "runs"]),
      id: z.union([z.number().int().positive(), z.string().min(1).max(100)]),
    })
    .strict()
    .parse(body);
  const pool = await getPool();
  if (!pool) throw Error("unavailable");
  const c = await pool.connect();
  try {
    await c.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    await c.query("SET LOCAL statement_timeout='5000ms'");
    let record: any,
      related: any[] = [];
    if (i.kind === "articles") {
      record = (
        await c.query(
          "SELECT id,sku,name,category,shop_product_id,stock,purchase_price,selling_price,sale_price,shop_visible,is_active,variants FROM articles WHERE id=$1",
          [i.id],
        )
      ).rows[0];
      if (record)
        related = (
          await c.query(
            "SELECT id,sku,name,stock,purchase_price,selling_price,shop_visible FROM articles WHERE shop_product_id=$1 ORDER BY id",
            [record.shop_product_id],
          )
        ).rows;
    }
    if (i.kind === "customers") {
      record = (
        await c.query(
          "SELECT id,name,email,phone,street,house_number,zip,city,country,company FROM customers WHERE id=$1",
          [i.id],
        )
      ).rows[0];
      if (record)
        related = (
          await c.query(
            "SELECT id,order_id,status,order_date,total,tracking_number,tracking_carrier FROM orders WHERE customer_id=$1 ORDER BY id DESC LIMIT 50",
            [i.id],
          )
        ).rows;
    }
    if (i.kind === "orders")
      record = (
        await c.query(
          "SELECT id,order_id,status,order_date,first_name,last_name,email,phone,street,house_number,zip,city,country,subtotal,discount,shipping,total,payment_method,tracking_number,tracking_carrier,(shipping_label_content IS NOT NULL OR shipping_label_url IS NOT NULL) AS label_available FROM orders WHERE order_id=$1 OR id::text=$1",
          [String(i.id)],
        )
      ).rows[0];
    if (i.kind === "orders" && record)
      record.items = (
        await c.query(
          "SELECT name,dosage,variant,type,price,quantity,is_nasal_spray,is_nasal_diy_set,is_plug_play FROM order_items WHERE order_id=$1 ORDER BY id",
          [record.order_id],
        )
      ).rows;
    if (i.kind === "runs") {
      record = (
        await c.query(
          "SELECT r.id,r.state,r.created_at,r.completed_at,r.result,p.operation_type,p.target_sku,p.before_snapshot,p.planned_mutation,p.confirmed_at,p.created_at AS requested_at,p.actor_id FROM ops_console_receipts r JOIN ops_console_previews p ON p.id=r.preview_id WHERE r.id=$1 AND (r.actor_id=$2 OR $3::bool)",
          [i.id, actor.id, actor.role === "admin"],
        )
      ).rows[0];
      if (record)
        related = (
          await c.query(
            "SELECT event_type,data,created_at FROM ops_console_events WHERE receipt_id=$1 ORDER BY id",
            [i.id],
          )
        ).rows;
    }
    if (!record) throw Error("record_not_found");
    await c.query("COMMIT");
    return {
      kind: i.kind,
      record,
      related,
      checkedAt: new Date().toISOString(),
    };
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
