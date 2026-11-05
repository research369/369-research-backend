import { getPool } from "./db.js";

/**
 * Isolierte Datenebene für einen vorführbaren KWK-Schauzugang.
 *
 * Diese Tabellen besitzen bewusst keine Foreign Keys auf orders, customers,
 * partners, invoices oder die produktiven KWK-Tabellen. Die API bietet nur
 * Login und lesende Dashboarddaten. Es gibt keinen Referral-, Checkout-,
 * Einlöse-, Auszahlungs- oder Admin-Schreibpfad für Demoaccounts.
 */

export const KWK_DEMO_REFERENCE_PREFIX = "DEMO-";

export type KwkDemoAccount = {
  id: number;
  email: string;
  name: string;
  demo_number: string;
  password_hash: string;
  created_at: Date | string;
};

const DEFAULT_KWK_DEMO_EMAIL = "pakkorandale@gmail.com";
const DEFAULT_KWK_DEMO_NAME = "Pakko Randale";
const DEFAULT_KWK_DEMO_NUMBER = "DEMO-KWK-369";
// Replaced during the controlled release with a bcrypt hash only; plaintext is
// never committed, logged or stored in the database.
const DEFAULT_KWK_DEMO_PASSWORD_HASH = "$2a$12$kEKQk/Ity5r/dZkp8wIqTukEjXATExropkjRiOHURopqjwEb0F542";

const DEFAULT_KWK_DEMO_REFERRALS = [
  ["DEMO-KWK-001", 9.99, 99.9, 9.99, "confirmed", "2026-09-04T10:15:00Z"],
  ["DEMO-KWK-002", 12, 120, 12, "confirmed", "2026-09-08T14:20:00Z"],
  ["DEMO-KWK-003", 14.9, 149, 14.9, "pending", "2026-09-12T09:42:00Z"],
  ["DEMO-KWK-004", 9.8, 98, 9.8, "confirmed", "2026-09-16T16:05:00Z"],
  ["DEMO-KWK-005", 13.5, 135, 13.5, "confirmed", "2026-09-20T11:37:00Z"],
  ["DEMO-KWK-006", 10, 100, 10, "confirmed", "2026-09-24T13:11:00Z"],
  ["DEMO-KWK-007", 11, 110, 11, "confirmed", "2026-09-29T15:48:00Z"],
  ["DEMO-KWK-008", 15, 150, 15, "pending", "2026-10-03T10:09:00Z"],
  ["DEMO-KWK-009", 10.5, 105, 10.5, "confirmed", "2026-10-07T12:30:00Z"],
  ["DEMO-KWK-010", 12.25, 122.5, 12.25, "confirmed", "2026-10-11T17:25:00Z"],
  ["DEMO-KWK-011", 11.7, 117, 11.7, "confirmed", "2026-10-15T09:55:00Z"],
  ["DEMO-KWK-012", 9.99, 99.9, 9.99, "pending", "2026-10-19T14:12:00Z"],
  ["DEMO-KWK-013", 13, 130, 13, "confirmed", "2026-10-23T11:03:00Z"],
  ["DEMO-KWK-014", 8.5, 85, 8.5, "confirmed", "2026-10-27T16:18:00Z"],
] as const;

const DEFAULT_KWK_DEMO_LEDGER = [
  ["DEMO-KWK-001", 9.99, "credit_released", "confirmed", "Beispielguthaben aus Empfehlung", "2026-09-04T10:15:00Z"],
  ["DEMO-KWK-002", 12, "credit_released", "confirmed", "Beispielguthaben aus Empfehlung", "2026-09-08T14:20:00Z"],
  ["DEMO-KWK-003", 14.9, "pending_credit", "pending", "Beispielguthaben wartet auf Freigabe", "2026-09-12T09:42:00Z"],
  ["DEMO-KWK-004", 9.8, "credit_released", "confirmed", "Beispielguthaben aus Empfehlung", "2026-09-16T16:05:00Z"],
  ["DEMO-KWK-005", 13.5, "credit_released", "confirmed", "Beispielguthaben aus Empfehlung", "2026-09-20T11:37:00Z"],
  ["DEMO-REDEEM-001", -20, "redeemed", "confirmed", "Nur Demo: Beispielguthaben eingesetzt", "2026-09-24T13:11:00Z"],
  ["DEMO-KWK-007", 11, "credit_released", "confirmed", "Beispielguthaben aus Empfehlung", "2026-09-29T15:48:00Z"],
  ["DEMO-KWK-008", 15, "pending_credit", "pending", "Beispielguthaben wartet auf Freigabe", "2026-10-03T10:09:00Z"],
  ["DEMO-KWK-009", 10.5, "credit_released", "confirmed", "Beispielguthaben aus Empfehlung", "2026-10-07T12:30:00Z"],
  ["DEMO-KWK-010", 12.25, "credit_released", "confirmed", "Beispielguthaben aus Empfehlung", "2026-10-11T17:25:00Z"],
  ["DEMO-KWK-011", 11.7, "credit_released", "confirmed", "Beispielguthaben aus Empfehlung", "2026-10-15T09:55:00Z"],
  ["DEMO-KWK-012", 9.99, "pending_credit", "pending", "Beispielguthaben wartet auf Freigabe", "2026-10-19T14:12:00Z"],
  ["DEMO-KWK-013", 13, "credit_released", "confirmed", "Beispielguthaben aus Empfehlung", "2026-10-23T11:03:00Z"],
  ["DEMO-KWK-014", 8.5, "credit_released", "confirmed", "Beispielguthaben aus Empfehlung", "2026-10-27T16:18:00Z"],
  ["DEMO-KWK-015", 12.6, "credit_released", "confirmed", "Beispielguthaben aus Empfehlung", "2026-10-29T09:40:00Z"],
] as const;

export function normalizeKwkDemoEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isKwkDemoReference(value: string): boolean {
  return value.startsWith(KWK_DEMO_REFERENCE_PREFIX);
}

export async function ensureKwkDemoSchema(): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Database not available");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS kwk_demo_accounts (
      id SERIAL PRIMARY KEY,
      email VARCHAR(320) NOT NULL UNIQUE,
      name VARCHAR(255) NOT NULL,
      demo_number VARCHAR(40) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      last_login TIMESTAMP,
      disabled_at TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS kwk_demo_ledger (
      id BIGSERIAL PRIMARY KEY,
      demo_account_id INTEGER NOT NULL REFERENCES kwk_demo_accounts(id) ON DELETE CASCADE,
      demo_reference VARCHAR(48) NOT NULL CHECK (demo_reference LIKE 'DEMO-%'),
      amount DECIMAL(10,2) NOT NULL,
      type VARCHAR(32) NOT NULL CHECK (type IN ('credit_released', 'pending_credit', 'redeemed')),
      status VARCHAR(20) NOT NULL CHECK (status IN ('confirmed', 'pending')),
      note TEXT NOT NULL DEFAULT 'Schau-Buchung',
      occurred_at TIMESTAMP NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kwk_demo_referrals (
      id BIGSERIAL PRIMARY KEY,
      demo_account_id INTEGER NOT NULL REFERENCES kwk_demo_accounts(id) ON DELETE CASCADE,
      demo_reference VARCHAR(48) NOT NULL UNIQUE CHECK (demo_reference LIKE 'DEMO-%'),
      discount_applied DECIMAL(10,2) NOT NULL CHECK (discount_applied >= 0),
      commission_base DECIMAL(10,2) NOT NULL CHECK (commission_base >= 0),
      commission_amount DECIMAL(10,2) NOT NULL CHECK (commission_amount >= 0),
      status VARCHAR(20) NOT NULL CHECK (status IN ('confirmed', 'pending')),
      occurred_at TIMESTAMP NOT NULL
    );

    CREATE INDEX IF NOT EXISTS kwk_demo_ledger_account_occurred_idx
      ON kwk_demo_ledger(demo_account_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS kwk_demo_referrals_account_occurred_idx
      ON kwk_demo_referrals(demo_account_id, occurred_at DESC);
  `);

  await seedDefaultKwkDemoAccount(pool);
}

async function seedDefaultKwkDemoAccount(pool: NonNullable<Awaited<ReturnType<typeof getPool>>>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('kwk-demo-default-bootstrap-v1'))");

    // No update on restart: a demo account is only provisioned when absent.
    const existing = await client.query<{ id: number }>(
      "SELECT id FROM kwk_demo_accounts WHERE email = $1 LIMIT 1",
      [DEFAULT_KWK_DEMO_EMAIL],
    );
    if (existing.rows[0]) {
      await client.query("COMMIT");
      return;
    }

    const account = await client.query<{ id: number }>(
      `INSERT INTO kwk_demo_accounts (email, name, demo_number, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [DEFAULT_KWK_DEMO_EMAIL, DEFAULT_KWK_DEMO_NAME, DEFAULT_KWK_DEMO_NUMBER, DEFAULT_KWK_DEMO_PASSWORD_HASH],
    );
    const demoAccountId = account.rows[0].id;

    for (const [reference, discount, base, commission, status, occurredAt] of DEFAULT_KWK_DEMO_REFERRALS) {
      await client.query(
        `INSERT INTO kwk_demo_referrals
          (demo_account_id, demo_reference, discount_applied, commission_base, commission_amount, status, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [demoAccountId, reference, discount, base, commission, status, occurredAt],
      );
    }

    for (const [reference, amount, type, status, note, occurredAt] of DEFAULT_KWK_DEMO_LEDGER) {
      await client.query(
        `INSERT INTO kwk_demo_ledger
          (demo_account_id, demo_reference, amount, type, status, note, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [demoAccountId, reference, amount, type, status, note, occurredAt],
      );
    }

    await client.query("COMMIT");
    console.log("[KWK Demo] Default showcase account provisioned with 15 isolated demo movements");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getKwkDemoAccountByEmail(email: string): Promise<KwkDemoAccount | null> {
  const pool = await getPool();
  if (!pool) throw new Error("Database not available");

  const result = await pool.query<KwkDemoAccount>(
    `SELECT id, email, name, demo_number, password_hash, created_at
       FROM kwk_demo_accounts
      WHERE email = $1 AND disabled_at IS NULL
      LIMIT 1`,
    [normalizeKwkDemoEmail(email)],
  );
  return result.rows[0] ?? null;
}

export async function getKwkDemoAccountById(id: number): Promise<Omit<KwkDemoAccount, "password_hash"> | null> {
  const pool = await getPool();
  if (!pool) throw new Error("Database not available");

  const result = await pool.query<Omit<KwkDemoAccount, "password_hash">>(
    `SELECT id, email, name, demo_number, created_at
       FROM kwk_demo_accounts
      WHERE id = $1 AND disabled_at IS NULL
      LIMIT 1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function recordKwkDemoLogin(id: number): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Database not available");
  await pool.query("UPDATE kwk_demo_accounts SET last_login = NOW() WHERE id = $1", [id]);
}

export async function getKwkDemoBalance(id: number): Promise<{
  pending: number;
  available: number;
  redeemed: number;
}> {
  const pool = await getPool();
  if (!pool) throw new Error("Database not available");

  const result = await pool.query<{
    pending: string;
    available: string;
    redeemed_total: string;
  }>(
    `SELECT
       COALESCE(SUM(CASE WHEN type = 'pending_credit' AND status = 'pending' THEN amount ELSE 0 END), 0) AS pending,
       COALESCE(SUM(CASE WHEN type IN ('credit_released', 'redeemed') AND status = 'confirmed' THEN amount ELSE 0 END), 0) AS available,
       COALESCE(SUM(CASE WHEN type = 'redeemed' AND status = 'confirmed' THEN ABS(amount) ELSE 0 END), 0) AS redeemed_total
       FROM kwk_demo_ledger
      WHERE demo_account_id = $1`,
    [id],
  );

  const row = result.rows[0];
  return {
    pending: Number.parseFloat(row?.pending ?? "0") || 0,
    available: Number.parseFloat(row?.available ?? "0") || 0,
    redeemed: Number.parseFloat(row?.redeemed_total ?? "0") || 0,
  };
}

export async function listKwkDemoLedger(id: number, limit: number, offset: number) {
  const pool = await getPool();
  if (!pool) throw new Error("Database not available");

  const result = await pool.query(
    `SELECT id, demo_reference AS order_id, amount, type, status, note, occurred_at AS created_at
       FROM kwk_demo_ledger
      WHERE demo_account_id = $1
      ORDER BY occurred_at DESC, id DESC
      LIMIT $2 OFFSET $3`,
    [id, limit, offset],
  );
  return result.rows;
}

export async function listKwkDemoReferrals(id: number, limit: number, offset: number) {
  const pool = await getPool();
  if (!pool) throw new Error("Database not available");

  const [entries, total] = await Promise.all([
    pool.query(
      `SELECT id, demo_reference AS order_id, discount_applied, commission_base, commission_amount, status, occurred_at AS created_at
         FROM kwk_demo_referrals
        WHERE demo_account_id = $1
        ORDER BY occurred_at DESC, id DESC
        LIMIT $2 OFFSET $3`,
      [id, limit, offset],
    ),
    pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM kwk_demo_referrals WHERE demo_account_id = $1", [id]),
  ]);

  return {
    referrals: entries.rows,
    total: Number.parseInt(total.rows[0]?.count ?? "0", 10) || 0,
  };
}
