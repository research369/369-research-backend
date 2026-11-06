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
