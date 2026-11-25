import { TRPCError } from '@trpc/server';

/** Compare exactly what update persists, never with a one-cent tolerance. */
export function editMoneyCents(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 99999999.99) throw Error('ORDER_EDIT_AMOUNTS_INVALID');
  const cents = Math.round((n + Number.EPSILON) * 100);
  if (!Number.isSafeInteger(cents)) throw Error('ORDER_EDIT_AMOUNTS_INVALID');
  return cents;
}
const optionalText = (value: unknown) => value || null;
export function editItemShape(item: any, withPrice = true): string {
  return JSON.stringify({ name: item.name, dosage: optionalText(item.dosage), variant: optionalText(item.variant),
    type: item.type, quantity: item.quantity, articleId: item.articleId ?? null,
    ...(withPrice ? { price: editMoneyCents(item.price) } : {}) });
}
export function editBreakdownShape(entries: any): string {
  if (entries == null) return '[]';
  if (!Array.isArray(entries)) throw Error('ORDER_EDIT_AMOUNTS_INVALID');
  return JSON.stringify(entries.map((entry: any) => {
    if (entry.percentage !== undefined && (!Number.isFinite(entry.percentage) || entry.percentage < 0 || entry.percentage > 100)) throw Error('ORDER_EDIT_AMOUNTS_INVALID');
    return JSON.stringify({ source: entry.source, label: entry.label, amount: editMoneyCents(entry.amount),
      ...(entry.percentage !== undefined ? { percentage: entry.percentage } : {}),
      ...(entry.code !== undefined ? { code: entry.code } : {}) });
  }).sort());
}
export function validateEditAmounts(input: any) {
  const subtotal = editMoneyCents(input.subtotal), discount = editMoneyCents(input.discount), shipping = editMoneyCents(input.shipping), total = editMoneyCents(input.total);
  const itemSubtotal = input.items.reduce((sum: number, item: any) => {
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0 || item.quantity > 2147483647) throw Error('ORDER_EDIT_AMOUNTS_INVALID');
    return sum + editMoneyCents(item.price) * item.quantity;
  }, 0);
  if (!Number.isSafeInteger(itemSubtotal) || subtotal !== itemSubtotal || total !== subtotal - discount + shipping) throw Error('ORDER_EDIT_AMOUNTS_INVALID');
  editBreakdownShape(input.discountBreakdown);
  return { subtotal, discount, shipping, total };
}
/** Supplied IDs bind their real row. Legacy ID-less payloads compare remaining rows as a multiset. */
export function matchEditItems(inputItems: any[], oldItems: any[]) {
  const oldById = new Map(oldItems.map(item => [item.id, item]));
  const used = new Set<number>();
  for (const item of inputItems) {
    if (item.id === undefined) continue;
    if (used.has(item.id) || !oldById.has(item.id)) throw Error('ORDER_ITEM_ID_CONFLICT');
    used.add(item.id);
  }
  const reserved = new Set(used);
  const matches = inputItems.map(item => {
    if (item.id !== undefined) return oldById.get(item.id);
    const match = oldItems.find(old => !used.has(old.id) && editItemShape(old) === editItemShape(item));
    if (match) used.add(match.id);
    return match;
  });
  const unchanged = inputItems.length === oldItems.length && matches.every((old, index) => old && editItemShape(old) === editItemShape(inputItems[index]));
  // Price-only legacy changes retain IDs/flags if their stock identity is proven.
  for (let index = 0; index < matches.length; index++) {
    if (matches[index]) continue;
    const old = oldItems.find(old => !used.has(old.id) && !reserved.has(old.id) && editItemShape(old, false) === editItemShape(inputItems[index], false));
    if (old) { used.add(old.id); matches[index] = old; }
  }
  return { unchanged, matches };
}
export function orderEditError(error: unknown): never {
  if (error instanceof TRPCError) throw error;
  const key = error instanceof Error ? error.message : '';
  const messages: Record<string, string> = {
    ORDER_NOT_FOUND: 'Bestellung nicht gefunden.',
    ORDER_EDIT_AMOUNTS_INVALID: 'Ungültige Beträge: Artikelpreise, Zwischensumme, Rabatt, Versand und Gesamtbetrag müssen endlich, nicht negativ und centgenau übereinstimmen.',
    ORDER_ITEM_ID_CONFLICT: 'Die Artikelpositionen sind veraltet oder enthalten doppelte/fremde IDs. Bestellung neu laden und erneut prüfen.',
    ORDER_FINANCIAL_CORRECTION_REVIEW_REQUIRED: 'Finanzielle Änderung nicht möglich: bezahlte oder bereits gebuchte Bestellung. Eine nachvollziehbare finanzielle Korrektur ist erforderlich.',
    ORDER_CREDIT_INTENT_EDIT_REVIEW_REQUIRED: 'Finanzielle Änderung benötigt eine Guthabenprüfung: gespeicherter Guthabeneinsatz ist nicht eindeutig als ungebuchte Absicht nachgewiesen. Einlösung und Rabatt müssen gemeinsam korrigiert werden.',
    ORDER_PARTNER_TERMS_EDIT_REVIEW_REQUIRED: 'Finanzielle Änderung benötigt eine Partnerprüfung: historische Provisions-/Rabattbedingungen sind nicht vollständig oder ein manueller Guthaben-Override besteht. Verifizierte Partner-Korrektur erforderlich.',
    ORDER_CANCELLED_EDIT_REVIEW_REQUIRED: 'Stornierte Bestellung: finanzielle Änderung erfordert eine geprüfte Korrektur; keine automatische Wiederherstellung.',
    ORDER_RETURN_MANUAL_REVIEW_REQUIRED: 'Bereits versendete oder ausgelieferte Bestellung: finanzielle Änderung erfordert eine manuelle Korrektur.',
    ORDER_ITEM_STOCK_EDIT_REVIEW_REQUIRED: 'Artikeländerung nicht sicher rekonstruierbar. Originale Bestandsbewegungen und eindeutige Artikel-IDs prüfen; manuelle Korrektur erforderlich.',
    ORDER_STOCK_HISTORY_REVIEW_REQUIRED: 'Bestandshistorie nicht eindeutig. Originale Verkäufe und Rückgaben prüfen; manuelle Korrektur erforderlich.',
    ORDER_GOODIE_RETURN_REVIEW_REQUIRED: 'Goodie-Zuordnung benötigt eine geprüfte Bestandskorrektur vor der Artikeländerung.',
    stock_conflict: 'Bestand wurde zwischenzeitlich geändert. Bestellung und Bestand neu laden.',
    invalid_stock: 'Artikeländerung würde einen ungültigen oder negativen Bestand erzeugen. Verfügbaren Bestand prüfen.',
  };
  if (messages[key]) throw new TRPCError({ code: key === 'ORDER_NOT_FOUND' ? 'NOT_FOUND' : key === 'ORDER_EDIT_AMOUNTS_INVALID' ? 'BAD_REQUEST' : 'CONFLICT', message: `${messages[key]} (${key})`, cause: error });
  throw error;
}
