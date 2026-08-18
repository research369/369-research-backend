import { getPool } from "./db.js";

/**
 * Additive, idempotent schema for the customer dossier.
 * Cases are never deleted from the WaWi UI. A resolved case remains part of
 * the customer/order timeline so future operators can reconstruct prior issues.
 */
export async function ensureCustomerDossierSchema(): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Datenbankverbindung für Kundenakte nicht verfügbar");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_tag_definitions (
      id SERIAL PRIMARY KEY,
      tag_key VARCHAR(80) NOT NULL UNIQUE,
      label VARCHAR(120) NOT NULL,
      color VARCHAR(32) NOT NULL DEFAULT 'slate',
      description TEXT,
      sort_order INTEGER NOT NULL DEFAULT 999,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS customer_issue_cases (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL,
      order_id VARCHAR(32),
      category VARCHAR(64) NOT NULL,
      severity VARCHAR(16) NOT NULL DEFAULT 'normal',
      status VARCHAR(24) NOT NULL DEFAULT 'open',
      title VARCHAR(240) NOT NULL,
      details TEXT NOT NULL,
      occurred_at TIMESTAMP NOT NULL DEFAULT NOW(),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      created_by VARCHAR(100) NOT NULL,
      resolved_at TIMESTAMP,
      resolved_by VARCHAR(100),
      resolution_note TEXT,
      context_snapshot_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS customer_issue_cases_customer_idx
      ON customer_issue_cases (customer_id, status, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS customer_issue_cases_order_idx
      ON customer_issue_cases (order_id, status, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS customer_issue_cases_status_idx
      ON customer_issue_cases (status, severity, occurred_at DESC);

    INSERT INTO customer_tag_definitions (tag_key, label, color, description, sort_order) VALUES
      ('neukunde', 'Neukunde', 'sky', 'Erste verbindliche Bestellung oder noch keine bezahlte Historie.', 10),
      ('wiederkehrend', 'Wiederkehrend', 'blue', 'Kunde mit mindestens einer früheren verbindlichen Bestellung.', 20),
      ('stammkunde', 'Stammkunde', 'emerald', 'Regelmäßig wiederkehrender Kunde.', 30),
      ('vielbesteller', 'Vielbesteller', 'violet', 'Kunde mit hoher Bestellfrequenz oder überdurchschnittlichem Umsatz.', 40),
      ('vip', 'VIP', 'amber', 'Manuell gepflegte besondere Betreuung oder Priorität.', 50),
      ('b2b', 'B2B', 'slate', 'Geschäftskunde oder Wiederverkäufer.', 60),
      ('adresshinweis', 'Adresshinweis', 'rose', 'Wiederkehrender oder bewusst bestätigter Adresshinweis.', 70),
      ('versandhinweis', 'Versandhinweis', 'rose', 'Frühere Versandabweichung oder besondere Versandbeachtung.', 80),
      ('servicehinweis', 'Servicehinweis', 'orange', 'Frühere Service-, Qualitäts- oder Schadensklärung.', 90)
    ON CONFLICT (tag_key) DO NOTHING;

    INSERT INTO shop_settings (key, value) VALUES
      ('customer_dossier_status_rules', '{"new_max_paid_orders":0,"returning_min_paid_orders":1,"regular_min_paid_orders":3,"frequent_min_paid_orders":6,"vip_min_total_spent":1000}'),
      ('customer_dossier_issue_categories', '["Versand nicht zugestellt","Ware beschädigt","Falscher Artikel","Adressproblem","Zahlungs-/Bestellproblem","Qualitäts-/Serviceproblem","Sonstiges"]'),
      ('customer_dossier_default_severity', 'normal')
    ON CONFLICT (key) DO NOTHING;
  `);

  console.log("[CustomerDossier] Schema, Tagkatalog und konfigurierbare Statusregeln bereit");
}
