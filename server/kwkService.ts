/**
 * KWK Service – Kunden-werben-Kunden Business-Logik
 *
 * ISOLIERTES MODUL: Diese Datei enthält ausschließlich KWK-Logik.
 * Keine bestehenden Services werden verändert.
 *
 * Funktionen:
 *   isKwkEnabled()           – Feature Flag prüfen
 *   generateKwkNumber()      – KWK-100001, KWK-100002, ...
 *   generateReferralCode()   – Eindeutiger Empfehlungslink-Code
 *   bookPendingCredit()      – Guthaben pending buchen (atomar)
 *   releaseCredit()          – Guthaben freigeben wenn Bestellung final
 *   cancelCredit()           – Guthaben entfernen bei Storno
 *   partialRefundCredit()    – Guthaben anteilig korrigieren
 *   redeemCredit()           – Guthaben einlösen (Checkout)
 *   computeBalanceFromLedger() – Guthaben aus Ledger berechnen (führende Quelle)
 *   detectFraudFlags()       – Missbrauchsschutz
 *   auditLog()               – Admin-Audit-Trail
 */

import { ENV } from "./env.js";
import { getPool, getDb } from "./db.js";
import crypto from "crypto";

// ── Feature Flag ──────────────────────────────────────────────────────────

/**
 * Prüft ob das KWK-Modul aktiviert ist.
 * Priorität: ENV-Variable > shop_settings in DB
 */
export async function isKwkEnabled(): Promise<boolean> {
  // ENV-Variable hat höchste Priorität
  const envFlag = process.env.FEATURE_KWK_ENABLED;
  if (envFlag !== undefined) {
    return envFlag === "true" || envFlag === "1";
  }
  // Fallback: shop_settings in DB
  try {
    const pool = await getPool();
  if (!pool) throw new Error("Database not available");
    const result = await pool.query(
      "SELECT value FROM shop_settings WHERE key = 'kwk_enabled' LIMIT 1"
    );
    if (result.rows.length > 0) {
      return result.rows[0].value === "true" || result.rows[0].value === "1";
    }
  } catch {
    // Bei DB-Fehler: sicher deaktiviert
  }
  return false;
}

// ── Nummern-Generierung ───────────────────────────────────────────────────

/**
 * Erzeugt die nächste KWK-Nummer: KWK-100001, KWK-100002, ...
 * Kollisionssicher durch DB-Abfrage.
 */
export async function generateKwkNumber(): Promise<string> {
  const pool = await getPool();
  if (!pool) throw new Error("Database not available");
  const result = await pool.query(
    "SELECT kwk_number FROM kwk_accounts ORDER BY id DESC LIMIT 1"
  );
  if (result.rows.length === 0) {
    return "KWK-100001";
  }
  const last = result.rows[0].kwk_number as string;
  const num = parseInt(last.replace("KWK-", ""), 10);
  return `KWK-${String(num + 1).padStart(6, "0")}`;
}

/**
 * Erzeugt einen eindeutigen Referral-Code.
 * Standard: KWK-Nummer (z.B. KWK-100001)
 * Kann später auf Kurzcode umgestellt werden.
 */
export function generateReferralCode(kwkNumber: string): string {
  return kwkNumber;
}

// ── Guthaben-Ledger ───────────────────────────────────────────────────────

/**
 * Berechnet Guthabenstände direkt aus dem Ledger (führende Datenquelle).
 * Cache-Felder in kwk_accounts sind nur Performance-Optimierung.
 */
export async function computeBalanceFromLedger(kwkId: number): Promise<{
  pending: number;
  available: number;
  redeemed: number;
}> {
  const pool = await getPool();
  if (!pool) throw new Error("Database not available");
  const result = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN type = 'pending_credit' AND status = 'pending' THEN amount ELSE 0 END), 0) AS pending,
       COALESCE(SUM(CASE WHEN type = 'credit_released' AND status = 'confirmed' THEN amount ELSE 0 END), 0) AS released,
       COALESCE(SUM(CASE WHEN type = 'redeemed' THEN ABS(amount) ELSE 0 END), 0) AS redeemed_total
     FROM kwk_ledger
     WHERE kwk_id = $1`,
    [kwkId]
  );
  const row = result.rows[0];
  const pending = parseFloat(row.pending) || 0;
  const released = parseFloat(row.released) || 0;
  const redeemed = parseFloat(row.redeemed_total) || 0;
  return {
    pending,
    available: Math.max(0, released - redeemed),
    redeemed,
  };
}

/**
 * Aktualisiert den Cache in kwk_accounts aus dem Ledger.
 * Wird nach jeder Ledger-Buchung aufgerufen.
 */
async function syncCacheFromLedger(kwkId: number, client: any): Promise<void> {
  const result = await client.query(
    `SELECT
       COALESCE(SUM(CASE WHEN type = 'pending_credit' AND status = 'pending' THEN amount ELSE 0 END), 0) AS pending,
       COALESCE(SUM(CASE WHEN type = 'credit_released' AND status = 'confirmed' THEN amount ELSE 0 END), 0) AS released,
       COALESCE(SUM(CASE WHEN type = 'redeemed' THEN ABS(amount) ELSE 0 END), 0) AS redeemed_total
     FROM kwk_ledger
     WHERE kwk_id = $1`,
    [kwkId]
  );
  const row = result.rows[0];
  const pending = parseFloat(row.pending) || 0;
  const released = parseFloat(row.released) || 0;
  const redeemed = parseFloat(row.redeemed_total) || 0;
  const available = Math.max(0, released - redeemed);
  await client.query(
    `UPDATE kwk_accounts SET
       credit_pending = $1,
       credit_available = $2,
       credit_redeemed = $3,
       updated_at = NOW()
     WHERE id = $4`,
    [pending.toFixed(2), available.toFixed(2), redeemed.toFixed(2), kwkId]
  );
}

/**
 * Idempotenz-Check: Existiert für diese Bestellung bereits eine Gutschrift?
 */
export async function hasExistingCredit(orderId: string): Promise<boolean> {
  const pool = await getPool();
  if (!pool) throw new Error("Database not available");
  const result = await pool.query(
    "SELECT id FROM kwk_ledger WHERE order_id = $1 AND type = 'pending_credit' LIMIT 1",
    [orderId]
  );
  return result.rows.length > 0;
}

/**
 * Pending-Guthaben buchen (atomar).
 * Wird beim Erstellen der Bestellung aufgerufen.
 * Idempotent: Keine Doppelbuchung für dieselbe Bestellung.
 */
export async function bookPendingCredit(
  kwkId: number,
  orderId: string,
  amount: number
): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Database not available");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Idempotenz-Check
    const existing = await client.query(
      "SELECT id FROM kwk_ledger WHERE order_id = $1 AND type = 'pending_credit' LIMIT 1",
      [orderId]
    );
    if (existing.rows.length > 0) {
      console.log(`[KWK] Pending credit already exists for order ${orderId} – skipping`);
      await client.query("ROLLBACK");
      return;
    }

    // Ledger-Eintrag (unveränderlich)
    await client.query(
      `INSERT INTO kwk_ledger (kwk_id, order_id, amount, type, status, note, created_by)
       VALUES ($1, $2, $3, 'pending_credit', 'pending', $4, 'system')`,
      [kwkId, orderId, amount.toFixed(2), `Pending-Gutschrift für Bestellung ${orderId}`]
    );

    // Cache synchronisieren
    await syncCacheFromLedger(kwkId, client);

    await client.query("COMMIT");
    console.log(`[KWK] Pending credit booked: ${amount.toFixed(2)}€ for KWK-${kwkId}, order ${orderId}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Guthaben freigeben wenn Bestellung final (versendet/zugestellt).
 * Gegenbuchung: pending_credit → credit_released
 */
export async function releaseCredit(orderId: string): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Database not available");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Pending-Eintrag finden
    const pendingResult = await client.query(
      `SELECT id, kwk_id, amount FROM kwk_ledger
       WHERE order_id = $1 AND type = 'pending_credit' AND status = 'pending'
       LIMIT 1`,
      [orderId]
    );
    if (pendingResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return; // Kein pending credit für diese Bestellung
    }
    const { id: pendingId, kwk_id: kwkId, amount } = pendingResult.rows[0];

    // Pending-Eintrag als confirmed markieren
    await client.query(
      "UPDATE kwk_ledger SET status = 'confirmed' WHERE id = $1",
      [pendingId]
    );

    // Neuer credit_released Eintrag
    await client.query(
      `INSERT INTO kwk_ledger (kwk_id, order_id, amount, type, status, note, created_by)
       VALUES ($1, $2, $3, 'credit_released', 'confirmed', $4, 'system')`,
      [kwkId, orderId, amount, `Guthaben freigegeben für Bestellung ${orderId}`]
    );

    // Cache synchronisieren
    await syncCacheFromLedger(kwkId, client);

    await client.query("COMMIT");
    console.log(`[KWK] Credit released: ${amount}€ for order ${orderId}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Guthaben entfernen bei Storno.
 * Gegenbuchung: neuer 'cancelled' Eintrag (Ledger bleibt unveränderlich).
 */
export async function cancelCredit(orderId: string): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Database not available");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Alle Einträge für diese Bestellung finden
    const entries = await client.query(
      `SELECT id, kwk_id, amount, type, status FROM kwk_ledger
       WHERE order_id = $1 AND status != 'cancelled'`,
      [orderId]
    );
    if (entries.rows.length === 0) {
      await client.query("ROLLBACK");
      return;
    }

    const kwkId = entries.rows[0].kwk_id;
    const totalAmount = entries.rows.reduce((sum: number, r: any) => {
      if (r.type === "pending_credit" || r.type === "credit_released") {
        return sum + parseFloat(r.amount);
      }
      return sum;
    }, 0);

    if (totalAmount > 0) {
      // Gegenbuchung (negativ)
      await client.query(
        `INSERT INTO kwk_ledger (kwk_id, order_id, amount, type, status, note, created_by)
         VALUES ($1, $2, $3, 'cancelled', 'confirmed', $4, 'system')`,
        [kwkId, orderId, (-totalAmount).toFixed(2), `Storno: Gutschrift rückgängig für Bestellung ${orderId}`]
      );

      // Bestehende pending Einträge als cancelled markieren
      await client.query(
        "UPDATE kwk_ledger SET status = 'cancelled' WHERE order_id = $1 AND status = 'pending'",
        [orderId]
      );

      // Cache synchronisieren
      await syncCacheFromLedger(kwkId, client);
    }

    await client.query("COMMIT");
    console.log(`[KWK] Credit cancelled for order ${orderId}: -${totalAmount.toFixed(2)}€`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Guthaben anteilig korrigieren bei Teilrückerstattung.
 */
export async function partialRefundCredit(
  orderId: string,
  refundAmount: number
): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Database not available");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const entries = await client.query(
      `SELECT kwk_id, amount FROM kwk_ledger
       WHERE order_id = $1 AND type IN ('pending_credit', 'credit_released') AND status != 'cancelled'
       LIMIT 1`,
      [orderId]
    );
    if (entries.rows.length === 0) {
      await client.query("ROLLBACK");
      return;
    }

    const { kwk_id: kwkId, amount: originalAmount } = entries.rows[0];
    const originalAmountNum = parseFloat(originalAmount);

    // Anteilige Korrektur berechnen
    const correctionAmount = Math.min(refundAmount * 0.06, originalAmountNum);

    if (correctionAmount > 0) {
      await client.query(
        `INSERT INTO kwk_ledger (kwk_id, order_id, amount, type, status, note, created_by)
         VALUES ($1, $2, $3, 'refund', 'confirmed', $4, 'system')`,
        [
          kwkId,
          orderId,
          (-correctionAmount).toFixed(2),
          `Teilrückerstattung: Gutschrift anteilig korrigiert für Bestellung ${orderId} (-${correctionAmount.toFixed(2)}€)`,
        ]
      );
      await syncCacheFromLedger(kwkId, client);
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Guthaben einlösen (Checkout).
 * Nur verfügbares Guthaben (nicht pending).
 * Nur auf Produkte, nicht auf Versand.
 */
export async function redeemCredit(
  kwkId: number,
  orderId: string,
  amount: number
): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Database not available");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Verfügbares Guthaben prüfen
    const balance = await computeBalanceFromLedger(kwkId);
    if (balance.available < amount) {
      throw new Error(`Nicht genug Guthaben: verfügbar ${balance.available.toFixed(2)}€, angefordert ${amount.toFixed(2)}€`);
    }

    // Ledger-Eintrag (negativ = Einlösung)
    await client.query(
      `INSERT INTO kwk_ledger (kwk_id, order_id, amount, type, status, note, created_by)
       VALUES ($1, $2, $3, 'redeemed', 'confirmed', $4, 'system')`,
      [kwkId, orderId, (-amount).toFixed(2), `Guthaben eingelöst bei Bestellung ${orderId}`]
    );

    // Cache synchronisieren
    await syncCacheFromLedger(kwkId, client);

    await client.query("COMMIT");
    console.log(`[KWK] Credit redeemed: ${amount.toFixed(2)}€ by KWK-${kwkId} for order ${orderId}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ── Missbrauchsschutz ─────────────────────────────────────────────────────

/**
 * Prüft ob eine Bestellung Missbrauchsmerkmale aufweist.
 * Markiert auffällige Fälle – blockiert nicht automatisch.
 */
export async function detectFraudFlags(
  kwkId: number,
  customerEmail: string,
  customerPhone: string,
  addressHash: string
): Promise<{ sameEmail: boolean; samePhone: boolean; sameAddress: boolean }> {
  const pool = await getPool();
  if (!pool) throw new Error("Database not available");

  const flags = { sameEmail: false, samePhone: false, sameAddress: false };

  // Gleiche E-Mail bei diesem KWK-Account
  const emailCheck = await pool.query(
    "SELECT id FROM kwk_referrals WHERE kwk_id = $1 AND customer_email = $2 LIMIT 1",
    [kwkId, customerEmail.toLowerCase()]
  );
  flags.sameEmail = emailCheck.rows.length > 0;

  // Gleiche Telefonnummer
  const phoneCheck = await pool.query(
    "SELECT id FROM kwk_referrals WHERE kwk_id = $1 AND customer_phone = $2 LIMIT 1",
    [kwkId, customerPhone]
  );
  flags.samePhone = phoneCheck.rows.length > 0;

  // Gleiche Lieferadresse (Hash)
  if (addressHash) {
    const addrCheck = await pool.query(
      "SELECT id FROM kwk_referrals WHERE kwk_id = $1 AND customer_address_hash = $2 LIMIT 1",
      [kwkId, addressHash]
    );
    flags.sameAddress = addrCheck.rows.length > 0;
  }

  return flags;
}

/**
 * SHA-256 Hash einer Adresse für Duplikat-Erkennung.
 */
export function hashAddress(street: string, zip: string, city: string): string {
  const normalized = `${street.toLowerCase().trim()}|${zip.trim()}|${city.toLowerCase().trim()}`;
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

// ── Audit-Logging ─────────────────────────────────────────────────────────

/**
 * Admin-Aktion protokollieren.
 */
export async function auditLog(
  kwkId: number | null,
  adminUser: string,
  action: string,
  oldValue: string | null,
  newValue: string | null,
  note?: string
): Promise<void> {
  try {
    const pool = await getPool();
  if (!pool) throw new Error("Database not available");
    await pool.query(
      `INSERT INTO kwk_audit_log (kwk_id, admin_user, action, old_value, new_value, note)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [kwkId, adminUser, action, oldValue, newValue, note || null]
    );
  } catch (err) {
    console.warn("[KWK] Audit log failed (non-fatal):", err);
  }
}

// ── Login-Sicherheit ──────────────────────────────────────────────────────

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

/**
 * Login-Versuch registrieren und Rate Limiting prüfen.
 * Gibt zurück ob der Account gesperrt ist.
 */
export async function checkLoginRateLimit(kwkId: number): Promise<{
  locked: boolean;
  lockedUntil: Date | null;
}> {
  const pool = await getPool();
  if (!pool) throw new Error("Database not available");
  const result = await pool.query(
    "SELECT login_attempts, login_locked_until FROM kwk_accounts WHERE id = $1",
    [kwkId]
  );
  if (result.rows.length === 0) return { locked: false, lockedUntil: null };

  const { login_attempts, login_locked_until } = result.rows[0];

  if (login_locked_until && new Date(login_locked_until) > new Date()) {
    return { locked: true, lockedUntil: new Date(login_locked_until) };
  }

  return { locked: false, lockedUntil: null };
}

export async function recordFailedLogin(kwkId: number): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Database not available");
  const result = await pool.query(
    "SELECT login_attempts FROM kwk_accounts WHERE id = $1",
    [kwkId]
  );
  if (result.rows.length === 0) return;

  const attempts = (result.rows[0].login_attempts || 0) + 1;
  const lockUntil = attempts >= MAX_LOGIN_ATTEMPTS
    ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000)
    : null;

  await pool.query(
    "UPDATE kwk_accounts SET login_attempts = $1, login_locked_until = $2, updated_at = NOW() WHERE id = $3",
    [attempts, lockUntil, kwkId]
  );
}

export async function resetLoginAttempts(kwkId: number): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Database not available");
  await pool.query(
    "UPDATE kwk_accounts SET login_attempts = 0, login_locked_until = NULL, last_login = NOW(), updated_at = NOW() WHERE id = $1",
    [kwkId]
  );
}

// ── KWK-Discount-Berechnung ───────────────────────────────────────────────

export const KWK_DISCOUNT_PERCENT = 6;   // 6% Rabatt für geworbene Kunden
export const KWK_COMMISSION_PERCENT = 6; // 6% Guthaben für werbende KWK-Teilnehmer

/**
 * Berechnet den KWK-Rabatt auf den Produktwarenwert (ohne Versand).
 */
export function calculateKwkDiscount(productSubtotal: number): number {
  return Math.round(productSubtotal * (KWK_DISCOUNT_PERCENT / 100) * 100) / 100;
}

/**
 * Berechnet das KWK-Guthaben für den werbenden Teilnehmer.
 * Basis: Produktwarenwert nach allen anderen Rabatten (ohne Versand).
 */
export function calculateKwkCommission(netProductAmount: number): number {
  return Math.round(netProductAmount * (KWK_COMMISSION_PERCENT / 100) * 100) / 100;
}
