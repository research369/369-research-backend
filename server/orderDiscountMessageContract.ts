/** Portable presentation contract: no pricing, persistence or platform dependencies. */
export type OrderDiscountMessageSnapshot = {
  orderId?: string; status?: string;
  subtotal: unknown; discount: unknown; discountCode?: unknown;
  discountBreakdown?: unknown; creditUsed?: unknown; kwkCreditUsed?: unknown;
  shipping: unknown; total: unknown;
};
export type OrderDiscountMessageLanguage = 'de' | 'en';
export type OrderDiscountMessageState = 'complete' | 'partial' | 'unallocated' | 'invalid';
export type OrderDiscountMessagePresentation = {
  version: 1; state: OrderDiscountMessageState; fingerprint: string;
  subtotalCents: number | null; aggregateDeductionCents: number | null;
  productDiscountCents: number | null; productEffectiveRateBasisPoints: number | null;
  partnerCreditCents: number | null; kwkCreditCents: number | null;
  creditNoteCents: number | null; unallocatedCents: number | null;
  shippingCents: number | null; totalCents: number | null;
  reasons: string[]; html: string; text: string; whatsapp: string;
};

/** Reject partial parses, exponents, negative values and sub-cent amounts. */
export function orderMessageCents(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) return null;
  const s = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(s)) return null;
  const [whole, fraction = ''] = s.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}

export function orderMessageMoney(cents: number, language: OrderDiscountMessageLanguage): string {
  const amount = `${Math.floor(cents / 100)}${language === 'de' ? ',' : '.'}${String(cents % 100).padStart(2, '0')}`;
  return language === 'de' ? `${amount} €` : `€${amount}`;
}

export function escapeOrderMessageHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
