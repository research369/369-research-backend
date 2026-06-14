ALTER TABLE "article_merchant" ADD COLUMN "brand" varchar(100) DEFAULT '369 Research';--> statement-breakpoint
ALTER TABLE "article_seo" ADD COLUMN "seo_title" varchar(70);--> statement-breakpoint
ALTER TABLE "article_seo" ADD COLUMN "seo_description" varchar(160);--> statement-breakpoint
ALTER TABLE "article_seo" ADD COLUMN "image_alt" varchar(200);--> statement-breakpoint
ALTER TABLE "article_seo" ADD COLUMN "hreflang" text;