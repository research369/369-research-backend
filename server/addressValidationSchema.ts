import { getPool } from "./db.js";

/**
 * Additive, idempotent schema for address-validation evidence.
 * Evidence is never deleted through the WaWi UI. Existing customers and orders stay untouched.
 */
export async function ensureAddressValidationSchema(): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Datenbankverbindung für Adressprüfung nicht verfügbar");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS address_validation_records (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER,
      order_id VARCHAR(32),
      context VARCHAR(32) NOT NULL,
      country_code VARCHAR(8) NOT NULL,
      submitted_address_json TEXT NOT NULL,
      provider_key VARCHAR(80),
      provider_checked_at TIMESTAMP,
      validation_status VARCHAR(32) NOT NULL,
      warnings_json TEXT NOT NULL DEFAULT '[]',
      details_json TEXT NOT NULL DEFAULT '{}',
      override_confirmed INTEGER NOT NULL DEFAULT 0,
      override_confirmed_at TIMESTAMP,
      override_confirmed_by VARCHAR(100),
      evidence_svg TEXT,
      evidence_sha256 VARCHAR(128),
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS address_validation_records_customer_idx
      ON address_validation_records (customer_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS address_validation_records_order_idx
      ON address_validation_records (order_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS address_validation_records_status_idx
      ON address_validation_records (validation_status, created_at DESC);

    INSERT INTO shop_settings (key, value) VALUES
      ('address_validation_enabled', 'true'),
      ('address_validation_country_codes', 'DE'),
      ('address_validation_provider_key', 'openplz'),
      ('address_validation_provider_base_url', 'https://openplzapi.org/de'),
      ('address_validation_timeout_ms', '3500'),
      ('address_validation_house_number_pattern', '^[0-9]{1,5}[a-zA-Z]?(?:\\s*[-/]\\s*[0-9]{1,5}[a-zA-Z]?)?$'),
      ('address_validation_house_number_mode', 'format_only')
    ON CONFLICT (key) DO NOTHING;
  `);

  console.log("[AddressValidation] Schema und konfigurierbare Prüfparameter bereit");
}
