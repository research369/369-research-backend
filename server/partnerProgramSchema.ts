import { getPool } from "./db.js";

/**
 * Additive, idempotent schema for program-based partner attribution.
 * Existing transactions remain unchanged. New orders persist a complete program
 * snapshot so later changes to a Creator/Partner configuration are never
 * applied retroactively.
 */
export async function ensurePartnerProgramSchema(): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Database not available");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS partner_programs (
      key VARCHAR(32) PRIMARY KEY,
      label VARCHAR(80) NOT NULL,
      customer_discount_policy VARCHAR(40) NOT NULL,
      commission_policy VARCHAR(40) NOT NULL,
      settlement_method VARCHAR(24) NOT NULL,
      allow_self_order_credit BOOLEAN NOT NULL DEFAULT FALSE,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT partner_programs_customer_discount_policy_chk
        CHECK (customer_discount_policy IN ('each_valid_code_use', 'first_paid_code_use', 'own_email_only')),
      CONSTRAINT partner_programs_commission_policy_chk
        CHECK (commission_policy IN ('each_paid_code_order', 'first_paid_code_order', 'none')),
      CONSTRAINT partner_programs_settlement_method_chk
        CHECK (settlement_method IN ('payout', 'shop_credit', 'none'))
    )
  `);

  await pool.query(`
    INSERT INTO partner_programs (
      key, label, customer_discount_policy, commission_policy,
      settlement_method, allow_self_order_credit, active
    ) VALUES
      ('creator', 'Creator', 'each_valid_code_use', 'each_paid_code_order', 'payout', FALSE, TRUE),
      ('partner', 'Partner', 'first_paid_code_use', 'first_paid_code_order', 'shop_credit', TRUE, TRUE),
      ('self_user', 'Eigennutzer', 'own_email_only', 'none', 'shop_credit', TRUE, TRUE)
    ON CONFLICT (key) DO NOTHING
  `);

  await pool.query(`ALTER TABLE partners ADD COLUMN IF NOT EXISTS program_key VARCHAR(32)`);
  await pool.query(`UPDATE partners SET program_key = CASE
    WHEN COALESCE(notes, '') LIKE '%[EIGENNUTZER]%' THEN 'self_user'
    WHEN commission_type = 'einmalig' THEN 'creator'
    ELSE 'partner'
  END WHERE program_key IS NULL`);
  await pool.query(`ALTER TABLE partners ALTER COLUMN program_key SET DEFAULT 'partner'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS partners_program_key_idx ON partners(program_key)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS partner_codes (
      id SERIAL PRIMARY KEY,
      partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
      display_code VARCHAR(50) NOT NULL,
      code_normalized VARCHAR(50) NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT partner_codes_normalized_unique UNIQUE (code_normalized)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS partner_codes_partner_id_idx ON partner_codes(partner_id)`);
  // Add nullable columns before importing legacy CSV rows. This ordering keeps
  // subsequent restarts safe after the columns have become NOT NULL below.
  await pool.query(`ALTER TABLE partner_codes ADD COLUMN IF NOT EXISTS commission_percent NUMERIC(6,2)`);
  await pool.query(`ALTER TABLE partner_codes ADD COLUMN IF NOT EXISTS customer_discount_percent NUMERIC(6,2)`);
  await pool.query(`
    INSERT INTO partner_codes (
      partner_id, display_code, code_normalized,
      commission_percent, customer_discount_percent, is_active
    )
    SELECT p.id, TRIM(code_part), UPPER(TRIM(code_part)),
           p.commission_percent, p.customer_discount_percent, TRUE
      FROM partners p
      CROSS JOIN LATERAL regexp_split_to_table(COALESCE(p.code, ''), '\s*,\s*') AS code_part
     WHERE TRIM(code_part) <> ''
    ON CONFLICT (code_normalized) DO NOTHING
  `);
  // Every public code owns its commercial terms. Existing rows inherit their
  // historical partner defaults once; later changes are made per code only.
  await pool.query(`
    UPDATE partner_codes pc
       SET commission_percent = p.commission_percent,
           customer_discount_percent = p.customer_discount_percent
      FROM partners p
     WHERE p.id = pc.partner_id
       AND (pc.commission_percent IS NULL OR pc.customer_discount_percent IS NULL)
  `);
  await pool.query(`ALTER TABLE partner_codes ALTER COLUMN commission_percent SET NOT NULL`);
  await pool.query(`ALTER TABLE partner_codes ALTER COLUMN customer_discount_percent SET NOT NULL`);
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partner_codes_commission_percent_chk') THEN
        ALTER TABLE partner_codes ADD CONSTRAINT partner_codes_commission_percent_chk
          CHECK (commission_percent >= 0 AND commission_percent <= 100);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partner_codes_customer_discount_percent_chk') THEN
        ALTER TABLE partner_codes ADD CONSTRAINT partner_codes_customer_discount_percent_chk
          CHECK (customer_discount_percent >= 0 AND customer_discount_percent <= 100);
      END IF;
    END $$
  `);

  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS partner_source_id INTEGER`);
  await pool.query(`CREATE INDEX IF NOT EXISTS orders_partner_source_id_idx ON orders(partner_source_id, order_date)`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS partner_code_id_snapshot INTEGER`);
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_partner_code_id_snapshot_fkey') THEN
        ALTER TABLE orders ADD CONSTRAINT orders_partner_code_id_snapshot_fkey
          FOREIGN KEY (partner_code_id_snapshot) REFERENCES partner_codes(id) ON DELETE RESTRICT;
      END IF;
    END $$
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS orders_partner_source_code_snapshot_idx ON orders(partner_source_id, partner_code_id_snapshot, order_date)`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS partner_program_snapshot VARCHAR(32)`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS partner_settlement_method_snapshot VARCHAR(24)`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS partner_commission_policy_snapshot VARCHAR(40)`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS partner_customer_discount_policy_snapshot VARCHAR(40)`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS partner_commission_percent_snapshot NUMERIC(6,2)`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS partner_customer_discount_percent_snapshot NUMERIC(6,2)`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS partner_commission_base_snapshot NUMERIC(10,2)`);

  // Verified before this migration: no duplicate normal provision rows exist.
  // The unique partial index turns that operational rule into a database invariant.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS partner_transactions_one_normal_provision_per_order_idx
      ON partner_transactions (partner_id, order_id)
      WHERE type = 'provision' AND status = 'normal' AND order_id IS NOT NULL
  `);
}
