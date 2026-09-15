-- Revisionssichere Partnerportal-Adressanträge.
-- Die kanonische Lieferadresse wird nur über die WaWi-Freigabe geändert.

CREATE TABLE IF NOT EXISTS partner_address_requests (
  id SERIAL PRIMARY KEY,
  partner_id INTEGER NOT NULL,
  partner_name_snapshot VARCHAR(200) NOT NULL,
  partner_number_snapshot VARCHAR(50) NOT NULL,
  partner_email_snapshot VARCHAR(320),
  current_address_json TEXT NOT NULL DEFAULT '{}',
  requested_address_json TEXT NOT NULL,
  request_fingerprint VARCHAR(128) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'open',
  notification_status VARCHAR(24) NOT NULL DEFAULT 'pending',
  notification_error TEXT,
  notification_sent_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMP,
  reviewed_by VARCHAR(100),
  review_note TEXT
);

CREATE INDEX IF NOT EXISTS partner_address_requests_partner_status_idx
  ON partner_address_requests (partner_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS partner_address_requests_status_created_idx
  ON partner_address_requests (status, created_at DESC);

INSERT INTO shop_settings (key, value) VALUES
  ('partner_address_request_notification_recipients', 'support@369research.eu'),
  ('partner_address_request_notification_enabled', 'true')
ON CONFLICT (key) DO NOTHING;
