import { getPool } from "./db.js";
import { releaseCredit, type KwkCreditReleaseResult } from "./kwkService.js";
import { isKwkCreditReleaseEligible } from "./kwkCreditEligibility.js";

const DEFAULT_RECONCILIATION_LIMIT = 500;

export type KwkCreditReconciliationCandidate = {
  orderId: string;
  status: string;
  paidAt: Date | string | null;
  cancelledAt: Date | string | null;
};

/**
 * Repairs historical pending credits that were already payment-confirmed before
 * the payment-triggered release path existed. The downstream ledger operation
 * locks each order and is idempotent, therefore repeated process starts cannot
 * create a second credit.
 */
export async function reconcilePaidKwkCredits(options: { limit?: number } = {}): Promise<{
  candidates: number;
  released: number;
  skipped: number;
  failed: number;
}> {
  const limit = Math.min(Math.max(Math.floor(options.limit ?? DEFAULT_RECONCILIATION_LIMIT), 1), 2_000);
  const pool = await getPool();
  if (!pool) throw new Error("Database not available");

  const candidates = await pool.query<KwkCreditReconciliationCandidate>(
    `SELECT DISTINCT ON (l.order_id)
            l.order_id AS "orderId", o.status, o.paid_at AS "paidAt", o.cancelled_at AS "cancelledAt"
       FROM kwk_ledger l
       JOIN orders o ON o.order_id = l.order_id
      WHERE l.type = 'pending_credit'
        AND l.status = 'pending'
        AND o.status IN ('bezahlt', 'gepackt', 'versendet', 'zugestellt', 'abgeholt')
        AND o.paid_at IS NOT NULL
        AND o.cancelled_at IS NULL
      ORDER BY l.order_id ASC, l.created_at ASC
      LIMIT $1`,
    [limit],
  );

  let released = 0;
  let skipped = 0;
  let failed = 0;

  for (const candidate of candidates.rows) {
    // The SQL predicate is intentionally duplicated in the pure guard. This
    // prevents accidental broadening if the query changes later.
    if (!isKwkCreditReleaseEligible(candidate)) {
      skipped += 1;
      continue;
    }

    try {
      const result: KwkCreditReleaseResult = await releaseCredit(candidate.orderId, {
        source: "paid_credit_reconciliation",
      });
      if (result.released) {
        released += 1;
      } else {
        skipped += 1;
      }
    } catch (error) {
      failed += 1;
      console.error(`[KWK] Zahlungsabgleich für ${candidate.orderId} fehlgeschlagen:`, error);
    }
  }

  return { candidates: candidates.rows.length, released, skipped, failed };
}
