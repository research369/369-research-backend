-- ============================================================================
-- Checkout-Fehleralarmierung
-- Additiv und idempotent. Diese Tabelle ergänzt failed_orders um den
-- Alarmzustand; sie verändert keine Bestellung, keinen Bestand und keine
-- Kunden- oder Zahlungsdaten.
-- ============================================================================

CREATE TABLE IF NOT EXISTS checkout_failure_alerts (
  id SERIAL PRIMARY KEY,
  attempted_order_id VARCHAR(64) NOT NULL UNIQUE,
  alert_status VARCHAR(24) NOT NULL DEFAULT 'pending',
  alert_attempts INTEGER NOT NULL DEFAULT 0,
  provider_message_id VARCHAR(128),
  last_error TEXT,
  last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
  alert_sent_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT checkout_failure_alert_status_check
    CHECK (alert_status IN ('pending', 'sending', 'sent', 'failed'))
);
