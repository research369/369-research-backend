-- ============================================================
-- SPRINT 5: SEO CONTENT ENGINE – Schema-Erweiterungen
-- Datum: 2026-06-14 | Rein additiv – nur ALTER TABLE ADD COLUMN
-- ZERO RISK: Keine bestehenden Felder verändert, keine Daten gelöscht
-- ============================================================

-- use_cases: icon + is_active
ALTER TABLE "use_cases" ADD COLUMN IF NOT EXISTS "icon" varchar(100);
ALTER TABLE "use_cases" ADD COLUMN IF NOT EXISTS "is_active" integer DEFAULT 1;

-- use_case_translations: title (SEO-H1) + hero_text (kurzer Subtext für Hero)
ALTER TABLE "use_case_translations" ADD COLUMN IF NOT EXISTS "title" varchar(200);
ALTER TABLE "use_case_translations" ADD COLUMN IF NOT EXISTS "hero_text" text;

-- article_faq: schema_enabled (0/1 – ob dieser FAQ in Schema.org FAQPage erscheint)
ALTER TABLE "article_faq" ADD COLUMN IF NOT EXISTS "schema_enabled" integer DEFAULT 1;

-- article_studies: study_type, population, keywords
ALTER TABLE "article_studies" ADD COLUMN IF NOT EXISTS "study_type" varchar(50);
-- study_type Werte: 'RCT' | 'observational' | 'in-vitro' | 'in-vivo' | 'meta-analysis' | 'case-report' | 'review'
ALTER TABLE "article_studies" ADD COLUMN IF NOT EXISTS "population" varchar(100);
-- population Werte: 'human' | 'rat' | 'mouse' | 'in-vitro' | 'mixed'
ALTER TABLE "article_studies" ADD COLUMN IF NOT EXISTS "keywords" jsonb;
-- keywords: JSON-Array z.B. ["fat-loss", "glp-1", "metabolic"] für PepGPT-Kontext

-- article_merchant: Merchant Feed Erweiterungen (Sprint 5)
ALTER TABLE "article_merchant" ADD COLUMN IF NOT EXISTS "sale_price" numeric(10, 2);
ALTER TABLE "article_merchant" ADD COLUMN IF NOT EXISTS "sale_price_effective_date" varchar(100);
-- sale_price_effective_date Format: "2026-06-01T00:00:00+01:00/2026-06-30T23:59:59+01:00"
ALTER TABLE "article_merchant" ADD COLUMN IF NOT EXISTS "shipping" jsonb;
-- shipping Format: [{"country": "DE", "service": "DHL Paket", "price": "4.99 EUR"}]
ALTER TABLE "article_merchant" ADD COLUMN IF NOT EXISTS "identifier_exists" varchar(3) DEFAULT 'no';
-- identifier_exists: 'yes' wenn GTIN/MPN vorhanden, 'no' für Research Compounds
ALTER TABLE "article_merchant" ADD COLUMN IF NOT EXISTS "merchant_title" varchar(150);
-- merchant_title: Feed-Titel (überschreibt articles.name im Feed)
ALTER TABLE "article_merchant" ADD COLUMN IF NOT EXISTS "merchant_description" text;
-- merchant_description: Feed-Beschreibung (überschreibt articles.short_description im Feed)
ALTER TABLE "article_merchant" ADD COLUMN IF NOT EXISTS "canonical_url" text;
-- canonical_url: Produkt-URL im Feed (überschreibt automatisch generierte URL)
ALTER TABLE "article_merchant" ADD COLUMN IF NOT EXISTS "image_link" text;
-- image_link: Haupt-Bild-URL für Feed (überschreibt mockup_image_url)
ALTER TABLE "article_merchant" ADD COLUMN IF NOT EXISTS "alt_image_link" text;
-- alt_image_link: Zusatz-Bild-URL für Feed (optional, bis 10 erlaubt)
ALTER TABLE "article_merchant" ADD COLUMN IF NOT EXISTS "price_override" numeric(10, 2);
-- price_override: Preis-Override für Feed (wenn leer → articles.selling_price)
ALTER TABLE "article_merchant" ADD COLUMN IF NOT EXISTS "currency" varchar(3) DEFAULT 'EUR';

-- Indizes für Performance
CREATE INDEX IF NOT EXISTS "idx_use_cases_is_active" ON "use_cases"("is_active");
CREATE INDEX IF NOT EXISTS "idx_article_faq_schema_enabled" ON "article_faq"("schema_enabled");
CREATE INDEX IF NOT EXISTS "idx_article_studies_study_type" ON "article_studies"("study_type");
CREATE INDEX IF NOT EXISTS "idx_article_studies_population" ON "article_studies"("population");
