-- Partner System Extension: commissionType, acquiredBy, partner login
-- Migration 0005

-- Create new enum types
DO $$ BEGIN
  CREATE TYPE "commission_type" AS ENUM('einmalig', 'dauerhaft');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "acquired_by" AS ENUM('shop', 'partner', 'direkt');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- Add commission_type and login fields to partners
ALTER TABLE "partners" ADD COLUMN IF NOT EXISTS "commission_type" "commission_type" DEFAULT 'dauerhaft' NOT NULL;--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN IF NOT EXISTS "password_hash" text;--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN IF NOT EXISTS "last_login" timestamp;--> statement-breakpoint

-- Add acquisition tracking to customers
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "acquired_by" "acquired_by" DEFAULT 'shop' NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "acquired_by_partner_id" integer;
