-- Additive and idempotent. Run AFTER existing partners / kwk_accounts bootstrap.
ALTER TABLE partners ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0 CHECK (session_version >= 0);
ALTER TABLE kwk_accounts ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0 CHECK (session_version >= 0);

CREATE TABLE IF NOT EXISTS partner_password_resets (
  partner_id INTEGER PRIMARY KEY REFERENCES partners(id) ON DELETE CASCADE,
  token_hash VARCHAR(64) NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5)
);
CREATE TABLE IF NOT EXISTS kwk_account_password_resets (
  kwk_id INTEGER PRIMARY KEY REFERENCES kwk_accounts(id) ON DELETE CASCADE,
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5)
);
CREATE TABLE IF NOT EXISTS account_auth_rate_limits (
  bucket_hash VARCHAR(64) PRIMARY KEY,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts > 0)
);
CREATE INDEX IF NOT EXISTS account_auth_rate_limits_expiry_idx ON account_auth_rate_limits(window_started_at);
-- Do not copy legacy plaintext codes into the new trusted table. Remove only the
-- system-owned marker, preserving ordinary notes. No account-wide session bump.
UPDATE partners SET notes = NULLIF(REGEXP_REPLACE(COALESCE(notes, ''), '\|?__RESET_CODE__:[^|]*', '', 'g'), '')
 WHERE COALESCE(notes, '') LIKE '%__RESET_CODE__:%';
