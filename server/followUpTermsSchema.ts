import { getPool } from "./db.js";

/**
 * Additive persistence for individually configurable Follow-up offer terms.
 * Existing, not-yet-sent follow-ups retain the previous 10 % / 48 h behavior.
 */
export async function ensureFollowUpTermsSchema(): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Database not available");

  await pool.query(`
    ALTER TABLE sales_followups
      ADD COLUMN IF NOT EXISTS discount_percent NUMERIC(5, 2),
      ADD COLUMN IF NOT EXISTS code_validity_hours INTEGER;

    UPDATE sales_followups
       SET discount_percent = 10.00
     WHERE discount_percent IS NULL;

    UPDATE sales_followups
       SET code_validity_hours = 48
     WHERE code_validity_hours IS NULL;

    ALTER TABLE sales_followups
      ALTER COLUMN discount_percent SET DEFAULT 10.00,
      ALTER COLUMN discount_percent SET NOT NULL,
      ALTER COLUMN code_validity_hours SET DEFAULT 48,
      ALTER COLUMN code_validity_hours SET NOT NULL;

    ALTER TABLE promo_codes
      ADD COLUMN IF NOT EXISTS valid_until_exact INTEGER NOT NULL DEFAULT 0;
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'sales_followups_discount_percent_range_chk'
      ) THEN
        ALTER TABLE sales_followups
          ADD CONSTRAINT sales_followups_discount_percent_range_chk
          CHECK (discount_percent >= 0 AND discount_percent <= 100);
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'sales_followups_code_validity_hours_range_chk'
      ) THEN
        ALTER TABLE sales_followups
          ADD CONSTRAINT sales_followups_code_validity_hours_range_chk
          CHECK (code_validity_hours >= 1 AND code_validity_hours <= 8760);
      END IF;
    END $$;
  `);
}
