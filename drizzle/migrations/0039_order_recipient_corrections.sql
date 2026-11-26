-- Recipient-only audit. Historical orders/contacts/financial snapshots are not rewritten implicitly.
-- No FK to order/customer: the immutable correction evidence survives authorized cleanup.
CREATE TABLE IF NOT EXISTS order_recipient_corrections (
  id VARCHAR(64) PRIMARY KEY,
  order_id VARCHAR(50) NOT NULL,
  customer_id INTEGER NOT NULL,
  actor_id INTEGER,
  actor_name VARCHAR(200) NOT NULL,
  before_snapshot JSONB NOT NULL,
  after_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS order_recipient_corrections_order_created_idx
  ON order_recipient_corrections(order_id, created_at);
