-- Migration: Batch Tracking System
-- Adds purchase_orders, purchase_order_items, batches, order_item_batches tables

-- Enum for purchase order status
DO $$ BEGIN
  CREATE TYPE "purchase_order_status" AS ENUM (
    'bestellt',
    'versendet',
    'teilweise_eingetroffen',
    'vollständig',
    'abgeschlossen'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Purchase Orders (Wareneingänge)
CREATE TABLE IF NOT EXISTS "purchase_orders" (
  "id" serial PRIMARY KEY NOT NULL,
  "po_number" varchar(50) NOT NULL UNIQUE,
  "supplier_name" varchar(200) NOT NULL,
  "order_date" timestamp NOT NULL,
  "shipping_date" timestamp,
  "received_date" timestamp,
  "tracking_number" varchar(100),
  "status" "purchase_order_status" NOT NULL DEFAULT 'bestellt',
  "shipping_cost_usd" decimal(10,2),
  "total_usd" decimal(10,2),
  "usd_to_eur_rate" decimal(8,4),
  "notes" text,
  "screenshot_ref" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

-- Purchase Order Items (Positionen)
CREATE TABLE IF NOT EXISTS "purchase_order_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "purchase_order_id" integer NOT NULL,
  "article_id" integer,
  "sku" varchar(50),
  "name" varchar(200) NOT NULL,
  "dosage" varchar(50),
  "supplier_code" varchar(100),
  "ordered_qty" integer NOT NULL DEFAULT 0,
  "received_qty" integer NOT NULL DEFAULT 0,
  "pack_quantity" integer,
  "pack_size" integer,
  "purchase_price_eur" decimal(10,4),
  "price_usd" decimal(10,2),
  "shipping_markup" decimal(5,4),
  "usd_to_eur_rate" decimal(8,4),
  "selling_price" decimal(10,2),
  "batch_number" varchar(100),
  "received_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

-- Batches (available batches per article)
CREATE TABLE IF NOT EXISTS "batches" (
  "id" serial PRIMARY KEY NOT NULL,
  "batch_number" varchar(100) NOT NULL,
  "article_id" integer NOT NULL,
  "article_name" varchar(200) NOT NULL,
  "purchase_order_id" integer,
  "purchase_order_item_id" integer,
  "supplier_name" varchar(200),
  "quantity" integer NOT NULL DEFAULT 0,
  "remaining_qty" integer NOT NULL DEFAULT 0,
  "received_date" timestamp,
  "notes" text,
  "is_active" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

-- Order Item Batches (INTERNAL ONLY – which batch was used per order item)
CREATE TABLE IF NOT EXISTS "order_item_batches" (
  "id" serial PRIMARY KEY NOT NULL,
  "order_id" varchar(32) NOT NULL,
  "order_item_id" integer,
  "article_id" integer,
  "article_name" varchar(200) NOT NULL,
  "batch_id" integer,
  "batch_number" varchar(100) NOT NULL,
  "quantity" integer NOT NULL DEFAULT 1,
  "assigned_by" varchar(100),
  "assigned_at" timestamp DEFAULT now() NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS "idx_po_items_po_id" ON "purchase_order_items" ("purchase_order_id");
CREATE INDEX IF NOT EXISTS "idx_batches_article_id" ON "batches" ("article_id");
CREATE INDEX IF NOT EXISTS "idx_batches_batch_number" ON "batches" ("batch_number");
CREATE INDEX IF NOT EXISTS "idx_order_item_batches_order_id" ON "order_item_batches" ("order_id");
CREATE INDEX IF NOT EXISTS "idx_order_item_batches_article_id" ON "order_item_batches" ("article_id");
