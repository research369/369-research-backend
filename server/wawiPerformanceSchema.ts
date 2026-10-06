import { getPool } from "./db.js";

/**
 * Additive dashboard indexes only. Every statement is idempotent and executed
 * with a short lock timeout so normal checkout, packing and stock operations
 * never wait behind a performance optimization.
 */
export async function ensureWawiPerformanceIndexes(): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Database not available");

  const client = await pool.connect();
  try {
    await client.query("SET lock_timeout = '3s'");
    await client.query("SET statement_timeout = '90s'");
    await client.query("CREATE INDEX CONCURRENTLY IF NOT EXISTS stock_history_created_at_idx ON stock_history (created_at DESC)");
    await client.query("CREATE INDEX CONCURRENTLY IF NOT EXISTS stock_history_article_created_at_idx ON stock_history (article_id, created_at DESC)");
    await client.query("CREATE INDEX CONCURRENTLY IF NOT EXISTS order_items_order_id_idx ON order_items (order_id)");
  } finally {
    client.release();
  }
}
