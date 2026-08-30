-- ============================================================
-- PEPS4PETS: externe Kundenreferenz und Checkout-Idempotenz
-- Datum: 2026-08-30 | Rein additiv, bestehende 369-Aufträge unverändert
-- Die kanonische order_id bleibt der zentrale Schlüssel für Rechnung, DHL
-- und interne Prozesse. P4P-Referenzen sind eine zusätzliche Kundensicht.
-- ============================================================

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "store_key" varchar(32) NOT NULL DEFAULT '369research';
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "external_order_reference" varchar(32);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "checkout_idempotency_key" varchar(128);

CREATE UNIQUE INDEX IF NOT EXISTS "orders_external_order_reference_unique"
  ON "orders" ("external_order_reference")
  WHERE "external_order_reference" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "orders_checkout_idempotency_key_unique"
  ON "orders" ("checkout_idempotency_key")
  WHERE "checkout_idempotency_key" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "orders_store_key_idx" ON "orders" ("store_key");

CREATE SEQUENCE IF NOT EXISTS "peps4pets_order_reference_seq" START WITH 1101;
