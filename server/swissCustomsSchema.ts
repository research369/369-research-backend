import { getPool } from "./db.js";

/**
 * Additive storage for customs data entered for a specific order. These values are
 * immutable shipment evidence once a DHL label exists; no article master data is
 * guessed or backfilled from product names.
 */
export async function ensureSwissCustomsSchema(): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Datenbank für Schweizer Zolldaten nicht verfügbar");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_swiss_customs_declarations (
      id SERIAL PRIMARY KEY,
      order_id VARCHAR(32) NOT NULL UNIQUE,
      package_weight_grams INTEGER NOT NULL CHECK (package_weight_grams > 0),
      shipping_terms VARCHAR(8) NOT NULL DEFAULT 'DAP' CHECK (shipping_terms = 'DAP'),
      invoice_number VARCHAR(64) NOT NULL,
      compliance_confirmed_at TIMESTAMP,
      compliance_confirmed_by VARCHAR(100),
      commercial_invoice_content TEXT,
      commercial_invoice_generated_at TIMESTAMP,
      customs_print_content TEXT,
      customs_print_generated_at TIMESTAMP,
      created_by VARCHAR(100) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    ALTER TABLE order_swiss_customs_declarations
      ADD COLUMN IF NOT EXISTS compliance_confirmed_at TIMESTAMP;
    ALTER TABLE order_swiss_customs_declarations
      ADD COLUMN IF NOT EXISTS compliance_confirmed_by VARCHAR(100);
    ALTER TABLE order_swiss_customs_declarations
      ADD COLUMN IF NOT EXISTS commercial_invoice_content TEXT,
      ADD COLUMN IF NOT EXISTS commercial_invoice_generated_at TIMESTAMP;
    ALTER TABLE order_swiss_customs_declarations
      ADD COLUMN IF NOT EXISTS customs_print_content TEXT,
      ADD COLUMN IF NOT EXISTS customs_print_generated_at TIMESTAMP;

    CREATE TABLE IF NOT EXISTS order_swiss_customs_items (
      id SERIAL PRIMARY KEY,
      declaration_id INTEGER NOT NULL REFERENCES order_swiss_customs_declarations(id) ON DELETE CASCADE,
      order_item_id INTEGER NOT NULL UNIQUE REFERENCES order_items(id) ON DELETE RESTRICT,
      item_description VARCHAR(200) NOT NULL,
      hs_code VARCHAR(10) NOT NULL,
      country_of_origin VARCHAR(3) NOT NULL,
      unit_weight_grams INTEGER NOT NULL CHECK (unit_weight_grams > 0),
      unit_customs_value_eur NUMERIC(12,2),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS order_swiss_customs_items_declaration_idx
      ON order_swiss_customs_items(declaration_id);

    ALTER TABLE order_swiss_customs_items
      ADD COLUMN IF NOT EXISTS unit_customs_value_eur NUMERIC(12,2);
  `);
}
