import { escapeOrderMessageHtml, orderMessageCents, orderMessageMoney, type OrderDiscountMessageLanguage, type OrderDiscountMessagePresentation, type OrderDiscountMessageSnapshot } from './orderDiscountMessageContract';
export type { OrderDiscountMessageSnapshot } from './orderDiscountMessageContract';

const PRODUCTS = new Set(['promotion_code', 'partner_self_discount', 'kwk_referral', 'automatic_global_percent', 'manual_global_percent', 'manual_global_amount', 'manual_line_percent', 'manual_line_amount']);
const START = '<!-- order-discount-message/v1:start -->';
const END = '<!-- order-discount-message/v1:end -->';
// Fixed non-Bidi zero-width delimiters: invisible in copied plain text/WhatsApp.
const TEXT_START = '\u2063\u200b\u2063';
const TEXT_END = '\u2063\u200c\u2063';

function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
}
function fingerprint(snapshot: OrderDiscountMessageSnapshot): string {
  const input = canonical({ orderId: snapshot.orderId, status: snapshot.status, subtotal: snapshot.subtotal, discount: snapshot.discount, discountCode: snapshot.discountCode, discountBreakdown: snapshot.discountBreakdown, creditUsed: snapshot.creditUsed, kwkCreditUsed: snapshot.kwkCreditUsed, shipping: snapshot.shipping, total: snapshot.total });
  // Portable deterministic evidence identifier, NOT authentication or an idempotency key.
  let a = 2166136261, b = 5381;
  for (let i = 0; i < input.length; i++) { a = Math.imul(a ^ input.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ input.charCodeAt(i); }
  return `order-discount-message/v1:${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

export function buildOrderDiscountMessagePresentation(snapshot: OrderDiscountMessageSnapshot, language: OrderDiscountMessageLanguage = 'de'): OrderDiscountMessagePresentation {
  const s = orderMessageCents(snapshot.subtotal), d = orderMessageCents(snapshot.discount), h = orderMessageCents(snapshot.shipping), t = orderMessageCents(snapshot.total);
  const reasons: string[] = [];
  let state: OrderDiscountMessagePresentation['state'] = 'complete';
  let p: number | null = 0, partner: number | null = 0, kwk: number | null = 0, note: number | null = 0, unknown: number | null = 0;
  if (s === null || d === null || h === null || t === null) reasons.push('invalid_header_amount');
  else if (BigInt(s) - BigInt(d) + BigInt(h) !== BigInt(t)) reasons.push('header_mismatch');
  const scalar = (value: unknown, key: string) => {
    if (value == null) return null;
    const result = orderMessageCents(value);
    if (result === null) reasons.push(`invalid_${key}`);
    return result;
  };
  const partnerScalar = scalar(snapshot.creditUsed, 'partner_credit'), kwkScalar = scalar(snapshot.kwkCreditUsed, 'kwk_credit');
  const rows = snapshot.discountBreakdown;
  if (rows == null || (Array.isArray(rows) && rows.length === 0)) {
    if (d === 0 && !partnerScalar && !kwkScalar) { /* clean zero */ }
    else { state = 'unallocated'; p = partner = kwk = note = unknown = null; }
    if (d === 0 && ((partnerScalar ?? 0) > 0 || (kwkScalar ?? 0) > 0)) reasons.push('scalar_mismatch');
  } else if (!Array.isArray(rows)) reasons.push('invalid_breakdown');
  else {
    let sum = 0n, product = 0n, pc = 0n, kc = 0n, nc = 0n, uc = 0n;
    for (const row of rows) {
      if (!row || typeof row !== 'object' || typeof row.source !== 'string') { reasons.push('invalid_breakdown_entry'); continue; }
      const amount = orderMessageCents(row.amount);
      if (amount === null) { reasons.push('invalid_breakdown_amount'); continue; }
      const n = BigInt(amount); sum += n;
      if (PRODUCTS.has(row.source)) product += n;
      else if (row.source === 'partner_credit') pc += n;
      else if (row.source === 'kwk_credit') kc += n;
      else if (row.source === 'credit_note') nc += n;
      else uc += n;
      if (row.percentage != null && (typeof row.percentage !== 'number' || !Number.isFinite(row.percentage) || row.percentage < 0 || row.percentage > 100)) reasons.push('invalid_nominal_percentage');
    }
    if (d !== null && sum !== BigInt(d)) reasons.push('breakdown_mismatch');
    if (s !== null && product > BigInt(s)) reasons.push('product_exceeds_subtotal');
    if (partnerScalar !== null && pc !== BigInt(partnerScalar)) reasons.push('partner_credit_mismatch');
    if (kwkScalar !== null && kc !== BigInt(kwkScalar)) reasons.push('kwk_credit_mismatch');
    if ([product, pc, kc, nc, uc].some(n => n > BigInt(Number.MAX_SAFE_INTEGER))) reasons.push('unsafe_sum');
    p = Number(product); partner = Number(pc); kwk = Number(kc); note = Number(nc); unknown = Number(uc);
    if (uc > 0n) state = 'partial';
  }
  if (reasons.some(r => r !== 'invalid_nominal_percentage')) { state = 'invalid'; p = partner = kwk = note = unknown = null; }
  const bp = p !== null && s !== null && s > 0 ? Number((BigInt(p) * 10000n * 2n + BigInt(s)) / (BigInt(s) * 2n)) : null;
  const de = language === 'de', money = (n: number) => orderMessageMoney(n, language);
  let title: string, hero: string, explanation: string;
  if (p !== null && p > 0) {
    title = de ? '🎉 DEIN RABATT' : '🎉 YOUR DISCOUNT';
    const rounded = bp !== null && s !== null && BigInt(p) * 10000n % BigInt(s) !== 0n;
    const rate = bp === 0 ? (de ? '< 0,01 %' : '< 0.01%') : `${bp === null ? '' : `${Math.floor(bp / 100)}${de ? ',' : '.'}${String(bp % 100).padStart(2, '0')}`}${de ? ' %' : '%'}`;
    hero = `${rounded && bp !== 0 ? (de ? 'ca. ' : 'approx. ') : ''}${rate} · ${money(p)}`;
    explanation = `${state === 'partial' ? (de ? 'Belegter Warenrabattanteil. ' : 'Documented product-discount portion. ') : ''}${de ? `Effektiv auf den gespeicherten Warenwert ${money(s!)}, ohne Versand und Guthaben.` : `Effective on the recorded product subtotal ${money(s!)}, excluding shipping and credit.`}`;
  } else if (p === 0) {
    title = state === 'partial' ? (de ? 'Kein Warenrabattanteil belegt' : 'No product-discount portion documented') : (de ? 'Kein Warenrabatt' : 'No product discount');
    hero = `${bp === 0 ? (de ? '0,00 % · ' : '0.00% · ') : ''}${money(0)}`;
    explanation = s === 0 ? (de ? 'Prozentsatz nicht anwendbar: Warenwert 0,00 €.' : 'Percentage not applicable: product subtotal €0.00.') : (de ? 'Guthaben wird getrennt ausgewiesen.' : 'Redeemed credit is shown separately.');
    if (state === 'partial') explanation += de ? ' Weitere Abzüge sind nicht zugeordnet; die vollständige Warenrabattquote ist unbekannt.' : 'Other deductions are unallocated; the complete product-discount rate is unknown.';
  } else {
    title = de ? 'Gespeicherte Abzüge' : 'Recorded deductions';
    hero = d === null ? (de ? 'Betrag nicht belegt' : 'Amount not documented') : money(d);
    explanation = state === 'invalid' ? (de ? 'Rabattdetails nicht verlässlich aufgeschlüsselt. Keine gesicherte Warenrabattquote.' : 'Discount details cannot be reliably allocated. No verified product-discount rate.') : (de ? 'Rabatte/Guthaben, Aufteilung nicht belegt. Kein gesicherter Prozentsatz.' : 'Discounts/credits; allocation not documented. No verified percentage.');
  }
  const lines: Array<[string, string]> = [];
  if (s !== null) lines.push([de ? 'Warenwert' : 'Product subtotal', money(s)]);
  if (p !== null && p > 0) lines.push([de ? 'Warenrabatt' : 'Product discount', `-${money(p)}`]);
  for (const [amount, label] of [[partner, de ? 'Eingelöstes Partnerguthaben' : 'Partner credit redeemed'], [kwk, de ? 'Eingelöstes KWK-Guthaben' : 'Referral credit redeemed'], [note, de ? 'Manuelle Gutschrift' : 'Manual credit adjustment'], [unknown, de ? 'Nicht zugeordneter Abzug' : 'Unallocated deduction']] as const) if (amount !== null && amount > 0) lines.push([label, `-${money(amount)}`]);
  if (p === null && d !== null) lines.push([de ? 'Abzüge gesamt (Rabatte/Guthaben)' : 'Total deductions (discounts/credits)', `-${money(d)}`]);
  if (h !== null) lines.push([de ? 'Versand' : 'Shipping', money(h)]);
  if (t !== null) lines.push([de ? 'Zahlbetrag' : 'Amount payable', money(t)]);
  const historical = /^(cancelled|canceled|storniert)$/i.test(snapshot.status ?? '') ? (de ? 'Historische Anwendung in dieser inzwischen stornierten Bestellung.' : 'Historical application in this now-cancelled order.') : '';
  const text = [title, hero, explanation, ...lines.map(([label, value]) => `${label}: ${value}`), historical].filter(Boolean).join('\n');
  const whatsapp = [`*${title}*`, `*${hero}*`, explanation, ...lines.map(([label, value], i) => i === lines.length - 1 && t !== null ? `*${label}: ${value}*` : `${label}: ${value}`), historical].filter(Boolean).join('\n');
  const esc = escapeOrderMessageHtml;
  const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;background:#f0fdf4;border:2px solid #15803d;border-radius:10px"><tr><td style="padding:20px;color:#14532d;font-family:Arial,sans-serif"><div style="font-size:18px;font-weight:700">${esc(title)}</div><div style="font-size:${p !== null && p > 0 ? 30 : 20}px;font-weight:800;line-height:1.3;margin:8px 0">${esc(hero)}</div><div style="font-size:13px;line-height:1.5">${esc(explanation)}</div>${lines.map(([label, value]) => `<div style="font-size:14px;line-height:1.7">${esc(label)}: <strong>${esc(value)}</strong></div>`).join('')}${historical ? `<p style="font-size:13px">${esc(historical)}</p>` : ''}</td></tr></table>`;
  return { version: 1, state, fingerprint: fingerprint(snapshot), subtotalCents: s, aggregateDeductionCents: d, productDiscountCents: p, productEffectiveRateBasisPoints: bp, partnerCreditCents: partner, kwkCreditCents: kwk, creditNoteCents: note, unallocatedCents: unknown, shippingCents: h, totalCents: t, reasons: [...new Set(reasons)], html, text, whatsapp };
}

/** Only our own explicit markers are removed; arbitrary user prose is never guessed/deleted. */
export function stripManagedOrderDiscountBlock(body: string): string {
  return body.replace(/\u2063\u200b\u2063[\s\S]*?\u2063\u200c\u2063/g, '')
    .replace(/<!-- order-discount-message\/v1:start -->[\s\S]*?<!-- order-discount-message\/v1:end -->/g, '')
    .replace(/\[order-discount-message\/v1:start\][\s\S]*?\[order-discount-message\/v1:end\]/g, '').trim();
}
export function appendOrderDiscountHtml(body: string, presentation: OrderDiscountMessagePresentation): string {
  const block = `${START}${presentation.html}${END}`;
  const base = stripManagedOrderDiscountBlock(body);
  return /<\/body>/i.test(base) ? base.replace(/<\/body>/i, `${block}</body>`) : `${base}${block}`;
}
export function appendOrderDiscountText(body: string, presentation: OrderDiscountMessagePresentation, channel: 'text' | 'whatsapp' = 'text'): string {
  return `${stripManagedOrderDiscountBlock(body)}\n\n${TEXT_START}\n${presentation[channel]}\n${TEXT_END}`.trim();
}
export function futureCartDiscountNotice(language: OrderDiscountMessageLanguage = 'de'): string {
  return language === 'de' ? 'Die Euroersparnis hängt vom rabattfähigen Warenkorb deiner nächsten Bestellung und den Codebedingungen ab; sie ist noch nicht bestimmbar.' : 'The euro saving depends on the eligible basket of your next order and the code terms; it cannot yet be determined.';
}
