/** The same read-only paid-code history used by both the booking service and its preview. */
export async function hasOtherPaidCodeOrder(
  query: (sql: string, values: any[]) => Promise<{ rows: any[] }>,
  code: string,
  email: string | null,
  excludeOrderId: string | null = null,
) {
  const result = await query(
    `SELECT order_id FROM orders
 WHERE upper(coalesce(partner_code, '')) = upper($1) AND lower(email) = lower($2)
 AND ($3::text IS NULL OR order_id <> $3)
 AND status::text IN ('bezahlt', 'gepackt', 'versendet', 'zugestellt', 'abgeholt') AND paid_at IS NOT NULL LIMIT 1`,
    [code, email, excludeOrderId],
  );
  return result.rows.length > 0;
}
