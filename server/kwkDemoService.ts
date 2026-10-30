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
