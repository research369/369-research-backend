-- Additive only. No order/stock/ledger backfill. Audit survives permitted hard deletion.
CREATE TABLE IF NOT EXISTS priority_checkout_receipts (
  intent_key varchar(128) PRIMARY KEY,
  payload_fingerprint varchar(64) NOT NULL CHECK (payload_fingerprint ~ '^[a-f0-9]{64}$'),
  order_id varchar(32) NOT NULL UNIQUE,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS priority_order_tasks (
  order_id varchar(32) NOT NULL,
  task varchar(48) NOT NULL,
  state varchar(24) NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','done','repair_required','unknown')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, task)
);
CREATE TABLE IF NOT EXISTS priority_stock_returns (
  original_movement_id integer PRIMARY KEY REFERENCES stock_history(id),
  return_movement_id integer NOT NULL UNIQUE REFERENCES stock_history(id),
  order_id varchar(32) NOT NULL,
  reason text NOT NULL,
  actor varchar(100) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS priority_order_actions (
  order_id varchar(32) NOT NULL,
  action varchar(32) NOT NULL,
  reason text NOT NULL,
  actor varchar(100) NOT NULL,
  stock_units integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, action)
);
CREATE INDEX IF NOT EXISTS priority_order_tasks_review_idx ON priority_order_tasks(state, updated_at);
CREATE INDEX IF NOT EXISTS priority_stock_returns_order_idx ON priority_stock_returns(order_id);
CREATE INDEX IF NOT EXISTS priority_stock_history_order_idx ON stock_history(order_id, article_id, id);
