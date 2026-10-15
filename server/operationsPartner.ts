import { hasOtherPaidCodeOrder } from "./partnerCodeHistory.js";
import { PAID_ORDER_STATUSES } from "./partnerCreditService.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, getPool, withReadOnlyDatabase } from "./db.js";
import { partners } from "../drizzle/schema.js";
import {
  getPartnerProgram,
  calculateSelfOrderDiscountPercent,
  canRedeemShopCredit,
  listPartnerCodeTerms,
} from "./partnerProgramService.js";
export async function diagnosePartner(body: unknown) {
  const { partnerId } = z
    .object({ partnerId: z.number().int().positive() })
    .strict()
    .parse(body);
  return withReadOnlyDatabase(async () => {
    const db = await getDb();
    if (!db) throw Error("unavailable");
    const [p] = await db
      .select()
      .from(partners)
      .where(eq(partners.id, partnerId))
      .limit(1);
    if (!p) throw Error("partner_not_found");
    const program = await getPartnerProgram(p.id);
    const codes = await listPartnerCodeTerms(p.id);
    const pool = await getPool();
    const bookingEvidence = await pool!.query(
      `SELECT o.order_id,o.status,o.paid_at,o.partner_code,o.email,
          o.partner_commission_policy_snapshot AS policy,o.partner_settlement_method_snapshot AS settlement,
          COALESCE(ov.amount,o.partner_commission,0)::text AS expected_amount,
          (SELECT count(*)::int FROM partner_transactions t WHERE t.partner_id=$1 AND t.order_id=o.order_id AND t.type='provision' AND t.status='normal') AS booking_count,
          (SELECT coalesce(sum(t.amount),0)::text FROM partner_transactions t WHERE t.partner_id=$1 AND t.order_id=o.order_id AND t.type='provision' AND t.status='normal') AS booked_amount
          FROM orders o LEFT JOIN partner_order_credit_overrides ov ON ov.order_id=o.order_id AND ov.is_active=1
          WHERE (o.partner_source_id=$1 OR o.partner_code_id_snapshot IN (SELECT id FROM partner_codes WHERE partner_id=$1))
          AND coalesce(o.partner_number,'')='' ORDER BY o.order_date DESC,o.id DESC LIMIT 20`,
      [p.id],
    );
    const evidence = [];
    for (const row of bookingEvidence.rows) {
      const { email, ...visible } = row;
      const paid = !!row.paid_at && PAID_ORDER_STATUSES.has(row.status);
      const count = Number(row.booking_count),
        amount = Number(row.booked_amount),
        expected = Number(row.expected_amount);
      let audit: string;
      if (count > 1) audit = "duplicate";
      else if (count === 1)
        audit = !paid
          ? "unexpected_booking"
          : Math.abs(amount - expected) > 0.009
            ? "amount_mismatch"
            : row.policy === "none" && amount > 0
              ? "unexpected_booking"
              : !row.policy ? "legacy_booking" : "booked";
      else if (!paid) audit = "awaiting_payment";
      else if (!row.policy) audit = "legacy_unknown";
      else if (row.policy === "none" || expected === 0) audit = "no_commission";
      else if (
        row.policy === "first_paid_code_order" &&
        (await hasOtherPaidCodeOrder(
          (q, values) => pool!.query(q, values),
          row.partner_code,
          email,
          row.order_id,
        ))
      )
        audit = "repeat_excluded";
      else audit = "missing";
      evidence.push({ ...visible, audit });
    }
    return {
      codes,
      bookingEvidence: evidence,
      bookingEvidenceLimit: 20,
      partner: {
        id: p.id,
        name: p.name,
        partnerNumber: p.partnerNumber,
        active: p.isActive === 1,
      },
      program,
      ownDiscount: program?.active
        ? calculateSelfOrderDiscountPercent(
            program,
            Number(p.customerDiscountPercent),
            Number(p.commissionPercent),
          )
        : null,
      credit: {
        balance: Number(p.creditBalance),
        redeemable:
          p.isActive === 1 && !!program?.active && canRedeemShopCredit(program),
      },
      observedAt: new Date().toISOString(),
    };
  });
}
