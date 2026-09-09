-- Merchant schema compatibility: additive only.
-- Restores the nullable field already modeled by the application without changing
-- existing merchant rows, product data, checkout behavior or live shop visibility.
ALTER TABLE "article_merchant"
  ADD COLUMN IF NOT EXISTS "alt_image_link" text;
