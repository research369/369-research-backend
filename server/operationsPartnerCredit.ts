import { createHash } from "node:crypto";
import { getPool } from "./db.js";
import { parsePartnerMoney as money, roundPartnerMoney as round, withPartnerFinancialTransaction, type PartnerCreditQueryClient } from "./partnerCreditService.js";

export type OperationsPartnerCorrection = {
  partnerId: number; amount: number; expectedBalance: number;
  description: string; requestId: string; allowNegativeBalance: boolean;
};

/** Explicit correction, never a payout, automatic commission or silent balance replacement. */
export async function correctOperationsPartnerCredit(input: OperationsPartnerCorrection, actor: string, client?: PartnerCreditQueryClient) {
  if (!Number.isSafeInteger(input.partnerId) || input.partnerId < 1
      || !Number.isFinite(input.amount) || input.amount === 0 || Math.abs(input.amount) > 9999
      || money(input.amount) !== input.amount || !Number.isFinite(input.expectedBalance)
      || money(input.expectedBalance) !== input.expectedBalance || !input.description.trim()
      || input.description.trim().length > 500 || !actor.trim()
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestId)) {
    throw new Error("PARTNER_CORRECTION_INPUT_INVALID");
  }
  const description = input.description.trim();
  const canonical = JSON.stringify({ ...input, description, actor });
  const hash = createHash("sha256").update(canonical).digest("hex");
  const prefix = `ops-credit:${input.requestId}:`;
  const evidence = `${prefix}${hash}:actor=${actor}`;
  return withPartnerFinancialTransaction(async c => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`ops-credit:${input.requestId}`]);
    const duplicate = await c.query("SELECT id, partner_id, amount, balance_after, description, admin_note, status FROM partner_transactions WHERE type='korrektur' AND admin_note LIKE $1", [`${prefix}%`]);
    if (duplicate.rows.length) {
      const row = duplicate.rows[0];
      if (duplicate.rows.length !== 1 || Number(row.partner_id) !== input.partnerId
          || money(row.amount) !== input.amount || row.description !== description
          || row.admin_note !== evidence || row.status !== "normal") {
        throw new Error("PARTNER_CORRECTION_PAYLOAD_CONFLICT");
      }
      return { success: true, transactionId: Number(row.id), adjustment: input.amount,
        previousBalance: input.expectedBalance, newBalance: money(row.balance_after), alreadyApplied: true };
    }
    const owners = await c.query("SELECT credit_balance, program_key FROM partners WHERE id=$1 FOR UPDATE", [input.partnerId]);
    if (owners.rows.length !== 1) throw new Error("Partner nicht gefunden");
    const current = money(owners.rows[0].credit_balance);
    if (current !== input.expectedBalance) throw new Error("PARTNER_CORRECTION_BALANCE_CHANGED");
    const program = await c.query("SELECT settlement_method FROM partner_programs WHERE key=$1 FOR SHARE", [owners.rows[0].program_key]);
    if (program.rows.length !== 1 || program.rows[0].settlement_method !== "shop_credit") {
      throw new Error("PARTNER_CORRECTION_NOT_SHOP_CREDIT");
    }
    const next = round(current + input.amount);
    if (next < 0 && !input.allowNegativeBalance) throw new Error("PARTNER_CORRECTION_NEGATIVE_BALANCE_REQUIRES_EXPLICIT_APPROVAL");
    await c.query("UPDATE partners SET credit_balance=$1, updated_at=NOW() WHERE id=$2", [next.toFixed(2), input.partnerId]);
    const inserted = await c.query(`INSERT INTO partner_transactions
      (partner_id,type,amount,balance_after,description,admin_note,status)
      VALUES($1,'korrektur',$2,$3,$4,$5,'normal') RETURNING id`,
      [input.partnerId, input.amount.toFixed(2), next.toFixed(2), description, evidence]);
    return { success: true, transactionId: Number(inserted.rows[0].id), adjustment: input.amount,
      previousBalance: current, newBalance: next, alreadyApplied: false };
  }, client);
}

/** Minimal account and ledger read for an authorized operations principal; excludes credentials. */
export async function readOperationsPartnerAccount(partnerId: number) {
  const pool = await getPool();
  if (!pool) throw new Error("Database not available");
  const result = await pool.query(`SELECT p.id,p.name,p.partner_number,p.email,p.credit_balance,
    p.commission_percent,p.customer_discount_percent,p.program_key,p.is_active,
    pp.settlement_method,pp.allow_self_order_credit,pp.active AS program_active
    FROM partners p LEFT JOIN partner_programs pp ON pp.key=p.program_key WHERE p.id=$1`, [partnerId]);
  if (result.rows.length !== 1) throw new Error("Partner nicht gefunden");
  const p = result.rows[0];
  const transactions = await pool.query(`SELECT id,type,amount,balance_after,description,status,order_id,created_at
    FROM partner_transactions WHERE partner_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100`, [partnerId]);
  return { id: Number(p.id), name: p.name, email: p.email, partnerNumber: p.partner_number,
    creditBalance: money(p.credit_balance), commissionPercent: money(p.commission_percent),
    customerDiscountPercent: money(p.customer_discount_percent), programKey: p.program_key,
    settlementMethod: p.settlement_method, allowSelfOrderCredit: p.allow_self_order_credit,
    active: p.is_active === 1 && p.program_active === true,
    transactions: transactions.rows.map(t => ({ id: Number(t.id), type: t.type,
      amount: money(t.amount), balanceAfter: money(t.balance_after), description: t.description,
      status: t.status, orderId: t.order_id, createdAt: t.created_at })) };
}
