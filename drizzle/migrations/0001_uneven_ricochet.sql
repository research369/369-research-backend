CREATE TYPE "public"."partner_transaction_type" AS ENUM('provision', 'einloesung', 'korrektur');--> statement-breakpoint
CREATE TABLE "partner_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"partner_id" integer NOT NULL,
	"type" "partner_transaction_type" NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"balance_after" numeric(10, 2) NOT NULL,
	"order_id" varchar(32),
	"customer_name" varchar(200),
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partners" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"email" varchar(320),
	"phone" varchar(50),
	"company" varchar(200),
	"code" varchar(50) NOT NULL,
	"partner_number" varchar(50) NOT NULL,
	"commission_percent" numeric(5, 2) DEFAULT '10' NOT NULL,
	"customer_discount_percent" numeric(5, 2) DEFAULT '10' NOT NULL,
	"credit_balance" numeric(10, 2) DEFAULT '0' NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "partners_code_unique" UNIQUE("code"),
	CONSTRAINT "partners_partner_number_unique" UNIQUE("partner_number")
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "partner_code" varchar(50);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "partner_number" varchar(50);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "partner_discount" numeric(10, 2) DEFAULT '0';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "partner_commission" numeric(10, 2) DEFAULT '0';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "credit_used" numeric(10, 2) DEFAULT '0';