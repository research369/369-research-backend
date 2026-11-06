/** First-paid policies use one normalized contact/code key; reusable policies need no such guard. */
export function partnerPaidCodeContactKey(code: string, email: string | null): string {
  const contact = email?.trim().toLowerCase();
  const normalizedCode = code.replace(/\s+/g, "").toUpperCase();
  if (!contact || !normalizedCode) throw new Error("PARTNER_ERSTNUTZUNG_KONTAKT_ERFORDERLICH");
  return `partner-paid-code:${JSON.stringify([normalizedCode, contact])}`;
}

/** Read-only history. With a current order, only chronologically EARLIER paid orders count. */
export async function hasOtherPaidCodeOrder(
  query: (sql: string, values: any[]) => Promise<{ rows: any[] }>,
  code: string,
  email: string | null,
  excludeOrderId: string | null = null,
) {
  partnerPaidCodeContactKey(code, email);
  const result = await query(
    `SELECT o.order_id FROM orders o
     WHERE upper(regexp_replace(coalesce(o.partner_code, ''), '[[:space:]]+', '', 'g')) = $1
       AND lower(trim(o.email)) = $2
       AND o.status::text IN ('bezahlt', 'gepackt', 'versendet', 'zugestellt', 'abgeholt')
       AND o.paid_at IS NOT NULL AND o.cancelled_at IS NULL
       AND ($3::text IS NULL OR EXISTS (
         SELECT 1 FROM orders current_order WHERE current_order.order_id = $3
           AND current_order.paid_at IS NOT NULL
           AND (o.paid_at, o.order_id) < (current_order.paid_at, current_order.order_id)
       ))
     ORDER BY o.paid_at, o.order_id LIMIT 1`,
    [code.replace(/\s+/g, "").toUpperCase(), email!.trim().toLowerCase(), excludeOrderId],
  );
  return result.rows.length > 0;
}
