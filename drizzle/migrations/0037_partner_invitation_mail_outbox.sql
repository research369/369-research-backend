-- Additive, CEO-Ben invitation mail ledger only. No historical backfill.
CREATE TABLE IF NOT EXISTS partner_invitation_mail_activation (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  activation_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO partner_invitation_mail_activation(id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS partner_invitation_mail_events (
  id BIGSERIAL PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES partner_invitation_applications(id) ON DELETE CASCADE,
  kind VARCHAR(32) NOT NULL CHECK (kind IN ('registration_acknowledgement','approval')),
  recipient_email VARCHAR(320) NOT NULL,
  recipient_name VARCHAR(150) NOT NULL,
  partner_code VARCHAR(100),
  partner_number VARCHAR(100),
  subject TEXT NOT NULL,
  text_body TEXT NOT NULL,
  html_body TEXT NOT NULL,
  state VARCHAR(16) NOT NULL DEFAULT 'new' CHECK (state IN ('new','claimed','sent','failed','unknown')),
  attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 1),
  provider_id VARCHAR(200),
  last_error_code VARCHAR(64),
  claimed_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (application_id, kind)
);
CREATE INDEX IF NOT EXISTS partner_invitation_mail_new_idx
  ON partner_invitation_mail_events(state, id) WHERE state = 'new';
