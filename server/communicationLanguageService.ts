import { getPool } from "./db.js";

/** Only these two languages are supported for automatic customer communication. */
export const COMMUNICATION_LANGUAGES = ["de", "en"] as const;
export type CommunicationLanguage = typeof COMMUNICATION_LANGUAGES[number];

export function normalizeCommunicationLanguage(value: unknown): CommunicationLanguage {
  return value === "en" ? "en" : "de";
}

/**
 * Additive, idempotent persistence for the explicit communication preference.
 * Historic records retain German as their safe default; each new order carries
 * an immutable snapshot while the customer profile retains the current choice.
 */
export async function ensureCommunicationLanguageSchema(): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Datenbankverbindung für Kommunikationssprache nicht verfügbar");

  await pool.query(`
    ALTER TABLE customers
      ADD COLUMN IF NOT EXISTS communication_language VARCHAR(2) NOT NULL DEFAULT 'de';
    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS communication_language VARCHAR(2) NOT NULL DEFAULT 'de';

    UPDATE customers
      SET communication_language = 'de'
      WHERE communication_language IS NULL OR communication_language NOT IN ('de', 'en');
    UPDATE orders
      SET communication_language = 'de'
      WHERE communication_language IS NULL OR communication_language NOT IN ('de', 'en');

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'customers_communication_language_check'
      ) THEN
        ALTER TABLE customers
          ADD CONSTRAINT customers_communication_language_check
          CHECK (communication_language IN ('de', 'en'));
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'orders_communication_language_check'
      ) THEN
        ALTER TABLE orders
          ADD CONSTRAINT orders_communication_language_check
          CHECK (communication_language IN ('de', 'en'));
      END IF;
    END $$;
  `);
}
