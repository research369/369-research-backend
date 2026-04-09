CREATE TYPE "public"."order_status" AS ENUM('offen', 'bezahlt', 'gepackt', 'versendet', 'zugestellt', 'storniert');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('bunq', 'creditCard', 'wise');--> statement-breakpoint
CREATE TYPE "public"."stock_change_type" AS ENUM('wareneingang', 'verkauf', 'korrektur', 'retoure', 'bestellung');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TABLE "articles" (
	"id" serial PRIMARY KEY NOT NULL,
	"sku" varchar(50) NOT NULL,
	"name" varchar(200) NOT NULL,
	"category" varchar(100),
	"purchase_price" numeric(10, 2) DEFAULT '0',
	"selling_price" numeric(10, 2) DEFAULT '0',
	"tax_rate" numeric(5, 2) DEFAULT '19',
	"stock" integer DEFAULT 0 NOT NULL,
	"min_stock" integer DEFAULT 5 NOT NULL,
	"max_stock" integer DEFAULT 100,
	"shop_product_id" varchar(100),
	"notes" text,
	"is_active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "articles_sku_unique" UNIQUE("sku")
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"phone" varchar(50),
	"email" varchar(320),
	"company" varchar(200),
	"street" varchar(200),
	"zip" varchar(20),
	"city" varchar(100),
	"country" varchar(100),
	"notes" text,
	"total_orders" integer DEFAULT 0 NOT NULL,
	"total_spent" numeric(10, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" varchar(32) NOT NULL,
	"name" varchar(200) NOT NULL,
	"dosage" varchar(50),
	"variant" varchar(100),
	"type" varchar(50) NOT NULL,
	"price" numeric(10, 2) NOT NULL,
	"quantity" integer NOT NULL,
	"article_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" varchar(32) NOT NULL,
	"first_name" varchar(100) NOT NULL,
	"last_name" varchar(100) NOT NULL,
	"email" varchar(320) NOT NULL,
	"phone" varchar(50) NOT NULL,
	"street" varchar(200) NOT NULL,
	"house_number" varchar(20) NOT NULL,
	"zip" varchar(20) NOT NULL,
	"city" varchar(100) NOT NULL,
	"country" varchar(100) NOT NULL,
	"company" varchar(200),
	"customer_id" integer,
	"subtotal" numeric(10, 2) NOT NULL,
	"discount" numeric(10, 2) DEFAULT '0' NOT NULL,
	"discount_code" varchar(50),
	"shipping" numeric(10, 2) NOT NULL,
	"shipping_country" varchar(10) NOT NULL,
	"total" numeric(10, 2) NOT NULL,
	"payment_method" "payment_method" NOT NULL,
	"status" "order_status" DEFAULT 'offen' NOT NULL,
	"tracking_number" varchar(100),
	"tracking_carrier" varchar(50),
	"shipping_label_url" text,
	"bunq_payment_id" varchar(100),
	"bunq_matched_at" timestamp,
	"internal_note" text,
	"order_date" timestamp NOT NULL,
	"paid_at" timestamp,
	"packed_at" timestamp,
	"shipped_at" timestamp,
	"delivered_at" timestamp,
	"cancelled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "orders_order_id_unique" UNIQUE("order_id")
);
--> statement-breakpoint
CREATE TABLE "stock_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"article_id" integer NOT NULL,
	"change_type" "stock_change_type" NOT NULL,
	"quantity_before" integer NOT NULL,
	"quantity_change" integer NOT NULL,
	"quantity_after" integer NOT NULL,
	"reason" text,
	"order_id" varchar(32),
	"user_name" varchar(100),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" varchar(100) NOT NULL,
	"password_hash" text NOT NULL,
	"name" text,
	"email" varchar(320),
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_signed_in" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
