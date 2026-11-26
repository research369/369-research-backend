import { TRPCError } from '@trpc/server';

/** Validate only DHL pickup recipients; ordinary home orders retain their existing contract. */
export function canonicalizeOrderPickupCustomer<T extends {
  street: string; houseNumber: string; zip: string; city: string; country: string;
  deliveryType?: 'home' | 'packstation' | 'postfiliale'; dhlPostNumber?: string; company?: string;
}>(customer: T): T {
  const street = customer.street.trim();
  const streetType = /^packstation\b/i.test(street) ? 'packstation'
    : /^postfiliale\b/i.test(street) ? 'postfiliale' : null;
  const declared = customer.deliveryType && customer.deliveryType !== 'home' ? customer.deliveryType : null;
  const inferred = streetType || declared || (!street && customer.dhlPostNumber?.trim() ? 'packstation' : null);
  if (!inferred) return customer;
  const invalid = (message: string): never => { throw new TRPCError({ code: 'BAD_REQUEST', message }); };
  if (declared && streetType && declared !== streetType) invalid('DHL-Lieferart und Abholort stimmen nicht überein.');
  const label = inferred === 'packstation' ? 'Packstation' : 'Postfiliale';
  const number = customer.houseNumber.trim();
  const post = customer.dhlPostNumber?.trim() || '';
  if (!/^\d{1,5}$/.test(number) || !/[1-9]/.test(number)) invalid('Bitte eine gültige Packstation-/Postfilialnummer angeben.');
  if (!/^\d{6,12}$/.test(post)) invalid('Für Packstation oder Postfiliale ist eine gültige persönliche DHL-Postnummer erforderlich.');
  if (!/^(DE|Deutschland|Germany)$/i.test(customer.country.trim()) || !/^\d{5}$/.test(customer.zip.trim())) invalid('DHL-Abholorte benötigen eine deutsche Lieferadresse mit fünfstelliger PLZ.');
  if (street && street.toLowerCase() !== label.toLowerCase() && street.toLowerCase() !== `${label} ${number}`.toLowerCase()) invalid('Abholort und Stationsnummer stimmen nicht überein.');
  if (!customer.city.trim()) invalid('Bitte den Ort des DHL-Abholorts angeben.');
  return { ...customer, deliveryType: inferred, street: label, houseNumber: number, zip: customer.zip.trim(), city: customer.city.trim(), country: 'DE', dhlPostNumber: post, company: undefined };
}
