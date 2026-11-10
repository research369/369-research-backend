-- Additive DHL shipment ledger. Startup executes this same idempotent SQL.
-- Existing orders are archived lazily under the per-order lock, never mass rewritten.
-- Plain order IDs deliberately preserve the immutable ledger after authorized order deletion.
CREATE TABLE IF NOT EXISTS dhl_label_generations (
  id UUID PRIMARY KEY,
  order_id VARCHAR(32) NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  state VARCHAR(32) NOT NULL CHECK (state IN ('active','cancel_pending','cancel_unknown','cancel_rejected','manifested','delivered','cancelled','create_pending','create_unknown','create_rejected','documents_failed')),
  tracking_number VARCHAR(100),
  shipping_profile VARCHAR(32),
  recipient_snapshot JSONB NOT NULL,
  request_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  order_snapshot JSONB NOT NULL,
  label_content TEXT,
  original_label_content TEXT,
  customs_document_content TEXT,
  commercial_invoice_content TEXT,
  customs_print_content TEXT,
  prior_label_url TEXT,
  reason TEXT NOT NULL,
  actor VARCHAR(200) NOT NULL,
  cancellation_source VARCHAR(32) CHECK (cancellation_source IN ('dhl','admin_attestation')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (order_id, generation)
);
CREATE TABLE IF NOT EXISTS dhl_label_operations (
  id UUID PRIMARY KEY,
  order_id VARCHAR(32) NOT NULL,
  generation_id UUID NOT NULL REFERENCES dhl_label_generations(id) ON DELETE RESTRICT,
  idempotency_key VARCHAR(128) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('create','cancel','attest','replace')),
  state VARCHAR(16) NOT NULL CHECK (state IN ('pending','succeeded','rejected','unknown')),
  actor VARCHAR(200) NOT NULL,
  reason TEXT NOT NULL,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  UNIQUE (order_id, idempotency_key)
);
-- Durable guard is never time-expired, including unknown HTTP outcomes and crashes.
CREATE UNIQUE INDEX IF NOT EXISTS dhl_label_one_unresolved_operation
  ON dhl_label_operations(order_id) WHERE state IN ('pending','unknown');
CREATE INDEX IF NOT EXISTS dhl_label_generations_order_idx
  ON dhl_label_generations(order_id, generation DESC);
