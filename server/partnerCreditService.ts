import { hasOtherPaidCodeOrder, partnerPaidCodeContactKey } from "./partnerCodeHistory.js";
import type { QueryResultRow } from "pg";
import { getPool } from "./db.js";

/** Transaction-bound parameterized queries; supplied callers own commit/rollback. */
export type PartnerCreditQueryClient = {
  query<Row extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
};
export const PAID_ORDER_STATUSES = new Set(["bezahlt", "gepackt", "versendet", "zugestellt", "abgeholt"]);
export function partnerCommissionBlockReason(order: { status: string; paid_at: unknown; shipped_at: unknown }): "order_not_paid" | "order_not_shipped" | null {
  if (!order.paid_at || !PAID_ORDER_STATUSES.has(order.status)) return "order_not_paid";
  if (!order.shipped_at || !["versendet", "zugestellt"].includes(order.status)) return "order_not_shipped";
  return null;
}
export const roundPartnerMoney = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
export function parsePartnerMoney(value: unknown): number {
  const result = Number(value ?? 0);
  if (!Number.isFinite(result)) throw new Error("Ungültiger Geldbetrag in der Partnerguthabenlogik");
  return roundPartnerMoney(result);
}
const roundMoney = roundPartnerMoney;
const parseMoney = parsePartnerMoney;
export function calculateCommissionBase(input: { subtotal: number; totalProductDiscount: number; creditUsed: number }): number {
  const subtotal = parseMoney(input.subtotal), discount = parseMoney(input.totalProductDiscount), credit = parseMoney(input.creditUsed);
  if (subtotal < 0 || discount < 0 || credit < 0 || credit > discount || discount - credit > subtotal) throw new Error("Ungültige Rabatt- oder Guthabenwerte");
  return roundMoney(subtotal - (discount - credit));
}
export function calculateCommissionAmount(input: { subtotal: number; totalProductDiscount: number; creditUsed: number; commissionPercent: number }): number {
  const percent = parseMoney(input.commissionPercent);
  if (percent < 0 || percent > 100) throw new Error("Ungültiger Provisionssatz");
  return roundMoney(calculateCommissionBase(input) * percent / 100);
}
/** Explicit persisted, verified order-bound overrides keep their established amount. */
export function resolveCommissionAmount(input: { subtotal: number; totalProductDiscount: number; creditUsed: number; commissionPercent: number }, explicitAmount?: number): number {
  if (explicitAmount === undefined) return calculateCommissionAmount(input);
  const amount = parseMoney(explicitAmount);
  if (amount < 0) throw new Error("Ungültiger expliziter Guthabenbetrag");
  return amount;
}
export async function withPartnerFinancialTransaction<T>(work: (client: PartnerCreditQueryClient) => Promise<T>, supplied?: PartnerCreditQueryClient): Promise<T> {
  if (supplied) return work(supplied);
  const pool = await getPool();
  if (!pool) throw new Error("Datenbank nicht verfügbar");
  const client = await pool.connect();
  try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
type OrderForCredit = QueryResultRow & {
  order_id: string; status: string; paid_at: Date | null; shipped_at: Date | null; cancelled_at: Date | null;
  partner_source_id: number | null; partner_code: string | null; partner_number: string | null;
  partner_program_snapshot: string | null; partner_settlement_method_snapshot: string | null;
  partner_commission_policy_snapshot: string | null; partner_commission_percent_snapshot: string | null;
  partner_commission_base_snapshot: string | null; subtotal: string; discount: string; credit_used: string;
  kwk_credit_used: string; partner_commission: string; first_name: string; last_name: string; email: string;
};
type PartnerForCredit = QueryResultRow & { id: number; code: string; partner_number: string; commission_percent: string; commission_type: string; credit_balance: string; program_key: string; is_active: number };
async function lockOrder(client: PartnerCreditQueryClient, orderId: string): Promise<OrderForCredit> {
  const result = await client.query<OrderForCredit>(`SELECT order_id, status, paid_at, shipped_at, cancelled_at,
    partner_source_id, partner_code, partner_number, partner_program_snapshot, partner_settlement_method_snapshot,
    partner_commission_policy_snapshot, partner_commission_percent_snapshot, partner_commission_base_snapshot,
    subtotal, discount, credit_used, kwk_credit_used, partner_commission, first_name, last_name, email
    FROM orders WHERE order_id=$1 FOR UPDATE`, [orderId]);
  if (result.rows.length !== 1) throw new Error("Bestellung nicht gefunden");
  return result.rows[0];
}
/** Exact stored ID wins; no fallback to a different owner and no name matching. */
async function lockPartnerForOrder(client: PartnerCreditQueryClient, order: OrderForCredit): Promise<PartnerForCredit | null> {
  if (!order.partner_source_id && !order.partner_code && !order.partner_number) return null;
  const result = await client.query<PartnerForCredit>(`SELECT id, code, partner_number, commission_percent, commission_type, program_key, credit_balance, is_active
    FROM partners WHERE ($3::int IS NOT NULL AND id=$3) OR ($3::int IS NULL AND (
      partner_number=NULLIF($2,'') OR EXISTS (SELECT 1 FROM partner_codes pc WHERE pc.partner_id=partners.id
      AND pc.code_normalized=upper(regexp_replace($1,'[[:space:]]+','','g'))))) ORDER BY id FOR UPDATE`,
    [order.partner_code || "", order.partner_number || "", order.partner_source_id]);
  if (result.rows.length > 1) throw new Error("PARTNER_OWNER_CONFLICT_REVIEW");
  const partner = result.rows[0];
  if (!partner) return null;
  if (order.partner_number && order.partner_number !== partner.partner_number) throw new Error("PARTNER_OWNER_CONFLICT_REVIEW");
  if (partner.is_active !== 1) return null;
  return partner;
}
export async function redeemPartnerCreditInTransaction(orderId: string, client: PartnerCreditQueryClient): Promise<{ redeemed: number; balance: number; alreadyBooked: boolean }> {
  const order = await lockOrder(client, orderId);
  const creditUsed = parseMoney(order.credit_used);
  if (creditUsed < 0) throw new Error("PARTNER_NEGATIVE_CREDIT_REVIEW");
  if (order.status === "storniert" || order.cancelled_at) throw new Error("PARTNER_CANCELLED_ORDER");
  if (creditUsed === 0) return { redeemed: 0, balance: 0, alreadyBooked: true };
  const partner = await lockPartnerForOrder(client, order);
  if (!partner || !order.partner_number || order.partner_number !== partner.partner_number) throw new Error("PARTNER_CREDIT_OWNER_REQUIRED");
  if (order.partner_settlement_method_snapshot !== "shop_credit") throw new Error("PARTNER_CREDIT_POLICY_REVIEW");
  const program = await client.query(`SELECT settlement_method, allow_self_order_credit, active FROM partner_programs WHERE key=$1 FOR SHARE`, [partner.program_key]);
  if (program.rows.length !== 1 || !program.rows[0].active || program.rows[0].settlement_method !== "shop_credit" || !program.rows[0].allow_self_order_credit) throw new Error("PARTNER_CREDIT_POLICY_NOT_ALLOWED");
  const goods = calculateCommissionBase({ subtotal: parseMoney(order.subtotal), totalProductDiscount: parseMoney(order.discount), creditUsed: creditUsed + parseMoney(order.kwk_credit_used) });
  if (creditUsed > goods) throw new Error("PARTNER_CREDIT_EXCEEDS_GOODS");
  const existing = await client.query(`SELECT id, partner_id, amount, status FROM partner_transactions WHERE order_id=$1 AND type='einloesung' FOR UPDATE`, [orderId]);
  const balance = parseMoney(partner.credit_balance);
  if (existing.rows.length) {
    if (existing.rows.length !== 1 || Number(existing.rows[0].partner_id) !== partner.id || existing.rows[0].status !== "normal" || parseMoney(existing.rows[0].amount) !== -creditUsed) throw new Error("PARTNER_REDEMPTION_CONFLICT_REVIEW");
    return { redeemed: creditUsed, balance, alreadyBooked: true };
  }
  if (order.status !== "offen" || order.paid_at || order.shipped_at) throw new Error("PARTNER_PAYMENT_ALREADY_CONFIRMED");
  if (creditUsed > balance) throw new Error("PARTNER_GUTHABEN_NICHT_AUSREICHEND");
  const newBalance = roundMoney(balance - creditUsed);
  await client.query("UPDATE partners SET credit_balance=$1, updated_at=NOW() WHERE id=$2", [newBalance.toFixed(2), partner.id]);
  await client.query(`INSERT INTO partner_transactions (partner_id,type,amount,balance_after,order_id,customer_name,description,status)
    VALUES($1,'einloesung',$2,$3,$4,$5,$6,'normal')`, [partner.id, (-creditUsed).toFixed(2), newBalance.toFixed(2), orderId, `${order.first_name} ${order.last_name}`.trim(), `Guthaben eingelöst für Bestellung ${orderId}`]);
  return { redeemed: creditUsed, balance: newBalance, alreadyBooked: false };
}
export async function redeemPartnerCreditForOrder(orderId: string, client?: PartnerCreditQueryClient) {
  return withPartnerFinancialTransaction(c => redeemPartnerCreditInTransaction(orderId, c), client);
}
/** Same-tx optional adapter, also used by existing standalone payment/dispatch flows. */
export async function bookPaidPartnerCommission(orderId: string, client?: PartnerCreditQueryClient): Promise<{ booked: boolean; amount: number; balance: number; reason: string }> {
  return withPartnerFinancialTransaction(async c => {
    const order = await lockOrder(c, orderId);
    const blocked = partnerCommissionBlockReason(order);
    if (blocked || order.cancelled_at) return { booked: false, amount: 0, balance: 0, reason: blocked || "order_cancelled" };
    if (order.partner_commission_policy_snapshot === "first_paid_code_order" && !order.partner_number) {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [partnerPaidCodeContactKey(order.partner_code || "", order.email)]);
    }
    const partner = await lockPartnerForOrder(c, order);
    if (!partner) return { booked: false, amount: 0, balance: 0, reason: "no_partner" };
    const existingBalance = parseMoney(partner.credit_balance);
    const existing = await c.query(`SELECT partner_id, amount, status FROM partner_transactions WHERE order_id=$1 AND type='provision' FOR UPDATE`, [orderId]);
    if (existing.rows.length) {
      if (existing.rows.some(r => Number(r.partner_id) !== partner.id)) throw new Error("PARTNER_OWNER_CONFLICT_REVIEW");
      return { booked: false, amount: parseMoney(order.partner_commission), balance: existingBalance, reason: "already_booked" };
    }
    const own = !!order.partner_number && order.partner_number === partner.partner_number;
    const policy = order.partner_commission_policy_snapshot || (partner.commission_type === "einmalig" ? "first_paid_code_order" : "each_paid_code_order");
    if (policy === "none" || order.partner_settlement_method_snapshot === "none") return { booked: false, amount: 0, balance: existingBalance, reason: "program_without_commission" };
    if (!own && policy === "first_paid_code_order") {
      // Includes legacy one-time policies and shares the code/contact lock across booking callers.
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [partnerPaidCodeContactKey(order.partner_code || partner.code, order.email)]);
      if (await hasOtherPaidCodeOrder((text, values) => c.query(text, values), order.partner_code || partner.code, order.email, orderId)) return { booked: false, amount: 0, balance: existingBalance, reason: "one_time_already_paid" };
    }
    const overrides = await c.query(`SELECT amount, reason FROM partner_order_credit_overrides WHERE order_id=$1 AND is_active=1 FOR UPDATE`, [orderId]);
    if (overrides.rows.length > 1) throw new Error("PARTNER_OVERRIDE_CONFLICT_REVIEW");
    const override = overrides.rows[0];
    const snapshotAmount = order.partner_program_snapshot ? parseMoney(order.partner_commission) : undefined;
    const amount = resolveCommissionAmount({
      subtotal: order.partner_commission_base_snapshot == null ? parseMoney(order.subtotal) : parseMoney(order.partner_commission_base_snapshot),
      totalProductDiscount: order.partner_commission_base_snapshot == null ? parseMoney(order.discount) : 0,
      creditUsed: order.partner_commission_base_snapshot == null ? parseMoney(order.credit_used) + parseMoney(order.kwk_credit_used) : 0,
      commissionPercent: order.partner_commission_percent_snapshot == null ? parseMoney(partner.commission_percent) : parseMoney(order.partner_commission_percent_snapshot),
    }, override ? parseMoney(override.amount) : snapshotAmount);
    if (amount <= 0) return { booked: false, amount: 0, balance: existingBalance, reason: "zero_base" };
    const balance = roundMoney(existingBalance + amount);
    await c.query("UPDATE partners SET credit_balance=$1, updated_at=NOW() WHERE id=$2", [balance.toFixed(2), partner.id]);
    await c.query(`INSERT INTO partner_transactions (partner_id,type,amount,balance_after,order_id,customer_name,description,status)
      VALUES($1,'provision',$2,$3,$4,$5,$6,'normal')`, [partner.id, amount.toFixed(2), balance.toFixed(2), orderId, `${order.first_name} ${order.last_name}`.trim(), override ? `Manuell freigegebenes Guthaben – ${override.reason}` : `Provision für bezahlte und versendete Bestellung ${orderId}`]);
    await c.query("UPDATE orders SET partner_commission=$1, updated_at=NOW() WHERE order_id=$2", [amount.toFixed(2), orderId]);
    return { booked: true, amount, balance, reason: "booked" };
  }, client);
}
/** Normal/storniert report model: exclude originals; NEVER append a normal negative correction. */
export async function reversePartnerFinancialEntriesForCancelledOrder(orderId: string, client?: PartnerCreditQueryClient): Promise<{ reversed: number; balance: number; reason: string }> {
  return withPartnerFinancialTransaction(async c => {
    const order = await lockOrder(c, orderId);
    if (order.status !== "storniert") throw new Error("PARTNER_ORDER_NOT_CANCELLED");
    const owners = await c.query(`SELECT DISTINCT partner_id FROM partner_transactions WHERE order_id=$1 AND type IN ('provision','einloesung') ORDER BY partner_id`, [orderId]);
    if (!owners.rows.length) return { reversed: 0, balance: 0, reason: "no_entries" };
    if (owners.rows.length !== 1 || (order.partner_source_id && Number(owners.rows[0].partner_id) !== order.partner_source_id)) throw new Error("PARTNER_OWNER_CONFLICT_REVIEW");
    const partnerId = Number(owners.rows[0].partner_id);
    const partners = await c.query(`SELECT id, partner_number, credit_balance FROM partners WHERE id=$1 FOR UPDATE`, [partnerId]);
    if (partners.rows.length !== 1 || (order.partner_number && order.partner_number !== partners.rows[0].partner_number)) throw new Error("PARTNER_OWNER_CONFLICT_REVIEW");
    const entries = await c.query(`SELECT id, amount, type, status FROM partner_transactions WHERE order_id=$1 AND type IN ('provision','einloesung') FOR UPDATE`, [orderId]);
    if (entries.rows.some(e => (e.type === 'provision' && parseMoney(e.amount) < 0) || (e.type === 'einloesung' && parseMoney(e.amount) >= 0))) throw new Error("PARTNER_HISTORICAL_SIGN_REVIEW");
    const normal = entries.rows.filter(e => e.status === "normal");
    const currentBalance = parseMoney(partners.rows[0].credit_balance);
    if (!normal.length) return { reversed: 0, balance: currentBalance, reason: "already_reversed_or_empty" };
    const net = roundMoney(normal.reduce((sum, e) => sum + parseMoney(e.amount), 0));
    const balance = roundMoney(currentBalance - net);
    // Rows are already locked above. Scalar order binding also works with the Drizzle adapter.
    await c.query(`UPDATE partner_transactions SET status='storniert', admin_note=COALESCE(admin_note,$1)
      WHERE order_id=$2 AND type IN ('provision','einloesung') AND status='normal'`, [`Automatischer Auftragsstorno ${orderId}`, orderId]);
    await c.query("UPDATE partners SET credit_balance=$1, updated_at=NOW() WHERE id=$2", [balance.toFixed(2), partnerId]);
    return { reversed: roundMoney(-net), balance, reason: "reversed" };
  }, client);
}
