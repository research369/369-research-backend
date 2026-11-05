import { getPool } from "./db.js";

/**
 * Additive Goodies schema.
 *
 * Goodies are inventory articles first. The catalog only adds operational metadata
 * (optional grouping and future reward/shop flags); it never changes the existing
 * order-item, checkout, payment or product-category contracts.
 */
export async function ensureGoodieSchema(): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Datenbankverbindung für Goodies nicht verfügbar");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS goodie_catalog (
      id SERIAL PRIMARY KEY,
      article_id INTEGER NOT NULL UNIQUE REFERENCES articles(id) ON DELETE RESTRICT,
      group_label VARCHAR(80),
      display_label VARCHAR(160),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      reward_eligible BOOLEAN NOT NULL DEFAULT FALSE,
      shop_sellable BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order INTEGER NOT NULL DEFAULT 999,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS goodie_catalog_active_idx
      ON goodie_catalog (is_active, sort_order, group_label);

    CREATE TABLE IF NOT EXISTS goodie_assignments (
      id BIGSERIAL PRIMARY KEY,
      order_id VARCHAR(32) NOT NULL REFERENCES orders(order_id) ON DELETE RESTRICT,
      customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
      article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE RESTRICT,
      article_name_snapshot VARCHAR(200) NOT NULL,
      sku_snapshot VARCHAR(80) NOT NULL,
      display_label_snapshot VARCHAR(160),
      group_label_snapshot VARCHAR(80),
      quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
      source VARCHAR(32) NOT NULL DEFAULT 'packing_manual'
        CHECK (source IN ('packing_manual', 'checkout_reward', 'manual_correction')),
      request_id VARCHAR(64) NOT NULL UNIQUE,
      assigned_by VARCHAR(100) NOT NULL,
      assigned_at TIMESTAMP NOT NULL DEFAULT NOW(),
      reversed_at TIMESTAMP,
      reversed_by VARCHAR(100),
      reversal_reason TEXT
    );

    CREATE INDEX IF NOT EXISTS goodie_assignments_order_idx
      ON goodie_assignments (order_id, assigned_at DESC);
    CREATE INDEX IF NOT EXISTS goodie_assignments_customer_idx
      ON goodie_assignments (customer_id, assigned_at DESC)
      WHERE reversed_at IS NULL;
    CREATE INDEX IF NOT EXISTS goodie_assignments_article_idx
      ON goodie_assignments (article_id, assigned_at DESC)
      WHERE reversed_at IS NULL;
    ALTER TABLE goodie_assignments ADD COLUMN IF NOT EXISTS request_id VARCHAR(64);
    CREATE UNIQUE INDEX IF NOT EXISTS goodie_assignments_request_id_uq
      ON goodie_assignments (request_id) WHERE request_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS goodie_reward_config (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      qualification_basis VARCHAR(64) NOT NULL DEFAULT 'after_discount_excluding_shipping',
      tiers_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_by VARCHAR(100)
    );

    INSERT INTO goodie_reward_config (id, enabled, qualification_basis, tiers_json)
    VALUES (1, FALSE, 'after_discount_excluding_shipping', '[]'::jsonb)
    ON CONFLICT (id) DO NOTHING;
  `);

  console.log("[Goodies] Katalog, Ausgabenjournal und deaktivierte Checkout-Vorbereitung bereit");
}
