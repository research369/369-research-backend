-- Store the exact product copy used for each follow-up selection.
-- A later catalogue edit must never alter a preview or a customer-facing follow-up.
ALTER TABLE sales_followup_products
  ADD COLUMN IF NOT EXISTS generated_copy TEXT,
  ADD COLUMN IF NOT EXISTS generated_copy_source VARCHAR(20),
  ADD COLUMN IF NOT EXISTS generated_copy_generated_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_sales_followup_products_generated_copy
  ON sales_followup_products (followup_id)
  WHERE generated_copy IS NOT NULL;
