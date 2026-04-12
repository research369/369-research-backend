CREATE TYPE "public"."communication_status" AS ENUM('sent', 'failed', 'draft', 'logged');--> statement-breakpoint
CREATE TYPE "public"."communication_type" AS ENUM('email', 'note', 'whatsapp', 'phone');--> statement-breakpoint
CREATE TYPE "public"."email_campaign_status" AS ENUM('draft', 'sending', 'sent', 'failed');--> statement-breakpoint
CREATE TABLE "customer_communications" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"type" "communication_type" NOT NULL,
	"status" "communication_status" DEFAULT 'logged' NOT NULL,
	"subject" varchar(500),
	"body" text,
	"html_body" text,
	"recipient_email" varchar(320),
	"sender_name" varchar(200),
	"order_id" varchar(32),
	"campaign_id" integer,
	"created_by" varchar(100),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_campaigns" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"subject" varchar(500) NOT NULL,
	"html_body" text NOT NULL,
	"template_id" integer,
	"status" "email_campaign_status" DEFAULT 'draft' NOT NULL,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"filter_criteria" text,
	"sent_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"subject" varchar(500) NOT NULL,
	"html_body" text NOT NULL,
	"description" text,
	"is_active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shop_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" varchar(100) NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "shop_settings_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "customer_number" varchar(20);--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "first_name" varchar(100);--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "last_name" varchar(100);--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "house_number" varchar(20);--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "tags" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "source" varchar(100);--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "first_order_date" timestamp;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "last_order_date" timestamp;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_customer_number_unique" UNIQUE("customer_number");