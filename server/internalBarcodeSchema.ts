import { getPool } from "./db.js";

/** Separate, internal-only barcode registry. It does not alter article, stock, or QR data. */
export async function ensureInternalBarcodeSchema(): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Database not available");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS internal_article_barcodes (
      id BIGSERIAL PRIMARY KEY,
      article_id INTEGER NOT NULL UNIQUE REFERENCES articles(id) ON DELETE RESTRICT,
      barcode_value VARCHAR(40) NOT NULL UNIQUE,
      symbology VARCHAR(20) NOT NULL DEFAULT 'CODE128' CHECK (symbology = 'CODE128'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS internal_article_barcodes_created_at_idx
      ON internal_article_barcodes (created_at DESC);
  `);
}
