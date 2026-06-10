CREATE TYPE "public"."acquired_by" AS ENUM('shop', 'partner', 'direkt');--> statement-breakpoint
CREATE TYPE "public"."commission_type" AS ENUM('einmalig', 'dauerhaft');--> statement-breakpoint
CREATE TYPE "public"."follow_up_status" AS ENUM('pending', 'done', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."purchase_order_status" AS ENUM('bestellt', 'versendet', 'teilweise_eingetroffen', 'vollständig', 'abgeschlossen');--> statement-breakpoint
CREATE TYPE "public"."transaction_status" AS ENUM('normal', 'storniert', 'nicht_gewertet', 'ausgeblendet');--> statement-breakpoint
ALTER TYPE "public"."partner_transaction_type" ADD VALUE 'auszahlung';--> statement-breakpoint
CREATE TABLE "batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"batch_number" varchar(100) NOT NULL,
	"article_id" integer NOT NULL,
	"article_name" varchar(200) NOT NULL,
	"purchase_order_id" integer,
	"purchase_order_item_id" integer,
	"supplier_name" varchar(200),
	"quantity" integer DEFAULT 0 NOT NULL,
	"remaining_qty" integer DEFAULT 0 NOT NULL,
	"received_date" timestamp,
	"notes" text,
	"is_active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_number" varchar(50) NOT NULL,
	"order_number" varchar(32) NOT NULL,
	"date" varchar(10) NOT NULL,
	"date_iso" varchar(10) NOT NULL,
	"total_gross" numeric(10, 2) NOT NULL,
	"html" text NOT NULL,
	"items" text DEFAULT '[]' NOT NULL,
	"split_index" integer,
	"split_total" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_invoice_number_unique" UNIQUE("invoice_number")
);
--> statement-breakpoint
CREATE TABLE "order_item_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" varchar(32) NOT NULL,
	"order_item_id" integer,
	"article_id" integer,
	"article_name" varchar(200) NOT NULL,
	"batch_id" integer,
	"batch_number" varchar(100) NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"assigned_by" varchar(100),
	"assigned_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_order_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"purchase_order_id" integer NOT NULL,
	"article_id" integer,
	"sku" varchar(50),
	"name" varchar(200) NOT NULL,
	"dosage" varchar(50),
	"supplier_code" varchar(100),
	"ordered_qty" integer DEFAULT 0 NOT NULL,
	"received_qty" integer DEFAULT 0 NOT NULL,
	"pack_quantity" integer,
	"pack_size" integer,
	"purchase_price_eur" numeric(10, 4),
	"price_usd" numeric(10, 2),
	"shipping_markup" numeric(5, 4),
	"usd_to_eur_rate" numeric(8, 4),
	"selling_price" numeric(10, 2),
	"batch_number" varchar(100),
	"received_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"po_number" varchar(50) NOT NULL,
	"supplier_name" varchar(200) NOT NULL,
	"order_date" timestamp NOT NULL,
	"shipping_date" timestamp,
	"received_date" timestamp,
	"tracking_number" varchar(100),
	"status" "purchase_order_status" DEFAULT 'bestellt' NOT NULL,
	"shipping_cost_usd" numeric(10, 2),
	"total_usd" numeric(10, 2),
	"usd_to_eur_rate" numeric(8, 4),
	"notes" text,
	"screenshot_ref" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_orders_po_number_unique" UNIQUE("po_number")
);
--> statement-breakpoint
CREATE TABLE "sales_followup_products" (
	"id" serial PRIMARY KEY NOT NULL,
	"followup_id" integer NOT NULL,
	"article_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_followups" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" varchar(32) NOT NULL,
	"status" "follow_up_status" DEFAULT 'pending' NOT NULL,
	"due_at" timestamp NOT NULL,
	"completed_at" timestamp,
	"skipped_at" timestamp,
	"completed_by" varchar(100),
	"whatsapp_message" text,
	"email_subject" varchar(300),
	"email_body" text,
	"email_sent_at" timestamp,
	"email_sent_to" varchar(320),
	"promo_code_id" integer,
	"discount_code" varchar(50),
	"code_created_at" timestamp,
	"code_expires_at" timestamp,
	"message_generated_at" timestamp,
	"whatsapp_opened_at" timestamp,
	"reminder_stage" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sales_followups_order_id_unique" UNIQUE("order_id")
);
--> statement-breakpoint
ALTER TABLE "customers" ALTER COLUMN "first_name" SET DATA TYPE varchar(200);--> statement-breakpoint
ALTER TABLE "customers" ALTER COLUMN "last_name" SET DATA TYPE varchar(200);--> statement-breakpoint
ALTER TABLE "customers" ALTER COLUMN "street" SET DATA TYPE varchar(300);--> statement-breakpoint
ALTER TABLE "customers" ALTER COLUMN "house_number" SET DATA TYPE varchar(100);--> statement-breakpoint
ALTER TABLE "customers" ALTER COLUMN "zip" SET DATA TYPE varchar(30);--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "first_name" SET DATA TYPE varchar(200);--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "last_name" SET DATA TYPE varchar(200);--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "street" SET DATA TYPE varchar(300);--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "house_number" SET DATA TYPE varchar(100);--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "zip" SET DATA TYPE varchar(30);--> statement-breakpoint
ALTER TABLE "partners" ALTER COLUMN "street" SET DATA TYPE varchar(300);--> statement-breakpoint
ALTER TABLE "partners" ALTER COLUMN "house_number" SET DATA TYPE varchar(100);--> statement-breakpoint
ALTER TABLE "partners" ALTER COLUMN "zip" SET DATA TYPE varchar(30);--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "description" jsonb;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "shop_visible" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "mockup_image_url" text;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "label_image_url" text;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "cas_number" varchar(50);--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "molecular_weight" varchar(50);--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "purity" varchar(20);--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "badge" text;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "sale_price" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "sale_price_label" varchar(100);--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "lab_report_image_url" text;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "gallery_images" jsonb;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "categories" jsonb;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "variants" jsonb;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "short_description" text;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "beauty_data" jsonb;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "photo_coming_soon" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "follow_up_category" varchar(50);--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "acquired_by" "acquired_by" DEFAULT 'shop' NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "acquired_by_partner_id" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shipping_label_content" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "weight_grams" integer;--> statement-breakpoint
ALTER TABLE "partner_transactions" ADD COLUMN "status" "transaction_status" DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "partner_transactions" ADD COLUMN "admin_note" text;--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN "commission_type" "commission_type" DEFAULT 'dauerhaft' NOT NULL;--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN "last_login" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_secret" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_enabled" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "orders_order_date_idx" ON "orders" USING btree ("order_date");--> statement-breakpoint
CREATE INDEX "orders_customer_id_idx" ON "orders" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "orders_email_idx" ON "orders" USING btree ("email");