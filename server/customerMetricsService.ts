import { getPool } from "./db.js";
import { calculateCustomerOrderMetrics } from "./customerOrderMetrics.js";

/** Recomputes one customer's derived CRM fields from directly linked active orders. */
export async function refreshCustomerOrderMetrics(customerId: number): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Database not available");

  const result = await pool.query(
    `SELECT total, status, order_date
     FROM orders
     WHERE customer_id = $1`,
    [customerId],
  );
  const metrics = calculateCustomerOrderMetrics(result.rows.map((row) => ({
    total: row.total,
    status: row.status,
    orderDate: row.order_date,
  })));

  await pool.query(
    `UPDATE customers
     SET total_orders = $2,
         total_spent = $3,
         first_order_date = $4,
         last_order_date = $5,
         updated_at = NOW()
     WHERE id = $1`,
    [
      customerId,
      metrics.totalOrders,
      metrics.totalSpent.toFixed(2),
      metrics.firstOrderDate,
      metrics.lastOrderDate,
    ],
  );
}
