import { getPool } from "./db.js";

/**
 * Additive schema for first-party marketing QR attribution.
 *
 * The reserved product/serial namespace `/i/<token>` is deliberately not represented
 * here. Marketing campaigns live exclusively under `/r/<shortCode>` so the prepared
 * individual product URLs cannot be changed or shadowed by this module.
 */
export async function ensureQrCampaignSchema(): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Database not available");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS qr_campaigns (
      id SERIAL PRIMARY KEY,
      name VARCHAR(160) NOT NULL,
      short_code VARCHAR(100) NOT NULL,
      target_url TEXT NOT NULL,
      campaign VARCHAR(160),
      medium VARCHAR(100),
      location_partner VARCHAR(200),
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      qr_type VARCHAR(20) NOT NULL DEFAULT 'marketing',
      created_by VARCHAR(100),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT qr_campaigns_status_check CHECK (status IN ('active', 'inactive', 'archived')),
      CONSTRAINT qr_campaigns_type_check CHECK (qr_type = 'marketing')
    );
    CREATE UNIQUE INDEX IF NOT EXISTS qr_campaigns_short_code_lower_uq
      ON qr_campaigns (LOWER(short_code));
    CREATE INDEX IF NOT EXISTS qr_campaigns_status_idx ON qr_campaigns (status, created_at DESC);

    CREATE TABLE IF NOT EXISTS qr_attributions (
      id BIGSERIAL PRIMARY KEY,
      attribution_token VARCHAR(64) NOT NULL UNIQUE,
      campaign_id INTEGER NOT NULL REFERENCES qr_campaigns(id),
      visitor_id VARCHAR(64) NOT NULL,
      first_scanned_at TIMESTAMP NOT NULL DEFAULT NOW(),
      last_scanned_at TIMESTAMP NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMP NOT NULL,
      scan_count INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS qr_attributions_campaign_visitor_idx
      ON qr_attributions (campaign_id, visitor_id);
    CREATE INDEX IF NOT EXISTS qr_attributions_token_expiry_idx
      ON qr_attributions (attribution_token, expires_at);

    CREATE TABLE IF NOT EXISTS qr_scan_events (
      id BIGSERIAL PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES qr_campaigns(id),
      attribution_token VARCHAR(64) NOT NULL,
      visitor_id VARCHAR(64) NOT NULL,
      scanned_at TIMESTAMP NOT NULL DEFAULT NOW(),
      device_type VARCHAR(30),
      country_code VARCHAR(12),
      region VARCHAR(120),
      ip_hash VARCHAR(128),
      user_agent TEXT,
      referrer TEXT
    );
    CREATE INDEX IF NOT EXISTS qr_scan_events_campaign_time_idx
      ON qr_scan_events (campaign_id, scanned_at DESC);
    CREATE INDEX IF NOT EXISTS qr_scan_events_visitor_idx
      ON qr_scan_events (campaign_id, visitor_id);

    CREATE TABLE IF NOT EXISTS qr_cart_events (
      id BIGSERIAL PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES qr_campaigns(id),
      attribution_token VARCHAR(64) NOT NULL UNIQUE,
      visitor_id VARCHAR(64) NOT NULL,
      occurred_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS qr_cart_events_campaign_time_idx
      ON qr_cart_events (campaign_id, occurred_at DESC);

    ALTER TABLE orders ADD COLUMN IF NOT EXISTS qr_campaign_id INTEGER;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS qr_attribution_token VARCHAR(64);
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS qr_code VARCHAR(100);
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS qr_campaign_name VARCHAR(160);
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS qr_campaign_medium VARCHAR(100);
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS qr_campaign_location VARCHAR(200);
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS kwk_credit_used DECIMAL(10,2) NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS kwk_credit_requested DECIMAL(10,2) NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS orders_qr_campaign_idx ON orders (qr_campaign_id, order_date DESC);
    CREATE INDEX IF NOT EXISTS orders_qr_attribution_idx ON orders (qr_attribution_token);
  `);
}
