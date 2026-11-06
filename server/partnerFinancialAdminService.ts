import { createHash } from "node:crypto";
import { calculateCommissionBase, parsePartnerMoney as money, roundPartnerMoney as round, withPartnerFinancialTransaction, partnerCommissionBlockReason, type PartnerCreditQueryClient } from "./partnerCreditService.js";

export type PartnerTransactionStatus = "normal" | "storniert" | "nicht_gewertet" | "ausgeblendet";
/** Exclude-original model, serialized with all other owner balance changes. */
export async function updatePartnerTransactionStatus(input: { transactionId: number; status: PartnerTransactionStatus; adminNote?: string }, client?: PartnerCreditQueryClient) {
  return withPartnerFinancialTransaction(async c => {
    const lookup = await c.query("SELECT partner_id, order_id FROM partner_transactions WHERE id=$1", [input.transactionId]);
    if (lookup.rows.length !== 1) throw new Error("Transaktion nicht gefunden");
    // Same lock order as checkout/cancellation: order -> owner -> entries.
    let order: any = null;
    if (lookup.rows[0].order_id) {
      const result = await c.query("SELECT status, cancelled_at FROM orders WHERE order_id=$1 FOR UPDATE", [lookup.rows[0].order_id]);
      order = result.rows[0];
      if (!order && input.status === "normal") throw new Error("PARTNER_ORPHAN_ORDER_REVIEW");
    }
    const owner = await c.query("SELECT credit_balance FROM partners WHERE id=$1 FOR UPDATE", [lookup.rows[0].partner_id]);
    if (owner.rows.length !== 1) throw new Error("Partner nicht gefunden");
    const entries = await c.query("SELECT * FROM partner_transactions WHERE id=$1 FOR UPDATE", [input.transactionId]);
    const entry = entries.rows[0];
    if (!entry || Number(entry.partner_id) !== Number(lookup.rows[0].partner_id)) throw new Error("PARTNER_OWNER_CONFLICT_REVIEW");
    const amount = money(entry.amount);
    if ((entry.type === "provision" && amount < 0) || (["einloesung", "auszahlung"].includes(entry.type) && amount >= 0)) throw new Error("PARTNER_HISTORICAL_SIGN_REVIEW");
    if (input.status === "normal" && entry.status !== "normal" && order && (order.status === "storniert" || order.cancelled_at)) throw new Error("PARTNER_CANCELLED_ORDER_REPLAY");
    const adjustment = (Number(input.status === "normal") - Number(entry.status === "normal")) * amount;
    const balance = round(money(owner.rows[0].credit_balance) + adjustment);
    if (entry.status === input.status) return { success: true, balanceAdjustment: 0, newBalance: balance, alreadyApplied: true };
    await c.query("UPDATE partners SET credit_balance=$1, updated_at=NOW() WHERE id=$2", [balance.toFixed(2), entry.partner_id]);
    await c.query("UPDATE partner_transactions SET status=$1, admin_note=$2 WHERE id=$3", [input.status, input.adminNote || null, entry.id]);
    return { success: true, balanceAdjustment: round(adjustment), newBalance: balance, alreadyApplied: false };
  }, client);
}
export async function recordPartnerPayout(input: { partnerId: number; amount: number; requestId: string; description?: string }, client?: PartnerCreditQueryClient) {
  if (!Number.isFinite(input.amount) || input.amount <= 0 || money(input.amount) !== input.amount) throw new Error("Ungültiger Auszahlungsbetrag");
  return withPartnerFinancialTransaction(async c => {
    const owners = await c.query("SELECT credit_balance, program_key, is_active FROM partners WHERE id=$1 FOR UPDATE", [input.partnerId]);
    if (owners.rows.length !== 1) throw new Error("Partner nicht gefunden");
    const duplicate = await c.query("SELECT amount, balance_after, description FROM partner_transactions WHERE partner_id=$1 AND type='auszahlung' AND admin_note=$2", [input.partnerId, `request:${input.requestId}`]);
    const description = input.description || `Monetäre Auszahlung: ${input.amount.toFixed(2)} €`;
    if (duplicate.rows.length) {
      if (duplicate.rows.length !== 1 || money(duplicate.rows[0].amount) !== -input.amount || duplicate.rows[0].description !== description) throw new Error("PARTNER_IDEMPOTENCY_PAYLOAD_CONFLICT");
      return { success: true, newBalance: money(duplicate.rows[0].balance_after), alreadyApplied: true };
    }
    const program = await c.query("SELECT active, settlement_method, commission_policy FROM partner_programs WHERE key=$1 FOR SHARE", [owners.rows[0].program_key]);
    if (owners.rows[0].is_active !== 1 || program.rows.length !== 1 || !program.rows[0].active || program.rows[0].settlement_method !== "payout" || !["first_paid_code_order", "each_paid_code_order"].includes(program.rows[0].commission_policy)) throw new Error("PARTNER_PAYOUT_POLICY_NOT_ALLOWED");
    const balance = round(money(owners.rows[0].credit_balance) - input.amount);
    if (balance < 0) throw new Error("PARTNER_GUTHABEN_NICHT_AUSREICHEND");
    await c.query("UPDATE partners SET credit_balance=$1, updated_at=NOW() WHERE id=$2", [balance.toFixed(2), input.partnerId]);
    await c.query(`INSERT INTO partner_transactions(partner_id,type,amount,balance_after,description,admin_note,status)
      VALUES($1,'auszahlung',$2,$3,$4,$5,'normal')`, [input.partnerId, (-input.amount).toFixed(2), balance.toFixed(2), description, `request:${input.requestId}`]);
    return { success: true, newBalance: balance, alreadyApplied: false };
  }, client);
}

export type HistoricalPartnerClaimInput = {
  partnerId: number; orderId: string; amount: number; expectedBalance: number; requestId: string;
  reason: string; evidenceReference: string; percent: 10; mode: "evidenced_ten_percent" | "stored_order_amount";
};
/** This service previews original persisted provenance, never applies current partner rates retroactively. */
export async function previewHistoricalPartnerClaim(partnerId: number, orderId: string, client?: PartnerCreditQueryClient) {
  return withPartnerFinancialTransaction(async c => {
    const orders = await c.query("SELECT * FROM orders WHERE order_id=$1", [orderId]);
    const partners = await c.query("SELECT id, email, partner_number FROM partners WHERE id=$1", [partnerId]);
    if (orders.rows.length !== 1 || partners.rows.length !== 1) throw new Error("Historischer Auftrag oder Partner nicht gefunden");
    const order = orders.rows[0], partner = partners.rows[0];
    const code = await c.query("SELECT id FROM partner_codes WHERE partner_id=$1 AND code_normalized=upper(regexp_replace($2,'[[:space:]]+','','g'))", [partnerId, order.partner_code || ""]);
    const exactEmailMatch = !!order.email?.trim() && !!partner.email?.trim() && order.email.trim().toLowerCase() === partner.email.trim().toLowerCase();
    const storedOwnerMatch = Number(order.partner_source_id) === partnerId || (!!order.partner_number && order.partner_number === partner.partner_number);
    const ownerConflict = (!!order.partner_source_id && Number(order.partner_source_id) !== partnerId) || (!!order.partner_number && order.partner_number !== partner.partner_number);
    const existing = await c.query("SELECT id, type, amount, status FROM partner_transactions WHERE order_id=$1 AND type='provision'", [orderId]);
    const goods = calculateCommissionBase({ subtotal: money(order.subtotal), totalProductDiscount: money(order.discount), creditUsed: money(order.credit_used) + money(order.kwk_credit_used) });
    return { orderId, partnerId, exactEmailMatch, storedOwnerMatch, codeEvidenceMatch: code.rows.length === 1, ownerConflict,
      paidAt: order.paid_at, shippedAt: order.shipped_at, cancelledAt: order.cancelled_at, status: order.status,
      goodsAmount: goods, tenPercentUpperLimit: round(goods * .1), storedCommission: money(order.partner_commission),
      storedBase: order.partner_commission_base_snapshot, storedPercent: order.partner_commission_percent_snapshot,
      storedSettlement: order.partner_settlement_method_snapshot, storedProgram: order.partner_program_snapshot,
      existingProvisionEntries: existing.rows, booking: "not_performed" };
  }, client);
}
/** Dedicated single-order administrative entitlement claim, not a bare balance adjustment. */
export async function bookHistoricalPartnerClaim(input: HistoricalPartnerClaimInput, adminUser: string, client?: PartnerCreditQueryClient) {
  if (input.percent !== 10 || !Number.isFinite(input.amount) || input.amount <= 0 || money(input.amount) !== input.amount || !Number.isFinite(input.expectedBalance)
      || !input.reason.trim() || !input.evidenceReference.trim() || !["evidenced_ten_percent", "stored_order_amount"].includes(input.mode)) throw new Error("PARTNER_HISTORICAL_CLAIM_INPUT_INVALID");
  const canonical = JSON.stringify({ partnerId: input.partnerId, orderId: input.orderId, amount: input.amount, expectedBalance: input.expectedBalance,
    requestId: input.requestId, reason: input.reason.trim(), evidenceReference: input.evidenceReference.trim(), percent: 10, mode: input.mode });
  const payloadHash = createHash("sha256").update(canonical).digest("hex");
  return withPartnerFinancialTransaction(async c => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`partner-historical-claim:${input.requestId}`]);
    const orderResult = await c.query("SELECT * FROM orders WHERE order_id=$1 FOR UPDATE", [input.orderId]);
    const partnerResult = await c.query("SELECT credit_balance, program_key FROM partners WHERE id=$1 FOR UPDATE", [input.partnerId]);
    if (orderResult.rows.length !== 1 || partnerResult.rows.length !== 1) throw new Error("Historischer Auftrag oder Partner nicht gefunden");
    const duplicate = await c.query("SELECT payload_hash, balance_after, transaction_id FROM partner_historical_claims WHERE request_id=$1", [input.requestId]);
    if (duplicate.rows.length) {
      if (duplicate.rows[0].payload_hash !== payloadHash) throw new Error("PARTNER_IDEMPOTENCY_PAYLOAD_CONFLICT");
      return { success: true, newBalance: money(duplicate.rows[0].balance_after), transactionId: Number(duplicate.rows[0].transaction_id), alreadyApplied: true };
    }
    const order = orderResult.rows[0];
    if (partnerCommissionBlockReason({ status: order.status, paid_at: order.paid_at, shipped_at: order.shipped_at }) || order.cancelled_at) throw new Error("PARTNER_HISTORICAL_CLAIM_NOT_PAID_AND_SHIPPED");
    const provenance = await previewHistoricalPartnerClaim(input.partnerId, input.orderId, c);
    if (provenance.ownerConflict || provenance.existingProvisionEntries.length) throw new Error("PARTNER_HISTORICAL_CLAIM_CONFLICT_REVIEW");
    if (input.mode === "evidenced_ten_percent") {
      // Legacy own purchases require exact stored contact plus original code/owner, never name or unknown-owner inference.
      if (!provenance.exactEmailMatch || !(provenance.storedOwnerMatch || provenance.codeEvidenceMatch)) throw new Error("PARTNER_HISTORICAL_OWNER_EVIDENCE_REQUIRED");
      if (input.amount > provenance.tenPercentUpperLimit) throw new Error("PARTNER_HISTORICAL_CLAIM_EXCEEDS_TEN_PERCENT");
      const program = await c.query("SELECT settlement_method FROM partner_programs WHERE key=$1", [partnerResult.rows[0].program_key]);
      if (program.rows.length !== 1 || program.rows[0].settlement_method !== "shop_credit") throw new Error("PARTNER_HISTORICAL_SETTLEMENT_REVIEW");
    } else {
      if (!provenance.storedOwnerMatch || !provenance.storedProgram || !["shop_credit", "payout"].includes(provenance.storedSettlement || "")
        || provenance.storedBase == null || provenance.storedPercent == null || money(provenance.storedPercent) < 0 || money(provenance.storedPercent) > 10
        || money(provenance.storedBase) > provenance.goodsAmount || input.amount !== provenance.storedCommission || input.amount > provenance.tenPercentUpperLimit) throw new Error("PARTNER_STORED_CLAIM_PROVENANCE_REQUIRED");
      // Keep 8.32 stored amount when original rounding differs from recomputation.
    }
    const current = money(partnerResult.rows[0].credit_balance);
    if (current !== money(input.expectedBalance)) throw new Error("PARTNER_EXPECTED_BALANCE_CONFLICT");
    const balance = round(current + input.amount);
    const inserted = await c.query(`INSERT INTO partner_transactions(partner_id,type,amount,balance_after,order_id,description,admin_note,status)
      VALUES($1,'provision',$2,$3,$4,$5,$6,'normal') RETURNING id`, [input.partnerId, input.amount.toFixed(2), balance.toFixed(2), input.orderId,
      `Historischer Einzelanspruch: ${input.reason.trim()}`, `claim:${input.requestId}; evidence:${input.evidenceReference.trim()}`]);
    const transactionId = Number(inserted.rows[0].id);
    await c.query(`INSERT INTO partner_historical_claims(request_id,partner_id,order_id,transaction_id,payload_hash,amount,balance_before,balance_after,percent,mode,reason,evidence_reference,admin_user,provenance_json)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,10,$9,$10,$11,$12,$13::jsonb)`, [input.requestId, input.partnerId, input.orderId, transactionId, payloadHash, input.amount.toFixed(2), current.toFixed(2), balance.toFixed(2), input.mode, input.reason.trim(), input.evidenceReference.trim(), adminUser, JSON.stringify(provenance)]);
    await c.query("UPDATE partners SET credit_balance=$1, updated_at=NOW() WHERE id=$2", [balance.toFixed(2), input.partnerId]);
    // Never rewrite order prices, snapshots, expected commission or historical ledger originals.
    return { success: true, newBalance: balance, transactionId, alreadyApplied: false };
  }, client);
}
