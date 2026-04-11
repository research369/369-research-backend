CREATE TYPE "public"."promo_code_discount_type" AS ENUM('percent', 'fixed');--> statement-breakpoint
ALTER TYPE "public"."payment_method" ADD VALUE 'SEPA';--> statement-breakpoint
ALTER TYPE "public"."payment_method" ADD VALUE 'Bar';--> statement-breakpoint
ALTER TYPE "public"."payment_method" ADD VALUE 'Kreditkarte';--> statement-breakpoint
ALTER TYPE "public"."payment_method" ADD VALUE 'PayPal';--> statement-breakpoint
ALTER TYPE "public"."payment_method" ADD VALUE 'Crypto';--> statement-breakpoint
ALTER TYPE "public"."payment_method" ADD VALUE 'Guthaben';--> statement-breakpoint
ALTER TYPE "public"."payment_method" ADD VALUE 'Sonstige';--> statement-breakpoint
CREATE TABLE "partner_code_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" varchar(320) NOT NULL,
	"partner_code" varchar(50) NOT NULL,
	"order_id" varchar(32) NOT NULL,
	"used_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "partner_code_usage_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "promo_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" varchar(50) NOT NULL,
	"discount_type" "promo_code_discount_type" DEFAULT 'percent' NOT NULL,
	"percentage" numeric(5, 2) DEFAULT '0',
	"fixed_amount" numeric(10, 2) DEFAULT '0',
	"min_order" numeric(10, 2) DEFAULT '0',
	"max_uses" integer DEFAULT 0,
	"current_uses" integer DEFAULT 0 NOT NULL,
	"valid_from" timestamp,
	"valid_until" timestamp,
	"is_active" integer DEFAULT 1 NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "promo_codes_code_unique" UNIQUE("code")
);
