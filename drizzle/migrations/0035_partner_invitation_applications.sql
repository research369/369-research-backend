-- Additive CEO Ben invitation workflow only. No existing accounts/settings/ledgers changed.
CREATE TABLE IF NOT EXISTS partner_invitation_applications (
  id SERIAL PRIMARY KEY,
  registration_key_hash VARCHAR(64) NOT NULL UNIQUE,
  email VARCHAR(320) NOT NULL UNIQUE CHECK (email = LOWER(BTRIM(email))),
  name VARCHAR(150) NOT NULL,
  phone VARCHAR(60) NOT NULL,
  company VARCHAR(200),
  password_hash TEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  terms_version VARCHAR(40) NOT NULL CHECK (terms_version = 'ben-10-10-v1'),
  inviter_note TEXT NOT NULL DEFAULT 'Personally invited by CEO Ben',
  terms_accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by VARCHAR(100),
  linked_partner_id INTEGER UNIQUE,
  CONSTRAINT partner_invitation_approval_link_chk CHECK (
    (status = 'approved' AND linked_partner_id IS NOT NULL AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)
    OR (status IN ('pending', 'rejected') AND linked_partner_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS partner_invitation_pending_created_idx
  ON partner_invitation_applications(created_at, id) WHERE status = 'pending';
