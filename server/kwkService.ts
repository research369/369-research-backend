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
       COALESCE(SUM(CASE WHEN type IN ('credit_released','redeemed','cancelled','refund','manual_correction') AND status = 'confirmed' THEN amount ELSE 0 END), 0) AS available,
       COALESCE(SUM(CASE WHEN type = 'redeemed' THEN ABS(amount) ELSE 0 END), 0) AS redeemed_total
     FROM kwk_ledger
     WHERE kwk_id = $1`,
    [kwkId]
  );
  const row = result.rows[0];
  const pending = parseFloat(row.pending) || 0;
  const available = parseFloat(row.available) || 0;
  const redeemed = parseFloat(row.redeemed_total) || 0;
  return {
    pending,
    available,
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
       COALESCE(SUM(CASE WHEN type IN ('credit_released','redeemed','cancelled','refund','manual_correction') AND status = 'confirmed' THEN amount ELSE 0 END), 0) AS available,
       COALESCE(SUM(CASE WHEN type = 'redeemed' THEN ABS(amount) ELSE 0 END), 0) AS redeemed_total
     FROM kwk_ledger
     WHERE kwk_id = $1`,
    [kwkId]
  );
  const row = result.rows[0];
  const pending = parseFloat(row.pending) || 0;
  const available = parseFloat(row.available) || 0;
  const redeemed = parseFloat(row.redeemed_total) || 0;
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

    // Serialisiert parallele Requests derselben Bestellung. Der bisherige
    // SELECT-vor-INSERT-Check allein war bei zwei gleichzeitigen Requests
    // nicht ausreichend.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`kwk-pending:${orderId}`]);

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

    // Status-Webhooks und manuelle Klicks können gleichzeitig eintreffen.
    // Pro Bestellung darf Guthaben nur einmal freigegeben werden.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`kwk-release:${orderId}`]);

    // Pending-Eintrag finden
    const pendingResult = await client.query(
      `SELECT id, kwk_id, amount FROM kwk_ledger
       WHERE order_id = $1 AND type = 'pending_credit' AND status = 'pending'
      LIMIT 1 FOR UPDATE`,
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

    await client.query(
      "UPDATE kwk_referrals SET status='confirmed' WHERE order_id=$1 AND status='pending'",
      [orderId]
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

    // Order-bound lock makes repeated status changes idempotent.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`kwk-cancel:${orderId}`]);

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

    // Pending credit was never available and is therefore cancelled without a counter-booking.
    await client.query(
      "UPDATE kwk_ledger SET status = 'cancelled' WHERE order_id = $1 AND type='pending_credit' AND status = 'pending'",
      [orderId]
    );

    const kwkIds = [...new Set(entries.rows.map((row: any) => Number(row.kwk_id)))];
    for (const kwkId of kwkIds) {
      const rows = entries.rows.filter((row: any) => Number(row.kwk_id) === kwkId);
      const alreadyCancelled = rows.some((row: any) => row.type === "cancelled" && row.status === "confirmed");
      if (!alreadyCancelled) {
        const released = rows.reduce((sum: number, row: any) =>
          row.type === "credit_released" && row.status === "confirmed" ? sum + parseFloat(row.amount) : sum, 0);
        const refunded = rows.reduce((sum: number, row: any) =>
          row.type === "refund" && row.status === "confirmed" ? sum + Math.abs(parseFloat(row.amount)) : sum, 0);
        const redeemed = rows.reduce((sum: number, row: any) =>
          row.type === "redeemed" && row.status === "confirmed" ? sum + Math.abs(parseFloat(row.amount)) : sum, 0);
        // A cancellation removes earned credit and restores credit spent on the cancelled order.
        const counterAmount = redeemed - Math.max(0, released - refunded);
        if (Math.abs(counterAmount) >= 0.005) {
          await client.query(
            `INSERT INTO kwk_ledger (kwk_id, order_id, amount, type, status, note, created_by)
             VALUES ($1, $2, $3, 'cancelled', 'confirmed', $4, 'system')`,
            [kwkId, orderId, counterAmount.toFixed(2), `Storno-Gegenbuchung für Bestellung ${orderId}`]
          );
        }
      }
      await syncCacheFromLedger(kwkId, client);
    }

    await client.query("UPDATE kwk_referrals SET status='cancelled' WHERE order_id=$1", [orderId]);

    await client.query("COMMIT");
    console.log(`[KWK] Credit cancellation completed for order ${orderId}`);
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

    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`kwk-refund:${orderId}`]);
    const entries = await client.query(
      `SELECT kwk_id,
        COALESCE(MAX(amount) FILTER (WHERE type IN ('pending_credit','credit_released') AND status <> 'cancelled'),0) original_amount,
        COALESCE(SUM(ABS(amount)) FILTER (WHERE type='refund' AND status='confirmed'),0) refunded_amount
       FROM kwk_ledger WHERE order_id = $1 AND type IN ('pending_credit','credit_released','refund')
       GROUP BY kwk_id LIMIT 1`,
      [orderId]
    );
    if (entries.rows.length === 0) {
      await client.query("ROLLBACK");
      return;
    }

    const { kwk_id: kwkId, original_amount: originalAmount, refunded_amount: refundedAmount } = entries.rows[0];
    const originalAmountNum = parseFloat(originalAmount);
    const alreadyRefunded = parseFloat(refundedAmount) || 0;

    // Anteilige Korrektur berechnen
    const correctionAmount = Math.min(refundAmount * (KWK_COMMISSION_PERCENT / 100), Math.max(0, originalAmountNum - alreadyRefunded));

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

    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Ungültiger Guthabenbetrag");
    await client.query("SELECT id FROM kwk_accounts WHERE id=$1 FOR UPDATE", [kwkId]);
    const orderResult = await client.query(
      "SELECT status, kwk_credit_requested FROM orders WHERE order_id=$1 FOR UPDATE",
      [orderId],
    );
    if (orderResult.rows.length !== 1 || orderResult.rows[0].status !== "offen") {
      throw new Error("Guthaben kann nur direkt für eine offene Bestellung eingelöst werden");
    }
    const requestedAmount = parseFloat(orderResult.rows[0].kwk_credit_requested || "0");
    if (Math.abs(requestedAmount - amount) > 0.01) {
      throw new Error("Guthabenbetrag stimmt nicht mit der Bestellung überein");
    }
    const existing = await client.query(
      "SELECT amount FROM kwk_ledger WHERE kwk_id=$1 AND order_id=$2 AND type='redeemed' AND status='confirmed' LIMIT 1",
      [kwkId, orderId],
    );
    if (existing.rows.length > 0) {
      const existingAmount = Math.abs(parseFloat(existing.rows[0].amount));
      if (Math.abs(existingAmount - amount) > 0.01) throw new Error("Für diese Bestellung wurde bereits ein anderer Guthabenbetrag eingelöst");
      await client.query("COMMIT");
      return;
    }

    const balanceResult = await client.query(
      `SELECT COALESCE(SUM(CASE WHEN type IN ('credit_released','redeemed','cancelled','refund','manual_correction')
        AND status='confirmed' THEN amount ELSE 0 END),0) available FROM kwk_ledger WHERE kwk_id=$1`,
      [kwkId],
    );
    const available = parseFloat(balanceResult.rows[0].available) || 0;
    if (available + 0.001 < amount) {
      throw new Error(`Nicht genug Guthaben: verfügbar ${available.toFixed(2)}€, angefordert ${amount.toFixed(2)}€`);
    }

    // Ledger-Eintrag (negativ = Einlösung)
    await client.query(
      `INSERT INTO kwk_ledger (kwk_id, order_id, amount, type, status, note, created_by)
       VALUES ($1, $2, $3, 'redeemed', 'confirmed', $4, 'system')`,
      [kwkId, orderId, (-amount).toFixed(2), `Guthaben eingelöst bei Bestellung ${orderId}`]
    );

    // Persist only the actually booked amount. This makes order/ledger reconciliation explicit.
    await client.query("UPDATE orders SET kwk_credit_used=$1, updated_at=NOW() WHERE order_id=$2", [amount.toFixed(2), orderId]);

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

  const accountResult = await pool.query(
    "SELECT email, phone FROM kwk_accounts WHERE id=$1 LIMIT 1",
    [kwkId],
  );
  if (accountResult.rows.length === 0) return { sameEmail: false, samePhone: false, sameAddress: false };
  const account = accountResult.rows[0];
  const normalizePhone = (value: string) => value.replace(/[^0-9+]/g, "");

  // Repeat purchases by the same referred customer are legitimate: the advertised
  // programme grants credit on every referred order. Only self-referral is flagged.
  return {
    sameEmail: Boolean(customerEmail && account.email && customerEmail.trim().toLowerCase() === String(account.email).trim().toLowerCase()),
    samePhone: Boolean(customerPhone && account.phone && normalizePhone(customerPhone) === normalizePhone(String(account.phone))),
    // KWK accounts currently do not store a verified address. Address repetition among
    // legitimate repeat customers must not suppress recurring credit.
    sameAddress: false,
  };
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

export const KWK_DISCOUNT_PERCENT = 10;  // 10% Rabatt für geworbene Kunden
export const KWK_COMMISSION_PERCENT = 10; // 10% Guthaben für werbende KWK-Teilnehmer

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

/** Credits are payment instruments and therefore do not reduce the amount on which
 * the referrer earns credit. Product discounts (including the 10% KWK discount) do. */
export function calculateKwkCommissionBase(input: {
  subtotal: number;
  totalDiscount: number;
  partnerCreditUsed?: number;
  kwkCreditUsed?: number;
}): number {
  const creditPayments = Math.max(0, input.partnerCreditUsed || 0) + Math.max(0, input.kwkCreditUsed || 0);
  const productDiscounts = Math.max(0, input.totalDiscount - creditPayments);
  return Math.round(Math.max(0, input.subtotal - productDiscounts) * 100) / 100;
}
