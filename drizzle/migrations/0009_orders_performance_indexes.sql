-- Migration: Performance indexes for orders table
-- Adds indexes on status, order_date, customer_id, email for faster queries

CREATE INDEX IF NOT EXISTS "orders_status_idx" ON "orders" USING btree ("status");
CREATE INDEX IF NOT EXISTS "orders_order_date_idx" ON "orders" USING btree ("order_date");
CREATE INDEX IF NOT EXISTS "orders_customer_id_idx" ON "orders" USING btree ("customer_id");
CREATE INDEX IF NOT EXISTS "orders_email_idx" ON "orders" USING btree ("email");
