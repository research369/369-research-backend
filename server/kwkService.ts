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
import { isKwkCreditReleaseEligible } from "./kwkCreditEligibility.js";
import crypto from "crypto";
import { calculateCommissionBase, parsePartnerMoney, withPartnerFinancialTransaction, type PartnerCreditQueryClient } from "./partnerCreditService.js";

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
 * Der übergebene Client bleibt Teil derselben Transaktion, damit Ledger und
 * Anzeige-Caches nie auseinanderlaufen.
 */
export async function syncKwkAccountCache(kwkId: number, client: any): Promise<void> {
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

    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Ungültiger Guthabenbetrag");
    const order = await client.query("SELECT status, cancelled_at FROM orders WHERE order_id=$1 FOR UPDATE", [orderId]);
    if (order.rows.length !== 1 || order.rows[0].status === "storniert" || order.rows[0].cancelled_at) throw new Error("KWK_CANCELLED_OR_MISSING_ORDER");
    await client.query("SELECT id FROM kwk_accounts WHERE id=$1 FOR UPDATE", [kwkId]);
    // Serialisiert parallele Requests derselben Bestellung. Der bisherige
    // SELECT-vor-INSERT-Check allein war bei zwei gleichzeitigen Requests
    // nicht ausreichend.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`kwk-order:${orderId}`]);

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
    await syncKwkAccountCache(kwkId, client);

    await client.query("COMMIT");
    console.log(`[KWK] Pending credit booked: ${amount.toFixed(2)}€ for KWK-${kwkId}, order ${orderId}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export type KwkCreditReleaseResult = {
  released: boolean;
  reason: "released" | "order_not_found" | "order_not_paid" | "no_pending_credit" | "ambiguous_pending_credit";
};

/**
 * Guthaben ausschließlich nach gespeichertem Zahlungsnachweis freigeben.
 * Gegenbuchung: pending_credit → credit_released. Die Prüfung liegt bewusst
 * in dieser Ledger-Funktion, damit kein Aufrufer versehentlich Guthaben für
 * offene oder stornierte Bestellungen freigeben kann.
 */
export async function releaseCredit(
  orderId: string,
  options: { source?: "payment_status" | "paid_credit_reconciliation" } = {},
): Promise<KwkCreditReleaseResult> {
  const pool = await getPool();
  if (!pool) throw new Error("Database not available");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Status-Webhooks und manuelle Klicks können gleichzeitig eintreffen.
    // Pro Bestellung darf Guthaben nur einmal freigegeben werden.
    // The order is the payment source of truth. Status alone is not enough:
    // a paid fulfilment status must carry the persisted payment timestamp.
    const orderResult = await client.query<{
      status: string;
      paid_at: Date | null;
      cancelled_at: Date | null;
    }>(
      `SELECT status, paid_at, cancelled_at
         FROM orders
        WHERE order_id = $1
        FOR UPDATE`,
      [orderId],
    );
    if (orderResult.rows.length !== 1) {
      await client.query("COMMIT");
      return { released: false, reason: "order_not_found" };
    }
    const order = orderResult.rows[0];
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`kwk-order:${orderId}`]);
    if (!isKwkCreditReleaseEligible({
      status: order.status,
      paidAt: order.paid_at,
      cancelledAt: order.cancelled_at,
    })) {
      await client.query("COMMIT");
      return { released: false, reason: "order_not_paid" };
    }

    // Pending-Eintrag finden
    const pendingResult = await client.query(
      `SELECT id, kwk_id, amount FROM kwk_ledger
       WHERE order_id = $1 AND type = 'pending_credit' AND status = 'pending'
       ORDER BY id ASC
       FOR UPDATE`,
      [orderId]
    );
    if (pendingResult.rows.length === 0) {
      await client.query("COMMIT");
      return { released: false, reason: "no_pending_credit" };
    }
    if (pendingResult.rows.length > 1) {
      await client.query("COMMIT");
      console.error(`[KWK] Mehrdeutige Pending-Gutschrift für ${orderId}; keine automatische Freigabe vorgenommen`);
      return { released: false, reason: "ambiguous_pending_credit" };
    }
    const { id: pendingId, kwk_id: kwkId, amount } = pendingResult.rows[0];
    if (!Number.isFinite(Number(amount)) || Number(amount) < 0) throw new Error("KWK_HISTORICAL_SIGN_REVIEW");
    await client.query("SELECT id FROM kwk_accounts WHERE id=$1 FOR UPDATE", [kwkId]);

    // Pending-Eintrag als confirmed markieren
    await client.query(
      "UPDATE kwk_ledger SET status = 'confirmed' WHERE id = $1",
      [pendingId]
    );

    // Neuer credit_released Eintrag
    await client.query(
      `INSERT INTO kwk_ledger (kwk_id, order_id, amount, type, status, note, created_by)
       VALUES ($1, $2, $3, 'credit_released', 'confirmed', $4, 'system')`,
      [
        kwkId,
        orderId,
        amount,
        options.source === "paid_credit_reconciliation"
          ? `Guthaben nachbezahlt freigegeben nach Zahlungsabgleich für Bestellung ${orderId}`
          : `Guthaben freigegeben für bezahlte Bestellung ${orderId}`,
      ]
    );

    await client.query(
      "UPDATE kwk_referrals SET status='confirmed' WHERE order_id=$1 AND status='pending'",
      [orderId]
    );

    // Cache synchronisieren
    await syncKwkAccountCache(kwkId, client);

    if (options.source === "paid_credit_reconciliation") {
      await client.query(
        `INSERT INTO kwk_audit_log (kwk_id, admin_user, action, old_value, new_value, note)
         VALUES ($1, 'system', 'paid_credit_reconciled', 'pending', 'confirmed', $2)`,
        [kwkId, `Historische, als bezahlt belegte KWK-Bestellung ${orderId} automatisch nachgezogen`],
      );
    }

    await client.query("COMMIT");
    console.log(`[KWK] Credit released: ${amount}€ for order ${orderId}`);
    return { released: true, reason: "released" };
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
export async function cancelCreditInTransaction(orderId: string, client: PartnerCreditQueryClient): Promise<void> {
  const orders = await client.query("SELECT status, kwk_credit_owner_id FROM orders WHERE order_id=$1 FOR UPDATE", [orderId]);
  if (orders.rows.length !== 1 || orders.rows[0].status !== "storniert") throw new Error("KWK_ORDER_NOT_CANCELLED");
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`kwk-order:${orderId}`]);
  const entries = await client.query("SELECT id, kwk_id, amount, type, status FROM kwk_ledger WHERE order_id=$1 ORDER BY id FOR UPDATE", [orderId]);
  const referral = await client.query("SELECT kwk_id FROM kwk_referrals WHERE order_id=$1", [orderId]);
  const earningsOwners = [...new Set(entries.rows.filter(e => ["pending_credit", "credit_released", "refund"].includes(e.type)).map(e => Number(e.kwk_id)))];
  const redemptionOwners = [...new Set(entries.rows.filter(e => e.type === "redeemed").map(e => Number(e.kwk_id)))];
  if (earningsOwners.length > 1 || redemptionOwners.length > 1
    || (referral.rows.length && earningsOwners.some(id => id !== Number(referral.rows[0].kwk_id)))
    || (orders.rows[0].kwk_credit_owner_id && redemptionOwners.some(id => id !== Number(orders.rows[0].kwk_credit_owner_id)))) throw new Error("KWK_OWNER_CONFLICT_REVIEW");
  // Unknown legacy redemption owner is evidenced by its original ledger row, NEVER guessed by name.
  for (const e of entries.rows) {
    const amount = parsePartnerMoney(e.amount);
    if ((["pending_credit", "credit_released"].includes(e.type) && amount < 0) || (["redeemed", "refund"].includes(e.type) && amount >= 0)) throw new Error("KWK_HISTORICAL_SIGN_REVIEW");
  }
  const ownerIds = [...new Set(entries.rows.map(e => Number(e.kwk_id)))].sort((a,b) => a-b);
  for (const id of ownerIds) {
    const account = await client.query("SELECT id FROM kwk_accounts WHERE id=$1 FOR UPDATE", [id]);
    if (account.rows.length !== 1) throw new Error("KWK_ORIGINAL_OWNER_MISSING_REVIEW");
  }
  await client.query("UPDATE kwk_ledger SET status='cancelled' WHERE order_id=$1 AND type='pending_credit' AND status='pending'", [orderId]);
  for (const id of ownerIds) {
    const rows = entries.rows.filter(e => Number(e.kwk_id) === id);
    const cancellations = rows.filter(e => e.type === "cancelled" && e.status === "confirmed");
    if (cancellations.length > 1) throw new Error("KWK_CANCELLATION_CONFLICT_REVIEW");
    if (!cancellations.length) {
      const net = rows.reduce((sum,e) => ["credit_released", "refund", "redeemed"].includes(e.type) && e.status === "confirmed" ? sum + parsePartnerMoney(e.amount) : sum, 0);
      // Even zero net gets an immutable cancellation marker: replay cannot later restore credit.
      await client.query(`INSERT INTO kwk_ledger(kwk_id,order_id,amount,type,status,note,created_by)
        VALUES($1,$2,$3,'cancelled','confirmed',$4,'system')`, [id, orderId, (-net).toFixed(2), `Storno-Gegenbuchung für Bestellung ${orderId}`]);
    }
    await syncKwkAccountCache(id, client);
  }
  await client.query("UPDATE kwk_referrals SET status='cancelled' WHERE order_id=$1", [orderId]);
}
export async function cancelCredit(orderId: string, client?: PartnerCreditQueryClient): Promise<void> {
  return withPartnerFinancialTransaction(c => cancelCreditInTransaction(orderId,c), client);
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
    if (!Number.isFinite(refundAmount) || refundAmount <= 0) throw new Error("Ungültiger Erstattungsbetrag");
    const order = await client.query("SELECT status, cancelled_at FROM orders WHERE order_id=$1 FOR UPDATE", [orderId]);
    if (order.rows.length !== 1 || order.rows[0].status === "storniert" || order.rows[0].cancelled_at) throw new Error("KWK_CANCELLED_OR_MISSING_ORDER");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`kwk-order:${orderId}`]);
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
    await client.query("SELECT id FROM kwk_accounts WHERE id=$1 FOR UPDATE", [kwkId]);
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
      await syncKwkAccountCache(kwkId, client);
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
export async function redeemCreditInTransaction(kwkId: number, orderId: string, amount: number, client: PartnerCreditQueryClient): Promise<void> {
  if (!Number.isFinite(amount) || amount <= 0 || parsePartnerMoney(amount) !== amount) throw new Error("Ungültiger Guthabenbetrag");
  const orderResult = await client.query("SELECT status, paid_at, shipped_at, cancelled_at, kwk_credit_requested, kwk_credit_owner_id, subtotal, discount, credit_used, kwk_credit_used FROM orders WHERE order_id=$1 FOR UPDATE", [orderId]);
  if (orderResult.rows.length !== 1) throw new Error("KWK_ORDER_NOT_FOUND");
  const order = orderResult.rows[0];
  if (Number(order.kwk_credit_owner_id) !== kwkId || !order.kwk_credit_owner_id) throw new Error("KWK_ORDER_CREDIT_OWNER_REQUIRED");
  if (order.status === "storniert" || order.cancelled_at) throw new Error("KWK_CANCELLED_ORDER");
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`kwk-order:${orderId}`]);
  const account = await client.query("SELECT id FROM kwk_accounts WHERE id=$1 AND status='aktiv' AND deleted_at IS NULL FOR UPDATE", [kwkId]);
  if (account.rows.length !== 1) throw new Error("KWK-Konto ist nicht aktiv");
  if (parsePartnerMoney(order.kwk_credit_requested) !== amount) throw new Error("Guthabenbetrag stimmt nicht mit der Bestellung überein");
  const goods = calculateCommissionBase({ subtotal: parsePartnerMoney(order.subtotal), totalProductDiscount: parsePartnerMoney(order.discount), creditUsed: parsePartnerMoney(order.credit_used) + parsePartnerMoney(order.kwk_credit_used) });
  if (amount > goods - parsePartnerMoney(order.credit_used)) throw new Error("KWK_CREDIT_EXCEEDS_REMAINING_GOODS");
  const existing = await client.query("SELECT kwk_id, amount, status FROM kwk_ledger WHERE order_id=$1 AND type='redeemed' FOR UPDATE", [orderId]);
  if (existing.rows.length) {
    if (existing.rows.length !== 1 || Number(existing.rows[0].kwk_id) !== kwkId || existing.rows[0].status !== "confirmed" || parsePartnerMoney(existing.rows[0].amount) !== -amount) throw new Error("KWK_REDEMPTION_CONFLICT_REVIEW");
    return;
  }
  if (order.status !== "offen" || order.paid_at || order.shipped_at) throw new Error("Guthaben kann nur direkt für eine offene unbezahlte Bestellung eingelöst werden");
  const balance = await client.query(`SELECT COALESCE(SUM(amount) FILTER(WHERE type IN ('credit_released','redeemed','cancelled','refund','manual_correction') AND status='confirmed'),0) AS available FROM kwk_ledger WHERE kwk_id=$1`, [kwkId]);
  const available = parsePartnerMoney(balance.rows[0].available);
  if (available < amount) throw new Error("KWK_GUTHABEN_NICHT_AUSREICHEND");
  await client.query(`INSERT INTO kwk_ledger(kwk_id,order_id,amount,type,status,note,created_by) VALUES($1,$2,$3,'redeemed','confirmed',$4,'system')`, [kwkId, orderId, (-amount).toFixed(2), `Guthaben eingelöst bei Bestellung ${orderId}`]);
  await client.query("UPDATE orders SET kwk_credit_used=$1, updated_at=NOW() WHERE order_id=$2", [amount.toFixed(2), orderId]);
  await syncKwkAccountCache(kwkId, client);
}
export async function redeemCredit(kwkId: number, orderId: string, amount: number, client?: PartnerCreditQueryClient): Promise<void> {
  return withPartnerFinancialTransaction(c => redeemCreditInTransaction(kwkId,orderId,amount,c),client);
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
