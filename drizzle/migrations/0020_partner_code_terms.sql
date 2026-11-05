-- Individual public-code commercial terms.
-- Existing public codes inherit the partner-wide legacy values exactly once.
-- Historical orders, transactions and balances are intentionally never changed.

ALTER TABLE partner_codes
  ADD COLUMN IF NOT EXISTS commission_percent NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS customer_discount_percent NUMERIC(6,2);

UPDATE partner_codes pc
   SET commission_percent = p.commission_percent,
       customer_discount_percent = p.customer_discount_percent
  FROM partners p
 WHERE p.id = pc.partner_id
   AND (pc.commission_percent IS NULL OR pc.customer_discount_percent IS NULL);

ALTER TABLE partner_codes
  ALTER COLUMN commission_percent SET NOT NULL,
  ALTER COLUMN customer_discount_percent SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'partner_codes_commission_percent_chk'
  ) THEN
    ALTER TABLE partner_codes
      ADD CONSTRAINT partner_codes_commission_percent_chk
      CHECK (commission_percent >= 0 AND commission_percent <= 100);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'partner_codes_customer_discount_percent_chk'
  ) THEN
    ALTER TABLE partner_codes
      ADD CONSTRAINT partner_codes_customer_discount_percent_chk
      CHECK (customer_discount_percent >= 0 AND customer_discount_percent <= 100);
  END IF;
END $$;

-- New orders point to the exact code row while keeping their existing textual
-- code and financial snapshots for readable, independent audit evidence.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS partner_code_id_snapshot INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_partner_code_id_snapshot_fkey'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_partner_code_id_snapshot_fkey
      FOREIGN KEY (partner_code_id_snapshot)
      REFERENCES partner_codes(id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS orders_partner_source_code_snapshot_idx
  ON orders(partner_source_id, partner_code_id_snapshot, order_date);
