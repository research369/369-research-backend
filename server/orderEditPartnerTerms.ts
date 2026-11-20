import { sql } from 'drizzle-orm';
import { resultRows } from './priorityOrderIntegrity.js';
import { editMoneyCents, editBreakdownShape } from './orderEditValidation.js';
import { calculateCommissionAmount, calculateCommissionBase } from './partnerCreditService.js';

/** Never re-resolve historical terms from today's mutable partner/code catalog. */
export async function orderEditDerivedTerms(tx: any, order: any, input: any) {
  const beforeBase = editMoneyCents(order.subtotal) - editMoneyCents(order.discount);
  const afterBase = editMoneyCents(input.subtotal) - editMoneyCents(input.discount);
  const discountChanged = editMoneyCents(order.discount) !== editMoneyCents(input.discount);
  const codeChanged = (order.discountCode || null) !== (input.discountCode || null);
  const protectedSources=new Set(['partner_self_discount','partner_credit','kwk_credit','kwk_referral']);
  if (input.discountBreakdown !== undefined && editBreakdownShape((order.discountBreakdown || []).filter((e:any)=>protectedSources.has(e.source))) !== editBreakdownShape(input.discountBreakdown.filter((e:any)=>protectedSources.has(e.source)))) throw Error('ORDER_CREDIT_INTENT_EDIT_REVIEW_REQUIRED');
  if (Number(order.kwkCreditRequested) > 0 && (beforeBase !== afterBase || discountChanged)) throw Error('ORDER_CREDIT_INTENT_EDIT_REVIEW_REQUIRED');
  const attributed = order.partnerSourceId || order.partnerCodeIdSnapshot || order.partnerCode || order.partnerNumber || Number(order.partnerCommission) > 0 || Number(order.partnerDiscount) > 0;
  if (!attributed) return {};
  // Attribution is immutable on this route. Changing code/partner discount needs
  // the original pricing decision; an arbitrary aggregate discount cannot supply it.
  if (codeChanged || (discountChanged && (Number(order.partnerDiscount) > 0 || (order.discountBreakdown || []).some((e: any) => e.source === 'partner_self_discount')))) throw Error('ORDER_PARTNER_TERMS_EDIT_REVIEW_REQUIRED');
  if (beforeBase === afterBase) return {};
  // Aggregate edit payload cannot distinguish fixed partner discount from a
  // percentage/policy-derived amount; never leave a stale derived header behind.
  if (beforeBase < 0 || Number(order.partnerDiscount) > 0 || (order.discountBreakdown || []).some((e:any)=>e.source==='partner_self_discount')) throw Error('ORDER_PARTNER_TERMS_EDIT_REVIEW_REQUIRED');
  const [overrides] = resultRows(await tx.execute(sql`SELECT to_regclass('partner_order_credit_overrides') IS NOT NULL AS present`));
  if (!overrides?.present) throw Error('ORDER_PARTNER_TERMS_EDIT_REVIEW_REQUIRED');
  const [override] = resultRows(await tx.execute(sql`SELECT EXISTS(SELECT 1 FROM partner_order_credit_overrides WHERE order_id=${order.orderId} AND is_active=1) AS linked`));
  if (override?.linked) throw Error('ORDER_PARTNER_TERMS_EDIT_REVIEW_REQUIRED');
  const percent = Number(order.partnerCommissionPercentSnapshot);
  if (!order.partnerProgramSnapshot || !order.partnerSourceId || !['each_paid_code_order','first_paid_code_order','none'].includes(order.partnerCommissionPolicySnapshot)
    || order.partnerCommissionPercentSnapshot == null || !Number.isFinite(percent) || percent < 0 || percent > 100
    || order.partnerCommissionBaseSnapshot == null || editMoneyCents(order.partnerCommissionBaseSnapshot) !== beforeBase
    || editMoneyCents(order.partnerCommission) !== editMoneyCents(calculateCommissionAmount({ subtotal: Number(order.subtotal), totalProductDiscount: Number(order.discount), creditUsed: 0, commissionPercent: percent }))) throw Error('ORDER_PARTNER_TERMS_EDIT_REVIEW_REQUIRED');
  if (afterBase < 0) throw Error('ORDER_EDIT_AMOUNTS_INVALID');
  const amounts={ subtotal: editMoneyCents(input.subtotal)/100, totalProductDiscount: editMoneyCents(input.discount)/100, creditUsed: 0 };
  const base = calculateCommissionBase(amounts);
  const amount = calculateCommissionAmount({ ...amounts, commissionPercent: percent });
  return { partnerCommissionBaseSnapshot: base.toFixed(2), partnerCommission: amount.toFixed(2) };
}
