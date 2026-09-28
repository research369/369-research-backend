-- ============================================================
-- COMMERCE CHANNEL ELIGIBILITY – additive release-control layer
--
-- Purpose:
--   Explicit, auditable delivery rules per sellable article, channel,
--   target market and locale. Existing shop visibility stays untouched.
--
-- Safety:
--   Additive only. No existing tables, data, prices, stock, orders or
--   checkout paths are modified. All merchant destinations are fail-closed:
--   a row must be explicitly approved before a feed can include it.
-- ============================================================

CREATE TABLE IF NOT EXISTS "article_channel_eligibility" (
  "id" serial PRIMARY KEY NOT NULL,
  "article_id" integer NOT NULL REFERENCES "articles"("id") ON DELETE CASCADE,
  "channel" varchar(50) NOT NULL,
  "market" varchar(8) NOT NULL DEFAULT 'DE',
  "locale" varchar(10) NOT NULL DEFAULT 'de',
  "status" varchar(20) NOT NULL DEFAULT 'review_required',
  "blocked_reason" text,
  "reviewed_by" varchar(100),
  "reviewed_at" timestamp,
  "valid_from" timestamp,
  "valid_until" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "article_channel_eligibility_status_check"
    CHECK ("status" IN ('draft', 'review_required', 'approved', 'blocked', 'archived')),
  CONSTRAINT "article_channel_eligibility_unique_scope"
    UNIQUE ("article_id", "channel", "market", "locale")
);

CREATE INDEX IF NOT EXISTS "idx_article_channel_eligibility_lookup"
  ON "article_channel_eligibility" ("channel", "market", "locale", "status");

CREATE INDEX IF NOT EXISTS "idx_article_channel_eligibility_article"
  ON "article_channel_eligibility" ("article_id");

-- No automatic backfill is intentionally performed. Merchant publication is
-- blocked by default until every product variant has been reviewed explicitly.
