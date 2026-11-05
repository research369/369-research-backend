-- Additive Creator-program infrastructure.
-- Production initializes this idempotently through server/partnerProgramSchema.ts.
-- Existing orders and transactions are intentionally not rewritten.

CREATE TABLE IF NOT EXISTS partner_programs (
  key VARCHAR(32) PRIMARY KEY,
  label VARCHAR(80) NOT NULL,
  customer_discount_policy VARCHAR(40) NOT NULL,
  commission_policy VARCHAR(40) NOT NULL,
  settlement_method VARCHAR(24) NOT NULL,
  allow_self_order_credit BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO partner_programs (
  key, label, customer_discount_policy, commission_policy,
  settlement_method, allow_self_order_credit, active
) VALUES
  ('creator', 'Creator', 'each_valid_code_use', 'each_paid_code_order', 'payout', FALSE, TRUE),
  ('partner', 'Partner', 'first_paid_code_use', 'first_paid_code_order', 'shop_credit', TRUE, TRUE),
  ('self_user', 'Eigennutzer', 'own_email_only', 'none', 'shop_credit', TRUE, TRUE)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE partners ADD COLUMN IF NOT EXISTS program_key VARCHAR(32);
UPDATE partners
SET program_key = CASE
  WHEN COALESCE(notes, '') LIKE '%[EIGENNUTZER]%' THEN 'self_user'
  WHEN commission_type = 'einmalig' THEN 'creator'
  ELSE 'partner'
END
WHERE program_key IS NULL;

CREATE TABLE IF NOT EXISTS partner_codes (
  id SERIAL PRIMARY KEY,
  partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
  display_code VARCHAR(50) NOT NULL,
  code_normalized VARCHAR(50) NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS partner_source_id INTEGER;
CREATE INDEX IF NOT EXISTS orders_partner_source_id_idx ON orders(partner_source_id, order_date);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS partner_program_snapshot VARCHAR(32);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS partner_settlement_method_snapshot VARCHAR(24);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS partner_commission_policy_snapshot VARCHAR(40);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS partner_customer_discount_policy_snapshot VARCHAR(40);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS partner_commission_percent_snapshot NUMERIC(6,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS partner_customer_discount_percent_snapshot NUMERIC(6,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS partner_commission_base_snapshot NUMERIC(10,2);

CREATE UNIQUE INDEX IF NOT EXISTS partner_transactions_one_normal_provision_per_order_idx
  ON partner_transactions (partner_id, order_id)
  WHERE type = 'provision' AND status = 'normal' AND order_id IS NOT NULL;
