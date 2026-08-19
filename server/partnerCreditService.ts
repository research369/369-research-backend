import type { PoolClient } from "pg";
import { getPool } from "./db.js";

export const PAID_ORDER_STATUSES = new Set([
  "bezahlt",
  "gepackt",
  "versendet",
  "zugestellt",
  "abgeholt",
]);

const roundMoney = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

const parseMoney = (value: unknown): number => {
  const result = Number(value ?? 0);
  if (!Number.isFinite(result)) {
    throw new Error("Ungültiger Geldbetrag in der Partnerguthabenlogik");
  }
  return roundMoney(result);
};

export function calculateCommissionBase(input: {
  subtotal: number;
  totalProductDiscount: number;
  creditUsed: number;
}): number {
  const subtotal = parseMoney(input.subtotal);
  const totalProductDiscount = parseMoney(input.totalProductDiscount);
  const creditUsed = parseMoney(input.creditUsed);

  if (subtotal < 0 || totalProductDiscount < 0 || creditUsed < 0 || creditUsed > totalProductDiscount) {
    throw new Error("Ungültige Rabatt- oder Guthabenwerte");
  }

  // Guthaben ist ein Zahlungsmittel. Es reduziert niemals die Basis für neues Guthaben.
  const regularProductDiscount = totalProductDiscount - creditUsed;
  return roundMoney(Math.max(0, subtotal - regularProductDiscount));
}

export function calculateCommissionAmount(input: {
  subtotal: number;
  totalProductDiscount: number;
  creditUsed: number;
  commissionPercent: number;
}): number {
  const commissionPercent = parseMoney(input.commissionPercent);
  if (commissionPercent < 0 || commissionPercent > 100) {
    throw new Error("Ungültiger Provisionssatz");
  }
  return roundMoney(calculateCommissionBase(input) * commissionPercent / 100);
}

async function beginLockedTransaction(): Promise<{ client: PoolClient; release: () => Promise<void> }> {
  const pool = await getPool();
  if (!pool) throw new Error("Datenbank nicht verfügbar");
  const client = await pool.connect();
  await client.query("BEGIN");
  return {
    client,
    release: async () => {
      client.release();
    },
  };
}

async function rollbackAndRelease(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
}

type OrderForCredit = {
  order_id: string;
  status: string;
  paid_at: Date | null;
  partner_code: string | null;
  partner_number: string | null;
  subtotal: string;
  discount: string;
  credit_used: string;
  partner_commission: string;
  first_name: string;
  last_name: string;
  email: string;
};

type PartnerForCredit = {
  id: number;
  name: string;
  code: string;
  partner_number: string;
  commission_percent: string;
  commission_type: "einmalig" | "dauerhaft";
  credit_balance: string;
};

async function lockOrder(client: PoolClient, orderId: string): Promise<OrderForCredit> {
  const result = await client.query<OrderForCredit>(
    `SELECT order_id, status, paid_at, partner_code, partner_number, subtotal, discount,
            credit_used, partner_commission, first_name, last_name, email
       FROM orders
      WHERE order_id = $1
      FOR UPDATE`,
    [orderId],
  );
  if (result.rows.length !== 1) throw new Error(`Bestellung ${orderId} nicht gefunden`);
  return result.rows[0];
}

async function lockPartnerForOrder(client: PoolClient, order: OrderForCredit): Promise<PartnerForCredit | null> {
  if (!order.partner_code && !order.partner_number) return null;

  const result = await client.query<PartnerForCredit>(
    `SELECT id, name, code, partner_number, commission_percent, commission_type, credit_balance
       FROM partners
      WHERE is_active = 1
        AND (upper(code) = upper($1) OR partner_number = $2)
      ORDER BY CASE WHEN upper(code) = upper($1) THEN 0 ELSE 1 END
      LIMIT 1
      FOR UPDATE`,
    [order.partner_code || "", order.partner_number || ""],
  );
  return result.rows[0] || null;
}

/**
 * Books an already persisted order's specified credit use once and only once.
 * The order row is the source of truth; duplicate requests observe the existing ledger entry.
 */
export async function redeemPartnerCreditForOrder(orderId: string): Promise<{ redeemed: number; balance: number; alreadyBooked: boolean }> {
  const { client } = await beginLockedTransaction();
  try {
    const order = await lockOrder(client, orderId);
    const creditUsed = parseMoney(order.credit_used);
    if (creditUsed === 0) {
      await client.query("COMMIT");
      client.release();
      return { redeemed: 0, balance: 0, alreadyBooked: true };
    }

    const partner = await lockPartnerForOrder(client, order);
    if (!partner) throw new Error(`Partner für Guthabeneinlösung bei Bestellung ${orderId} nicht gefunden`);

    const existing = await client.query<{ id: number }>(
      `SELECT id FROM partner_transactions
        WHERE partner_id = $1 AND order_id = $2 AND type = 'einloesung' AND status = 'normal'
        LIMIT 1`,
      [partner.id, orderId],
    );
    const balance = parseMoney(partner.credit_balance);
    if (existing.rows.length > 0) {
      await client.query("COMMIT");
      client.release();
      return { redeemed: creditUsed, balance, alreadyBooked: true };
    }

    if (creditUsed > balance) {
      throw new Error(`Nicht genügend Guthaben für Bestellung ${orderId}. Verfügbar: ${balance.toFixed(2)} €, benötigt: ${creditUsed.toFixed(2)} €`);
    }

    const newBalance = roundMoney(balance - creditUsed);
    await client.query(
      `UPDATE partners SET credit_balance = $1, updated_at = NOW() WHERE id = $2`,
      [newBalance.toFixed(2), partner.id],
    );
    await client.query(
      `INSERT INTO partner_transactions
        (partner_id, type, amount, balance_after, order_id, customer_name, description, status)
       VALUES ($1, 'einloesung', $2, $3, $4, $5, $6, 'normal')`,
      [
        partner.id,
        (-creditUsed).toFixed(2),
        newBalance.toFixed(2),
        orderId,
        `${order.first_name} ${order.last_name}`.trim(),
        `Guthaben eingelöst für Bestellung ${orderId}`,
      ],
    );

    await client.query("COMMIT");
    client.release();
    return { redeemed: creditUsed, balance: newBalance, alreadyBooked: false };
  } catch (error) {
    await rollbackAndRelease(client);
    throw error;
  }
}

/**
 * Credits a partner only after a payment-confirmed order. Repeated status updates are idempotent.
 */
export async function bookPaidPartnerCommission(orderId: string): Promise<{
  booked: boolean;
  amount: number;
  balance: number;
  reason: string;
}> {
  const { client } = await beginLockedTransaction();
  try {
    const order = await lockOrder(client, orderId);
    if (!PAID_ORDER_STATUSES.has(order.status) || !order.paid_at) {
      await client.query("COMMIT");
      client.release();
      return { booked: false, amount: 0, balance: 0, reason: "order_not_paid" };
    }

    const partner = await lockPartnerForOrder(client, order);
    if (!partner) {
      await client.query("COMMIT");
      client.release();
      return { booked: false, amount: 0, balance: 0, reason: "no_partner" };
    }

    const existing = await client.query<{ id: number }>(
      `SELECT id FROM partner_transactions
        WHERE partner_id = $1 AND order_id = $2 AND type = 'provision' AND status = 'normal'
        LIMIT 1`,
      [partner.id, orderId],
    );
    const existingBalance = parseMoney(partner.credit_balance);
    if (existing.rows.length > 0) {
      await client.query("COMMIT");
      client.release();
      return { booked: false, amount: parseMoney(order.partner_commission), balance: existingBalance, reason: "already_booked" };
    }

    const isOwnOrder = order.partner_number === partner.partner_number;
    if (!isOwnOrder && partner.commission_type === "einmalig") {
      const previousPaidOrder = await client.query<{ order_id: string }>(
        `SELECT order_id
           FROM orders
          WHERE upper(coalesce(partner_code, '')) = upper($1)
            AND lower(email) = lower($2)
            AND order_id <> $3
            AND status IN ('bezahlt', 'gepackt', 'versendet', 'zugestellt', 'abgeholt')
            AND paid_at IS NOT NULL
          LIMIT 1`,
        [partner.code, order.email, orderId],
      );
      if (previousPaidOrder.rows.length > 0) {
        await client.query("COMMIT");
        client.release();
        return { booked: false, amount: 0, balance: existingBalance, reason: "one_time_already_paid" };
      }
    }

    const amount = calculateCommissionAmount({
      subtotal: parseMoney(order.subtotal),
      totalProductDiscount: parseMoney(order.discount),
      creditUsed: parseMoney(order.credit_used),
      commissionPercent: parseMoney(partner.commission_percent),
    });
    if (amount <= 0) {
      await client.query("COMMIT");
      client.release();
      return { booked: false, amount: 0, balance: existingBalance, reason: "zero_base" };
    }

    const newBalance = roundMoney(existingBalance + amount);
    const label = isOwnOrder || partner.commission_type === "dauerhaft" ? "Guthaben" : "Auszahlung";
    await client.query(
      `UPDATE partners SET credit_balance = $1, updated_at = NOW() WHERE id = $2`,
      [newBalance.toFixed(2), partner.id],
    );
    await client.query(
      `INSERT INTO partner_transactions
        (partner_id, type, amount, balance_after, order_id, customer_name, description, status)
       VALUES ($1, 'provision', $2, $3, $4, $5, $6, 'normal')`,
      [
        partner.id,
        amount.toFixed(2),
        newBalance.toFixed(2),
        orderId,
        `${order.first_name} ${order.last_name}`.trim(),
        `Provision für bezahlte Bestellung ${orderId} (${order.first_name} ${order.last_name}) – ${label}`,
      ],
    );
    await client.query(
      `UPDATE orders SET partner_commission = $1, updated_at = NOW() WHERE order_id = $2`,
      [amount.toFixed(2), orderId],
    );

    await client.query("COMMIT");
    client.release();
    return { booked: true, amount, balance: newBalance, reason: "booked" };
  } catch (error) {
    await rollbackAndRelease(client);
    throw error;
  }
}
