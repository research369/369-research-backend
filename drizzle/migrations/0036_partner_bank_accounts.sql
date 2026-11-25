-- Partner-banking only, additive and idempotent. Never migrate existing bank,
-- commission, partner profile, payout or invitation data.
CREATE TABLE IF NOT EXISTS partner_bank_accounts (
  partner_id INTEGER PRIMARY KEY REFERENCES partners(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  encrypted_payload TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS partner_bank_account_events (
  id BIGSERIAL PRIMARY KEY,
  actor_partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  event VARCHAR(32) NOT NULL CHECK (event = 'bank_account_saved'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Same existing DB-backed auth limiter schema. This makes namespace readiness
-- independent of account-security migrations (which ALTER existing tables).
CREATE TABLE IF NOT EXISTS account_auth_rate_limits (
  bucket_hash VARCHAR(64) PRIMARY KEY,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts > 0)
);
CREATE INDEX IF NOT EXISTS account_auth_rate_limits_expiry_idx ON account_auth_rate_limits(window_started_at);
