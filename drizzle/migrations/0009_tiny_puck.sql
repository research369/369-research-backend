CREATE TABLE "article_merchant" (
	"id" serial PRIMARY KEY NOT NULL,
	"article_id" integer NOT NULL,
	"google_product_category" varchar(10),
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
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "article_seo" (
	"id" serial PRIMARY KEY NOT NULL,
	"article_id" integer NOT NULL,
	"slug" varchar(200) NOT NULL,
	"canonical" text,
	"robots" varchar(50) DEFAULT 'index,follow',
	"schema_enabled" integer DEFAULT 1,
	"faq_enabled" integer DEFAULT 0,
	"og_image" text,
	"priority" numeric(2, 1) DEFAULT '0.8',
	"changefreq" varchar(20) DEFAULT 'weekly',
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "article_seo_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
ALTER TABLE "article_merchant" ADD CONSTRAINT "article_merchant_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_seo" ADD CONSTRAINT "article_seo_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_translations" ADD CONSTRAINT "article_translations_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_translations" ADD CONSTRAINT "category_translations_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_translations" ADD CONSTRAINT "article_translations_article_id_lang_unique" UNIQUE("article_id", "lang");--> statement-breakpoint
ALTER TABLE "article_merchant" ADD CONSTRAINT "article_merchant_article_id_unique" UNIQUE("article_id");--> statement-breakpoint
ALTER TABLE "article_seo" ADD CONSTRAINT "article_seo_article_id_unique" UNIQUE("article_id");--> statement-breakpoint
ALTER TABLE "category_translations" ADD CONSTRAINT "category_translations_category_id_lang_unique" UNIQUE("category_id", "lang");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_article_translations_article_id" ON "article_translations"("article_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_article_translations_lang" ON "article_translations"("lang");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_article_seo_slug" ON "article_seo"("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_article_merchant_article_id" ON "article_merchant"("article_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_category_translations_category_id" ON "category_translations"("category_id");
