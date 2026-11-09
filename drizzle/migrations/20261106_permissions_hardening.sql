-- Additive permission hardening. No historical assignment, stats or profile rewrites.
ALTER TABLE customer_communications ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE customer_communications
  ADD COLUMN IF NOT EXISTS customer_link_review INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS customer_communications_unlinked_review_idx
  ON customer_communications (created_at DESC) WHERE customer_link_review = 1;
CREATE TABLE IF NOT EXISTS order_customer_assignment_events (
  id BIGSERIAL PRIMARY KEY,
  order_id VARCHAR(32) NOT NULL,
  previous_customer_id INTEGER,
  customer_id INTEGER NOT NULL,
  actor_id INTEGER NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS order_customer_assignment_events_order_idx
  ON order_customer_assignment_events(order_id, created_at DESC);

-- Permanent, explicitly authorized operations for ONE account; no role expansion.
-- Retain revocations and grant audit reason on every startup/migration replay.
CREATE TABLE IF NOT EXISTS operations_account_capability_grants (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  username VARCHAR(100) NOT NULL,
  required_role VARCHAR(40) NOT NULL CHECK (required_role = 'product_manager'),
  capability VARCHAR(40) NOT NULL CHECK (capability IN ('operations_read','partner_credit_adjust','order_cleanup')),
  grant_reason TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, capability)
);
INSERT INTO operations_account_capability_grants (user_id, username, required_role, capability, grant_reason)
SELECT account.id, account.username, account.role::text, capability,
       '2026-11-09 Userauthorize: Pakko explicitly authorized existing account id=2 username=product_manager for partner credit corrections and customer order cleanup; no payments/refunds/payouts/users rights'
FROM users AS account
CROSS JOIN (VALUES ('operations_read'), ('partner_credit_adjust'), ('order_cleanup')) AS authorized(capability)
WHERE account.id = 2 AND account.username = 'product_manager' AND account.role::text = 'product_manager'
ON CONFLICT DO NOTHING;
