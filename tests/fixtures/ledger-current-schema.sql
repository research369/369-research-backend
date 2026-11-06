CREATE TYPE "public"."acquired_by" AS ENUM('shop', 'partner', 'direkt');;

CREATE TYPE "public"."bundle_type" AS ENUM('stack', 'kit', 'custom');;

CREATE TYPE "public"."commission_type" AS ENUM('einmalig', 'dauerhaft');;

CREATE TYPE "public"."communication_status" AS ENUM('sent', 'failed', 'draft', 'logged');;

CREATE TYPE "public"."communication_type" AS ENUM('email', 'note', 'whatsapp', 'phone');;

CREATE TYPE "public"."email_campaign_status" AS ENUM('draft', 'sending', 'sent', 'failed');;

CREATE TYPE "public"."follow_up_status" AS ENUM('pending', 'done', 'skipped');;

CREATE TYPE "public"."order_status" AS ENUM('offen', 'bezahlt', 'gepackt', 'versendet', 'zugestellt', 'storniert', 'abgeholt');;

CREATE TYPE "public"."partner_transaction_type" AS ENUM('provision', 'einloesung', 'korrektur', 'auszahlung');;

CREATE TYPE "public"."payment_method" AS ENUM('bunq', 'creditCard', 'wise', 'SEPA', 'Bar', 'Kreditkarte', 'PayPal', 'Crypto', 'Guthaben', 'Sonstige');;

CREATE TYPE "public"."promo_code_discount_type" AS ENUM('percent', 'fixed');;

CREATE TYPE "public"."purchase_order_status" AS ENUM('bestellt', 'versendet', 'teilweise_eingetroffen', 'vollständig', 'abgeschlossen');;

CREATE TYPE "public"."stock_change_type" AS ENUM('wareneingang', 'verkauf', 'korrektur', 'retoure', 'bestellung');;

CREATE TYPE "public"."transaction_status" AS ENUM('normal', 'storniert', 'nicht_gewertet', 'ausgeblendet');;

CREATE TYPE "public"."user_role" AS ENUM('user', 'admin');;

CREATE TYPE "public"."kwk_ledger_status" AS ENUM('pending', 'confirmed', 'cancelled');;

CREATE TYPE "public"."kwk_ledger_type" AS ENUM('pending_credit', 'credit_released', 'redeemed', 'cancelled', 'refund', 'manual_correction');;

CREATE TYPE "public"."kwk_referral_status" AS ENUM('pending', 'confirmed', 'cancelled', 'review');;

CREATE TYPE "public"."kwk_status" AS ENUM('aktiv', 'gesperrt', 'review', 'deaktiviert');;

CREATE TABLE "address_validation_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer,
	"order_id" varchar(32),
	"context" varchar(32) NOT NULL,
	"country_code" varchar(8) NOT NULL,
	"submitted_address_json" text NOT NULL,
	"provider_key" varchar(80),
	"provider_checked_at" timestamp,
	"validation_status" varchar(32) NOT NULL,
	"warnings_json" text DEFAULT '[]' NOT NULL,
	"details_json" text DEFAULT '{}' NOT NULL,
	"override_confirmed" integer DEFAULT 0 NOT NULL,
	"override_confirmed_at" timestamp,
	"override_confirmed_by" varchar(100),
	"evidence_svg" text,
	"evidence_sha256" varchar(128),
	"created_at" timestamp DEFAULT now() NOT NULL
);
;

CREATE TABLE "article_bundle_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"bundle_id" integer NOT NULL,
	"article_id" integer NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"sort_order" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL
);
;

CREATE TABLE "article_bundles" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(200) NOT NULL,
	"bundle_type" "bundle_type" DEFAULT 'stack' NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"image_url" text,
	"bundle_price" numeric(10, 2),
	"discount_percent" numeric(5, 2) DEFAULT '0',
	"sort_order" integer DEFAULT 0,
	"is_visible" integer DEFAULT 1,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "article_bundles_slug_unique" UNIQUE("slug")
);
;

CREATE TABLE "article_comparisons" (
	"id" serial PRIMARY KEY NOT NULL,
	"article_a_id" integer NOT NULL,
	"article_b_id" integer NOT NULL,
	"slug" varchar(200) NOT NULL,
	"comparison_data" jsonb,
	"is_visible" integer DEFAULT 1,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "article_comparisons_slug_unique" UNIQUE("slug")
);
;

CREATE TABLE "article_faq" (
	"id" serial PRIMARY KEY NOT NULL,
	"article_id" integer NOT NULL,
	"lang" varchar(5) DEFAULT 'de' NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"sort_order" integer DEFAULT 0,
	"is_visible" integer DEFAULT 1,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
;

CREATE TABLE "article_merchant" (
	"id" serial PRIMARY KEY NOT NULL,
	"article_id" integer NOT NULL,
	"google_product_category" varchar(10),
	"brand" varchar(100) DEFAULT '369 Research',
	"product_type" varchar(200),
	"gtin" varchar(14),
	"mpn" varchar(70),
	"availability" varchar(20) DEFAULT 'in_stock',
	"shipping_label" varchar(50),
	"condition" varchar(10) DEFAULT 'new',
	"age_group" varchar(20) DEFAULT 'adult',
	"custom_label_0" varchar(100),
	"custom_label_1" varchar(100),
	"custom_label_2" varchar(100),
	"merchant_title" varchar(150),
	"merchant_description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
;

CREATE TABLE "article_seo" (
	"id" serial PRIMARY KEY NOT NULL,
	"article_id" integer NOT NULL,
	"slug" varchar(200) NOT NULL,
	"seo_title" varchar(70),
	"seo_description" varchar(160),
	"image_alt" varchar(200),
	"hreflang" text,
	"canonical" text,
	"robots" varchar(50) DEFAULT 'index,follow',
	"schema_enabled" integer DEFAULT 1,
	"faq_enabled" integer DEFAULT 0,
	"og_image" text,
	"priority" numeric(2, 1) DEFAULT '0.8',
	"changefreq" varchar(20) DEFAULT 'weekly',
	"seo_keywords" varchar(500),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "article_seo_slug_unique" UNIQUE("slug")
);
;

CREATE TABLE "article_studies" (
	"id" serial PRIMARY KEY NOT NULL,
	"article_id" integer NOT NULL,
	"pubmed_id" varchar(20),
	"doi" varchar(200),
	"title" text NOT NULL,
	"authors" text,
	"journal" varchar(200),
	"year" integer,
	"url" text,
	"summary" text,
	"relevance" varchar(50),
	"sort_order" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
;

CREATE TABLE "article_tags" (
	"id" serial PRIMARY KEY NOT NULL,
	"article_id" integer NOT NULL,
	"tag" varchar(100) NOT NULL,
	"source" varchar(50) DEFAULT 'manual',
	"created_at" timestamp DEFAULT now() NOT NULL
);
;

CREATE TABLE "article_translations" (
	"id" serial PRIMARY KEY NOT NULL,
	"article_id" integer NOT NULL,
	"lang" varchar(5) NOT NULL,
	"name" varchar(200),
	"short_description" text,
	"description" jsonb,
	"seo_title" varchar(70),
	"seo_description" varchar(160),
	"merchant_title" varchar(150),
	"merchant_description" text,
	"image_alt" varchar(200),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
;

CREATE TABLE "article_use_cases" (
	"id" serial PRIMARY KEY NOT NULL,
	"article_id" integer NOT NULL,
	"use_case_id" integer NOT NULL,
	"sort_order" integer DEFAULT 0,
	"is_primary" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL
);
;

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
	"description" jsonb,
	"shop_visible" integer DEFAULT 0 NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"mockup_image_url" text,
	"label_image_url" text,
	"cas_number" varchar(50),
	"molecular_weight" varchar(50),
	"purity" varchar(20),
	"badge" text,
	"sale_price" numeric(10, 2),
	"sale_price_label" varchar(100),
	"lab_report_image_url" text,
	"gallery_images" jsonb,
	"categories" jsonb,
	"variants" jsonb,
	"short_description" text,
	"beauty_data" jsonb,
	"photo_coming_soon" integer DEFAULT 0,
	"follow_up_category" varchar(50),
	"published_at" timestamp,
	"nasal_spray_image_url" text,
	"bundle_deal" jsonb,
	"sort_order" integer DEFAULT 9999,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "articles_sku_unique" UNIQUE("sku")
);
;

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
;

CREATE TABLE "bundle_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"bundle_id" integer NOT NULL,
	"article_sku" varchar(100) NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"is_free_gift" integer DEFAULT 0 NOT NULL,
	"is_tablet" integer DEFAULT 0 NOT NULL,
	"fixed_dosage_mg" integer,
	"sort_order" integer DEFAULT 0 NOT NULL
);
;

CREATE TABLE "bundles" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(100) NOT NULL,
	"name" varchar(200) NOT NULL,
	"category" varchar(50) NOT NULL,
	"tagline" text,
	"description" text,
	"discount_percent" numeric(5, 2) DEFAULT '0' NOT NULL,
	"allows_plug_play" integer DEFAULT 0 NOT NULL,
	"allows_nasal_spray" integer DEFAULT 0 NOT NULL,
	"image_url" text,
	"is_active" integer DEFAULT 1 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "bundles_slug_unique" UNIQUE("slug")
);
;

CREATE TABLE "category_translations" (
	"id" serial PRIMARY KEY NOT NULL,
	"category_id" integer NOT NULL,
	"lang" varchar(5) NOT NULL,
	"name" varchar(200),
	"description" text,
	"seo_title" varchar(70),
	"seo_description" varchar(160),
	"image_alt" varchar(200),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
;

CREATE TABLE "communication_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"communication_id" integer NOT NULL,
	"provider" varchar(50) DEFAULT 'resend' NOT NULL,
	"provider_event_id" varchar(150) NOT NULL,
	"event_type" varchar(80) NOT NULL,
	"occurred_at" timestamp NOT NULL,
	"payload" text,
	"operator_alert_status" varchar(24),
	"operator_alert_sent_at" timestamp,
	"operator_alert_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "communication_events_provider_event_id_unique" UNIQUE("provider_event_id")
);
;

CREATE TABLE "communication_template_audit" (
	"id" serial PRIMARY KEY NOT NULL,
	"template_id" integer NOT NULL,
	"action" varchar(30) NOT NULL,
	"previous_value" jsonb,
	"next_value" jsonb,
	"changed_by" varchar(100) DEFAULT 'admin' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
;

CREATE TABLE "communication_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"template_key" varchar(100) NOT NULL,
	"channel" varchar(20) NOT NULL,
	"language" varchar(5) NOT NULL,
	"title" varchar(200) NOT NULL,
	"subject_template" text,
	"body_template" text NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
;

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
	"sender_email" varchar(320),
	"reply_to" varchar(320),
	"resend_email_id" varchar(100),
	"resend_message_id" varchar(500),
	"delivery_status" varchar(32),
	"delivery_status_at" timestamp,
	"error_message" text,
	"delivery_issue_resolved_at" timestamp,
	"delivery_issue_resolution" varchar(500),
	"delivery_issue_resolved_by" varchar(100),
	"idempotency_key" varchar(200),
	"direction" varchar(16) DEFAULT 'outbound' NOT NULL,
	"source" varchar(32) DEFAULT 'manual' NOT NULL,
	"order_id" varchar(32),
	"campaign_id" integer,
	"created_by" varchar(100),
	"created_at" timestamp DEFAULT now() NOT NULL
);
;

CREATE TABLE "customer_data_change_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"order_id" varchar(32) NOT NULL,
	"match_method" varchar(24) NOT NULL,
	"previous_snapshot_json" text NOT NULL,
	"submitted_snapshot_json" text NOT NULL,
	"changed_fields_json" text NOT NULL,
	"customer_confirmed_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
;

CREATE TABLE "customer_issue_cases" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"order_id" varchar(32),
	"category" varchar(64) NOT NULL,
	"severity" varchar(16) DEFAULT 'normal' NOT NULL,
	"status" varchar(24) DEFAULT 'open' NOT NULL,
	"title" varchar(240) NOT NULL,
	"details" text NOT NULL,
	"occurred_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by" varchar(100) NOT NULL,
	"resolved_at" timestamp,
	"resolved_by" varchar(100),
	"resolution_note" text,
	"context_snapshot_json" text DEFAULT '{}' NOT NULL
);
;

CREATE TABLE "customer_order_blocks" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"reason" text NOT NULL,
	"email_normalized" varchar(320),
	"phone_normalized" varchar(32),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by" varchar(100) NOT NULL,
	"revoked_at" timestamp,
	"revoked_by" varchar(100)
);
;

CREATE TABLE "customer_promo_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"promo_code_id" integer NOT NULL,
	"customer_id" integer NOT NULL,
	"origin_order_id" varchar(32) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by" varchar(100) NOT NULL,
	CONSTRAINT "customer_promo_assignments_promo_code_id_unique" UNIQUE("promo_code_id")
);
;

CREATE TABLE "customer_tag_definitions" (
	"id" serial PRIMARY KEY NOT NULL,
	"tag_key" varchar(80) NOT NULL,
	"label" varchar(120) NOT NULL,
	"color" varchar(32) DEFAULT 'slate' NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 999 NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "customer_tag_definitions_tag_key_unique" UNIQUE("tag_key")
);
;

CREATE TABLE "customers" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_number" varchar(20),
	"preferred_delivery_type" varchar(20),
	"name" varchar(200) NOT NULL,
	"first_name" varchar(200),
	"last_name" varchar(200),
	"phone" varchar(50),
	"email" varchar(320),
	"company" varchar(200),
	"street" varchar(300),
	"house_number" varchar(100),
	"zip" varchar(30),
	"city" varchar(100),
	"country" varchar(100),
	"dhl_post_number" varchar(20),
	"communication_language" varchar(2) DEFAULT 'de' NOT NULL,
	"tags" text,
	"source" varchar(100),
	"acquired_by" "acquired_by" DEFAULT 'shop' NOT NULL,
	"acquired_by_partner_id" integer,
	"notes" text,
	"total_orders" integer DEFAULT 0 NOT NULL,
	"total_spent" numeric(10, 2) DEFAULT '0' NOT NULL,
	"first_order_date" timestamp,
	"last_order_date" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "customers_customer_number_unique" UNIQUE("customer_number")
);
;

CREATE TABLE "duplicate_check_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"trigger" varchar(24) NOT NULL,
	"status" varchar(24) DEFAULT 'completed' NOT NULL,
	"customer_findings" integer DEFAULT 0 NOT NULL,
	"order_findings" integer DEFAULT 0 NOT NULL,
	"summary" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"created_by" varchar(100)
);
;

CREATE TABLE "duplicate_findings" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"entity_type" varchar(16) NOT NULL,
	"primary_record_id" varchar(64) NOT NULL,
	"candidate_record_id" varchar(64) NOT NULL,
	"confidence" integer NOT NULL,
	"reasons" text NOT NULL,
	"status" varchar(24) DEFAULT 'open' NOT NULL,
	"resolution_note" text,
	"resolved_by" varchar(100),
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
;

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
;

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
;

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
;

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
;

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
	"is_nasal_spray" boolean DEFAULT false NOT NULL,
	"is_nasal_diy_set" boolean DEFAULT false NOT NULL,
	"is_plug_play" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
;

CREATE TABLE "orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" varchar(32) NOT NULL,
	"order_origin" varchar(32),
	"store_key" varchar(32) DEFAULT '369research' NOT NULL,
	"external_order_reference" varchar(32),
	"checkout_idempotency_key" varchar(128),
	"first_name" varchar(200) NOT NULL,
	"last_name" varchar(200) NOT NULL,
	"email" varchar(320) NOT NULL,
	"phone" varchar(50) NOT NULL,
	"street" varchar(300) NOT NULL,
	"house_number" varchar(100) NOT NULL,
	"zip" varchar(30) NOT NULL,
	"city" varchar(100) NOT NULL,
	"country" varchar(100) NOT NULL,
	"company" varchar(200),
	"communication_language" varchar(2) DEFAULT 'de' NOT NULL,
	"delivery_type" varchar(20) DEFAULT 'home' NOT NULL,
	"dhl_post_number" varchar(20),
	"customer_id" integer,
	"subtotal" numeric(10, 2) NOT NULL,
	"discount" numeric(10, 2) DEFAULT '0' NOT NULL,
	"discount_code" varchar(50),
	"discount_breakdown" jsonb,
	"shipping" numeric(10, 2) NOT NULL,
	"shipping_country" varchar(10) NOT NULL,
	"total" numeric(10, 2) NOT NULL,
	"payment_method" "payment_method" NOT NULL,
	"status" "order_status" DEFAULT 'offen' NOT NULL,
	"tracking_number" varchar(100),
	"tracking_carrier" varchar(50),
	"shipping_label_url" text,
	"shipping_label_content" text,
	"packing_photo_url" text,
	"packing_photo_at" timestamp,
	"weight_grams" integer,
	"partner_source_id" integer,
	"partner_code_id_snapshot" integer,
	"partner_code" varchar(50),
	"partner_number" varchar(50),
	"partner_discount" numeric(10, 2) DEFAULT '0',
	"partner_commission" numeric(10, 2) DEFAULT '0',
	"partner_program_snapshot" varchar(32),
	"partner_settlement_method_snapshot" varchar(24),
	"partner_commission_policy_snapshot" varchar(40),
	"partner_customer_discount_policy_snapshot" varchar(40),
	"partner_commission_percent_snapshot" numeric(6, 2),
	"partner_customer_discount_percent_snapshot" numeric(6, 2),
	"partner_commission_base_snapshot" numeric(10, 2),
	"credit_used" numeric(10, 2) DEFAULT '0',
	"kwk_credit_used" numeric(10, 2) DEFAULT '0',
	"kwk_credit_requested" numeric(10, 2) DEFAULT '0',
	"kwk_credit_owner_id" integer,
	"qr_campaign_id" integer,
	"qr_attribution_token" varchar(64),
	"qr_code" varchar(100),
	"qr_campaign_name" varchar(160),
	"qr_campaign_medium" varchar(100),
	"qr_campaign_location" varchar(200),
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
;

CREATE TABLE "packing_photo_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" varchar(32) NOT NULL,
	"photo_data" text NOT NULL,
	"photo_at" timestamp DEFAULT now() NOT NULL,
	"source" varchar(16) DEFAULT 'retake' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
;

CREATE TABLE "partner_address_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"partner_id" integer NOT NULL,
	"partner_name_snapshot" varchar(200) NOT NULL,
	"partner_number_snapshot" varchar(50) NOT NULL,
	"partner_email_snapshot" varchar(320),
	"current_address_json" text DEFAULT '{}' NOT NULL,
	"requested_address_json" text NOT NULL,
	"request_fingerprint" varchar(128) NOT NULL,
	"status" varchar(24) DEFAULT 'open' NOT NULL,
	"notification_status" varchar(24) DEFAULT 'pending' NOT NULL,
	"notification_error" text,
	"notification_sent_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"reviewed_at" timestamp,
	"reviewed_by" varchar(100),
	"review_note" text
);
;

CREATE TABLE "partner_code_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" varchar(320) NOT NULL,
	"partner_code" varchar(50) NOT NULL,
	"order_id" varchar(32) NOT NULL,
	"used_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "partner_code_usage_email_unique" UNIQUE("email")
);
;

CREATE TABLE "partner_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"partner_id" integer NOT NULL,
	"display_code" varchar(50) NOT NULL,
	"code_normalized" varchar(50) NOT NULL,
	"commission_percent" numeric(6, 2) NOT NULL,
	"customer_discount_percent" numeric(6, 2) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "partner_codes_code_normalized_unique" UNIQUE("code_normalized")
);
;

CREATE TABLE "partner_order_credit_overrides" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" varchar(32) NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"reason" text NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "partner_order_credit_overrides_order_id_unique" UNIQUE("order_id")
);
;

CREATE TABLE "partner_programs" (
	"key" varchar(32) PRIMARY KEY NOT NULL,
	"label" varchar(80) NOT NULL,
	"customer_discount_policy" varchar(40) NOT NULL,
	"commission_policy" varchar(40) NOT NULL,
	"settlement_method" varchar(24) NOT NULL,
	"allow_self_order_credit" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
;

CREATE TABLE "partner_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"partner_id" integer NOT NULL,
	"type" "partner_transaction_type" NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"balance_after" numeric(10, 2) NOT NULL,
	"order_id" varchar(32),
	"customer_name" varchar(200),
	"description" text,
	"status" "transaction_status" DEFAULT 'normal' NOT NULL,
	"admin_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
;

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
	"commission_type" "commission_type" DEFAULT 'dauerhaft' NOT NULL,
	"program_key" varchar(32) DEFAULT 'partner' NOT NULL,
	"password_hash" text,
	"last_login" timestamp,
	"is_active" integer DEFAULT 1 NOT NULL,
	"street" varchar(300),
	"house_number" varchar(100),
	"zip" varchar(30),
	"city" varchar(100),
	"country" varchar(100),
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "partners_code_unique" UNIQUE("code"),
	CONSTRAINT "partners_partner_number_unique" UNIQUE("partner_number")
);
;

CREATE TABLE "personal_promo_expiry_reminders" (
	"id" serial PRIMARY KEY NOT NULL,
	"promo_code_id" integer NOT NULL,
	"customer_id" integer NOT NULL,
	"origin_order_id" varchar(32) NOT NULL,
	"code" varchar(50) NOT NULL,
	"expires_at" timestamp NOT NULL,
	"due_at" timestamp NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"completed_at" timestamp,
	"skipped_at" timestamp,
	"completed_by" varchar(100),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "personal_promo_expiry_reminders_promo_code_id_unique" UNIQUE("promo_code_id")
);
;

CREATE TABLE "product_audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"article_id" integer NOT NULL,
	"action" varchar(50) NOT NULL,
	"field_name" varchar(100),
	"old_value" text,
	"new_value" text,
	"changed_by" varchar(100) NOT NULL,
	"changed_at" timestamp DEFAULT now() NOT NULL,
	"rollback_data" jsonb
);
;

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
	"valid_until_exact" integer DEFAULT 0 NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "promo_codes_code_unique" UNIQUE("code")
);
;

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
;

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
;

CREATE TABLE "sales_followup_products" (
	"id" serial PRIMARY KEY NOT NULL,
	"followup_id" integer NOT NULL,
	"article_id" integer NOT NULL,
	"generated_copy" text,
	"generated_copy_source" varchar(20),
	"generated_copy_generated_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
;

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
	"discount_percent" numeric(5, 2) DEFAULT '10' NOT NULL,
	"code_validity_hours" integer DEFAULT 48 NOT NULL,
	"code_created_at" timestamp,
	"code_expires_at" timestamp,
	"message_generated_at" timestamp,
	"whatsapp_opened_at" timestamp,
	"reminder_stage" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sales_followups_order_id_unique" UNIQUE("order_id")
);
;

CREATE TABLE "categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(200) NOT NULL,
	"parent_id" integer,
	"image_url" text,
	"sort_order" integer DEFAULT 0,
	"visible" integer DEFAULT 1,
	"type" varchar(50) DEFAULT 'shop',
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "categories_slug_unique" UNIQUE("slug")
);
;

CREATE TABLE "shop_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" varchar(100) NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "shop_settings_key_unique" UNIQUE("key")
);
;

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
;

CREATE TABLE "use_case_translations" (
	"id" serial PRIMARY KEY NOT NULL,
	"use_case_id" integer NOT NULL,
	"lang" varchar(5) NOT NULL,
	"name" varchar(200),
	"description" text,
	"seo_title" varchar(70),
	"seo_description" varchar(160),
	"image_alt" varchar(200),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
;

CREATE TABLE "use_cases" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(200) NOT NULL,
	"featured_article_id" integer,
	"image_url" text,
	"sort_order" integer DEFAULT 0,
	"visible" integer DEFAULT 1,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "use_cases_slug_unique" UNIQUE("slug")
);
;

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
	"totp_secret" text,
	"totp_enabled" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
;

CREATE TABLE "kwk_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"kwk_number" varchar(20) NOT NULL,
	"referral_code" varchar(50) NOT NULL,
	"name" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"phone" varchar(50) NOT NULL,
	"password_hash" text NOT NULL,
	"status" "kwk_status" DEFAULT 'aktiv' NOT NULL,
	"credit_available" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"credit_pending" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"credit_redeemed" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"company" varchar(255),
	"whatsapp" varchar(50),
	"notes" text,
	"login_attempts" integer DEFAULT 0 NOT NULL,
	"login_locked_until" timestamp,
	"last_login" timestamp,
	"reset_token" varchar(128),
	"reset_token_expires_at" timestamp,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "kwk_accounts_kwk_number_unique" UNIQUE("kwk_number"),
	CONSTRAINT "kwk_accounts_referral_code_unique" UNIQUE("referral_code"),
	CONSTRAINT "kwk_accounts_email_unique" UNIQUE("email")
);
;

CREATE TABLE "kwk_audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"kwk_id" integer,
	"admin_user" varchar(100) NOT NULL,
	"action" varchar(100) NOT NULL,
	"old_value" text,
	"new_value" text,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
;

CREATE TABLE "kwk_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"kwk_id" integer NOT NULL,
	"order_id" varchar(50),
	"amount" numeric(10, 2) NOT NULL,
	"type" "kwk_ledger_type" NOT NULL,
	"status" "kwk_ledger_status" DEFAULT 'pending' NOT NULL,
	"note" text,
	"created_by" varchar(100) DEFAULT 'system' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
;

CREATE TABLE "kwk_referrals" (
	"id" serial PRIMARY KEY NOT NULL,
	"kwk_id" integer NOT NULL,
	"order_id" varchar(50) NOT NULL,
	"customer_email" varchar(255),
	"customer_phone" varchar(50),
	"customer_address_hash" varchar(64),
	"discount_applied" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"commission_base" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"commission_amount" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"fraud_flags" text,
	"status" "kwk_referral_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "kwk_referrals_order_id_unique" UNIQUE("order_id")
);
;

ALTER TABLE "article_bundle_items" ADD CONSTRAINT "article_bundle_items_bundle_id_article_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."article_bundles"("id") ON DELETE cascade ON UPDATE no action;;

ALTER TABLE "article_bundle_items" ADD CONSTRAINT "article_bundle_items_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;;

ALTER TABLE "article_comparisons" ADD CONSTRAINT "article_comparisons_article_a_id_articles_id_fk" FOREIGN KEY ("article_a_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;;

ALTER TABLE "article_comparisons" ADD CONSTRAINT "article_comparisons_article_b_id_articles_id_fk" FOREIGN KEY ("article_b_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;;

ALTER TABLE "article_faq" ADD CONSTRAINT "article_faq_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;;

ALTER TABLE "article_merchant" ADD CONSTRAINT "article_merchant_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;;

ALTER TABLE "article_seo" ADD CONSTRAINT "article_seo_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;;

ALTER TABLE "article_studies" ADD CONSTRAINT "article_studies_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;;

ALTER TABLE "article_tags" ADD CONSTRAINT "article_tags_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;;

ALTER TABLE "article_translations" ADD CONSTRAINT "article_translations_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;;

ALTER TABLE "article_use_cases" ADD CONSTRAINT "article_use_cases_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;;

ALTER TABLE "article_use_cases" ADD CONSTRAINT "article_use_cases_use_case_id_use_cases_id_fk" FOREIGN KEY ("use_case_id") REFERENCES "public"."use_cases"("id") ON DELETE cascade ON UPDATE no action;;

ALTER TABLE "bundle_items" ADD CONSTRAINT "bundle_items_bundle_id_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."bundles"("id") ON DELETE cascade ON UPDATE no action;;

ALTER TABLE "category_translations" ADD CONSTRAINT "category_translations_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;;

ALTER TABLE "customer_order_blocks" ADD CONSTRAINT "customer_order_blocks_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;;

ALTER TABLE "customer_promo_assignments" ADD CONSTRAINT "customer_promo_assignments_promo_code_id_promo_codes_id_fk" FOREIGN KEY ("promo_code_id") REFERENCES "public"."promo_codes"("id") ON DELETE no action ON UPDATE no action;;

ALTER TABLE "customer_promo_assignments" ADD CONSTRAINT "customer_promo_assignments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;;

ALTER TABLE "customer_promo_assignments" ADD CONSTRAINT "customer_promo_assignments_origin_order_id_orders_order_id_fk" FOREIGN KEY ("origin_order_id") REFERENCES "public"."orders"("order_id") ON DELETE no action ON UPDATE no action;;

ALTER TABLE "personal_promo_expiry_reminders" ADD CONSTRAINT "personal_promo_expiry_reminders_promo_code_id_promo_codes_id_fk" FOREIGN KEY ("promo_code_id") REFERENCES "public"."promo_codes"("id") ON DELETE no action ON UPDATE no action;;

ALTER TABLE "personal_promo_expiry_reminders" ADD CONSTRAINT "personal_promo_expiry_reminders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;;

ALTER TABLE "personal_promo_expiry_reminders" ADD CONSTRAINT "personal_promo_expiry_reminders_origin_order_id_orders_order_id_fk" FOREIGN KEY ("origin_order_id") REFERENCES "public"."orders"("order_id") ON DELETE no action ON UPDATE no action;;

ALTER TABLE "product_audit_log" ADD CONSTRAINT "product_audit_log_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE no action ON UPDATE no action;;

ALTER TABLE "use_case_translations" ADD CONSTRAINT "use_case_translations_use_case_id_use_cases_id_fk" FOREIGN KEY ("use_case_id") REFERENCES "public"."use_cases"("id") ON DELETE cascade ON UPDATE no action;;

ALTER TABLE "kwk_ledger" ADD CONSTRAINT "kwk_ledger_kwk_id_kwk_accounts_id_fk" FOREIGN KEY ("kwk_id") REFERENCES "public"."kwk_accounts"("id") ON DELETE restrict ON UPDATE cascade;;

ALTER TABLE "kwk_referrals" ADD CONSTRAINT "kwk_referrals_kwk_id_kwk_accounts_id_fk" FOREIGN KEY ("kwk_id") REFERENCES "public"."kwk_accounts"("id") ON DELETE restrict ON UPDATE cascade;;

CREATE INDEX "address_validation_records_customer_idx" ON "address_validation_records" USING btree ("customer_id","created_at");;

CREATE INDEX "address_validation_records_order_idx" ON "address_validation_records" USING btree ("order_id","created_at");;

CREATE INDEX "customer_data_change_events_customer_idx" ON "customer_data_change_events" USING btree ("customer_id","created_at");;

CREATE INDEX "customer_data_change_events_order_idx" ON "customer_data_change_events" USING btree ("order_id","created_at");;

CREATE INDEX "customer_issue_cases_customer_idx" ON "customer_issue_cases" USING btree ("customer_id","status","occurred_at");;

CREATE INDEX "customer_issue_cases_order_idx" ON "customer_issue_cases" USING btree ("order_id","status","occurred_at");;

CREATE INDEX "customer_promo_assignments_customer_idx" ON "customer_promo_assignments" USING btree ("customer_id","created_at");;

CREATE INDEX "customer_promo_assignments_origin_order_idx" ON "customer_promo_assignments" USING btree ("origin_order_id","created_at");;

CREATE INDEX "duplicate_findings_run_idx" ON "duplicate_findings" USING btree ("run_id");;

CREATE INDEX "duplicate_findings_status_idx" ON "duplicate_findings" USING btree ("status");;

CREATE INDEX "order_items_order_id_idx" ON "order_items" USING btree ("order_id");;

CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");;

CREATE INDEX "orders_order_date_idx" ON "orders" USING btree ("order_date");;

CREATE INDEX "orders_customer_id_idx" ON "orders" USING btree ("customer_id");;

CREATE INDEX "orders_email_idx" ON "orders" USING btree ("email");;

CREATE INDEX "orders_qr_campaign_idx" ON "orders" USING btree ("qr_campaign_id","order_date");;

CREATE INDEX "orders_qr_attribution_idx" ON "orders" USING btree ("qr_attribution_token");;

CREATE INDEX "packing_photo_history_order_created_idx" ON "packing_photo_history" USING btree ("order_id","created_at");;

CREATE INDEX "partner_address_requests_partner_status_idx" ON "partner_address_requests" USING btree ("partner_id","status","created_at");;

CREATE INDEX "partner_address_requests_status_created_idx" ON "partner_address_requests" USING btree ("status","created_at");;

CREATE INDEX "personal_promo_expiry_reminders_status_due_idx" ON "personal_promo_expiry_reminders" USING btree ("status","due_at");;

CREATE INDEX "personal_promo_expiry_reminders_customer_idx" ON "personal_promo_expiry_reminders" USING btree ("customer_id","created_at");;

CREATE INDEX "personal_promo_expiry_reminders_order_idx" ON "personal_promo_expiry_reminders" USING btree ("origin_order_id","created_at");;

CREATE INDEX "stock_history_created_at_idx" ON "stock_history" USING btree ("created_at");;

CREATE INDEX "stock_history_article_created_at_idx" ON "stock_history" USING btree ("article_id","created_at");;

CREATE UNIQUE INDEX "kwk_accounts_email_idx" ON "kwk_accounts" USING btree ("email");;

CREATE UNIQUE INDEX "kwk_accounts_kwk_number_idx" ON "kwk_accounts" USING btree ("kwk_number");;

CREATE UNIQUE INDEX "kwk_accounts_referral_code_idx" ON "kwk_accounts" USING btree ("referral_code");;

CREATE INDEX "kwk_accounts_status_idx" ON "kwk_accounts" USING btree ("status");;

CREATE INDEX "kwk_audit_log_kwk_id_idx" ON "kwk_audit_log" USING btree ("kwk_id");;

CREATE INDEX "kwk_audit_log_created_at_idx" ON "kwk_audit_log" USING btree ("created_at");;

CREATE INDEX "kwk_ledger_kwk_id_idx" ON "kwk_ledger" USING btree ("kwk_id");;

CREATE INDEX "kwk_ledger_order_id_idx" ON "kwk_ledger" USING btree ("order_id");;

CREATE INDEX "kwk_ledger_type_status_idx" ON "kwk_ledger" USING btree ("type","status");;

CREATE UNIQUE INDEX "kwk_ledger_one_redemption_per_order_idx" ON "kwk_ledger" USING btree ("order_id") WHERE "kwk_ledger"."type" = 'redeemed' AND "kwk_ledger"."order_id" IS NOT NULL;;

CREATE UNIQUE INDEX "kwk_ledger_one_cancellation_per_owner_order_idx" ON "kwk_ledger" USING btree ("kwk_id","order_id") WHERE "kwk_ledger"."type" = 'cancelled' AND "kwk_ledger"."status" = 'confirmed' AND "kwk_ledger"."order_id" IS NOT NULL;;

CREATE UNIQUE INDEX "kwk_referrals_order_id_idx" ON "kwk_referrals" USING btree ("order_id");;

CREATE INDEX "kwk_referrals_kwk_id_idx" ON "kwk_referrals" USING btree ("kwk_id");;

CREATE INDEX "kwk_referrals_status_idx" ON "kwk_referrals" USING btree ("status");;
