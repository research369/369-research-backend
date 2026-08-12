import { getPool } from "./db.js";

/**
 * Additive, idempotent migration for the CRM communication ledger.
 * Existing customer_communications records remain untouched.
 */
export async function ensureCrmCommunicationSchema(): Promise<void> {
  const pool = await getPool();
  if (!pool) {
    throw new Error("Datenbankverbindung für CRM-Kommunikation nicht verfügbar");
  }

  await pool.query(`
    ALTER TABLE customer_communications
      ADD COLUMN IF NOT EXISTS sender_email VARCHAR(320),
      ADD COLUMN IF NOT EXISTS reply_to VARCHAR(320),
      ADD COLUMN IF NOT EXISTS resend_email_id VARCHAR(100),
      ADD COLUMN IF NOT EXISTS resend_message_id VARCHAR(500),
      ADD COLUMN IF NOT EXISTS delivery_status VARCHAR(32),
      ADD COLUMN IF NOT EXISTS delivery_status_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS error_message TEXT,
      ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(200),
      ADD COLUMN IF NOT EXISTS direction VARCHAR(16) NOT NULL DEFAULT 'outbound',
      ADD COLUMN IF NOT EXISTS source VARCHAR(32) NOT NULL DEFAULT 'manual';

    CREATE UNIQUE INDEX IF NOT EXISTS customer_communications_resend_email_id_uq
      ON customer_communications (resend_email_id)
      WHERE resend_email_id IS NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS customer_communications_idempotency_key_uq
      ON customer_communications (idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE INDEX IF NOT EXISTS customer_communications_order_created_idx
      ON customer_communications (order_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS communication_events (
      id SERIAL PRIMARY KEY,
      communication_id INTEGER NOT NULL,
      provider VARCHAR(50) NOT NULL DEFAULT 'resend',
      provider_event_id VARCHAR(150) NOT NULL UNIQUE,
      event_type VARCHAR(80) NOT NULL,
      occurred_at TIMESTAMP NOT NULL,
      payload TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS communication_events_communication_created_idx
      ON communication_events (communication_id, created_at DESC);
  `);

  console.log("[CRM] Kommunikationsschema bereit");
}
