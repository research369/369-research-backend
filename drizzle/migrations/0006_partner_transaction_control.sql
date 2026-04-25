-- Migration 0006: Partner Transaction Control
-- Adds transaction status for admin control (storno, nicht werten, ausblenden)
-- Adds "auszahlung" transaction type for monetary payouts (einmalig model)

-- 1. Create transaction_status enum
DO $$ BEGIN
  CREATE TYPE "transaction_status" AS ENUM ('normal', 'storniert', 'nicht_gewertet', 'ausgeblendet');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Add "auszahlung" to partner_transaction_type enum
ALTER TYPE "partner_transaction_type" ADD VALUE IF NOT EXISTS 'auszahlung';

-- 3. Add status column to partner_transactions (default 'normal')
ALTER TABLE "partner_transactions" ADD COLUMN IF NOT EXISTS "status" "transaction_status" DEFAULT 'normal' NOT NULL;

-- 4. Add admin_note column for documenting why a transaction was modified
ALTER TABLE "partner_transactions" ADD COLUMN IF NOT EXISTS "admin_note" text;
