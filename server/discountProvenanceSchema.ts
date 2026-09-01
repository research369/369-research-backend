import { getPool } from "./db.js";

/**
 * Additive, strukturierte Herkunft aller Preisnachlässe einer Bestellung.
 * Der bestehende Rabattbetrag und Rabattcode bleiben unverändert; die neue
 * JSONB-Spalte liefert ausschließlich nachvollziehbare Provenienz.
 */
export async function ensureDiscountProvenanceSchema(): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Database not available");

  await pool.query(`
    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS discount_breakdown JSONB;
  `);
}
