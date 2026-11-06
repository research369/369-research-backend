-- Additive only. No historical owners, prices, balances or ledger values are changed.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS kwk_credit_owner_id INTEGER;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_kwk_credit_owner_id_fkey') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_kwk_credit_owner_id_fkey FOREIGN KEY(kwk_credit_owner_id) REFERENCES kwk_accounts(id) ON DELETE RESTRICT;
  END IF;
END $$;
-- Global, lifetime uniqueness. Existing duplicates require explicit review, never automatic repair.
CREATE UNIQUE INDEX IF NOT EXISTS kwk_ledger_one_redemption_per_order_idx ON kwk_ledger(order_id) WHERE type='redeemed' AND order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS kwk_ledger_one_cancellation_per_owner_order_idx ON kwk_ledger(kwk_id,order_id) WHERE type='cancelled' AND status='confirmed' AND order_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS partner_historical_claims (
  request_id UUID PRIMARY KEY,
  partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
  order_id VARCHAR(50) NOT NULL UNIQUE,
  transaction_id INTEGER NOT NULL UNIQUE REFERENCES partner_transactions(id) ON DELETE RESTRICT,
  payload_hash VARCHAR(64) NOT NULL,
  amount NUMERIC(10,2) NOT NULL CHECK(amount > 0),
  balance_before NUMERIC(10,2) NOT NULL,
  balance_after NUMERIC(10,2) NOT NULL,
  percent INTEGER NOT NULL CHECK(percent=10),
  mode VARCHAR(40) NOT NULL CHECK(mode IN ('evidenced_ten_percent','stored_order_amount')),
  reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
  evidence_reference TEXT NOT NULL CHECK(length(trim(evidence_reference)) > 0),
  admin_user VARCHAR(100) NOT NULL,
  provenance_json JSONB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE OR REPLACE FUNCTION protect_partner_historical_claims() RETURNS trigger AS $$ BEGIN
  RAISE EXCEPTION 'partner_historical_claims_are_immutable';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS partner_historical_claims_immutable ON partner_historical_claims;
CREATE TRIGGER partner_historical_claims_immutable BEFORE UPDATE OR DELETE ON partner_historical_claims FOR EACH ROW EXECUTE FUNCTION protect_partner_historical_claims();
