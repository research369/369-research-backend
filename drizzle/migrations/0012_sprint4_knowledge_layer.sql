CREATE TYPE "public"."bundle_type" AS ENUM('stack', 'kit', 'custom');--> statement-breakpoint
CREATE TABLE "article_bundle_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"bundle_id" integer NOT NULL,
	"article_id" integer NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"sort_order" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE "article_tags" (
	"id" serial PRIMARY KEY NOT NULL,
	"article_id" integer NOT NULL,
	"tag" varchar(100) NOT NULL,
	"source" varchar(50) DEFAULT 'manual',
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "article_use_cases" (
	"id" serial PRIMARY KEY NOT NULL,
	"article_id" integer NOT NULL,
	"use_case_id" integer NOT NULL,
	"sort_order" integer DEFAULT 0,
	"is_primary" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
ALTER TABLE "article_bundle_items" ADD CONSTRAINT "article_bundle_items_bundle_id_article_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."article_bundles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_bundle_items" ADD CONSTRAINT "article_bundle_items_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_comparisons" ADD CONSTRAINT "article_comparisons_article_a_id_articles_id_fk" FOREIGN KEY ("article_a_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_comparisons" ADD CONSTRAINT "article_comparisons_article_b_id_articles_id_fk" FOREIGN KEY ("article_b_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_faq" ADD CONSTRAINT "article_faq_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_studies" ADD CONSTRAINT "article_studies_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_tags" ADD CONSTRAINT "article_tags_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_use_cases" ADD CONSTRAINT "article_use_cases_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_use_cases" ADD CONSTRAINT "article_use_cases_use_case_id_use_cases_id_fk" FOREIGN KEY ("use_case_id") REFERENCES "public"."use_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "use_case_translations" ADD CONSTRAINT "use_case_translations_use_case_id_use_cases_id_fk" FOREIGN KEY ("use_case_id") REFERENCES "public"."use_cases"("id") ON DELETE cascade ON UPDATE no action;