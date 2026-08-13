import { getPool } from "./db.js";

/**
 * Additive, idempotent schema for duplicate-review records.
 * It never alters customers, orders, stock, payment data, or historic records.
 */
export async function ensureCustomerIntegritySchema(): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Datenbankverbindung für Dublettenprüfung nicht verfügbar");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS duplicate_check_runs (
      id SERIAL PRIMARY KEY,
      trigger VARCHAR(24) NOT NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'completed',
      customer_findings INTEGER NOT NULL DEFAULT 0,
      order_findings INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      started_at TIMESTAMP NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMP,
      created_by VARCHAR(100)
    );

    CREATE TABLE IF NOT EXISTS duplicate_findings (
      id SERIAL PRIMARY KEY,
      run_id INTEGER NOT NULL,
      entity_type VARCHAR(16) NOT NULL,
      primary_record_id VARCHAR(64) NOT NULL,
      candidate_record_id VARCHAR(64) NOT NULL,
      confidence INTEGER NOT NULL,
      reasons TEXT NOT NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'open',
      resolution_note TEXT,
      resolved_by VARCHAR(100),
      resolved_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS duplicate_findings_run_idx ON duplicate_findings (run_id);
    CREATE INDEX IF NOT EXISTS duplicate_findings_status_idx ON duplicate_findings (status);
  `);

  console.log("[Customer Integrity] Dubletten-Prüfschema bereit");
}
