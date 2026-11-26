import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import type { PoolClient } from 'pg';
import { getPool } from './db.js';
import { screenshotCustomerSchema } from './screenshotOrderContract.js';
import { normalizeCountryToAlpha3 } from './dhlService.js';

export type RecipientAddress = {
  firstName: string;
  lastName: string;
  company: string | null;
  street: string;
  houseNumber: string;
  zip: string;
  city: string;
  country: string;
  deliveryType: 'home' | 'packstation' | 'postfiliale';
  dhlPostNumber: string | null;
};
export type RecipientCorrectionActor = { id: number; username: string };
type Row = Record<string, any>;
type QueryClient = Pick<PoolClient, 'query'>;
const DOMAIN = '369-order-customer-recipient-correction-v1';
const TTL_MS = 10 * 60 * 1000;
// The base shape is shared with screenshot checkout, but contact fields are
// deliberately excluded. Station canonicalization/validation below is stricter
// about legacy combined street/number values and never reads an old order.
const recipientShape = screenshotCustomerSchema.innerType().innerType().omit({ phone: true, email: true });
const field = (row: Row, snake: string, camel = snake) => Object.hasOwn(row, snake) ? row[snake] : row[camel];
const clean = (value: unknown) => String(value ?? '').trim().replace(/\s+/gu, ' ');
const countryRoute = (value: unknown) => normalizeCountryToAlpha3(clean(value));
const postalRoute = (value: unknown) => clean(value).replace(/\s/gu, '').toUpperCase();
const conflict = (message = 'Die Bestellung oder Kundenadresse wurde inzwischen geändert. Bitte die Vorschau neu laden.') =>
  new TRPCError({ code: 'CONFLICT', message });
const invalidAddress = () => new TRPCError({
  code: 'BAD_REQUEST',
  message: 'Die gespeicherte Kundenadresse ist unvollständig oder ungültig. Bitte Name, Anschrift und gegebenenfalls DHL-Stationsnummer und persönliche Postnummer im Kundenprofil prüfen.',
});
function secret(): string {
  // Do not use ENV.jwtSecret: its development fallback is not an authorization key.
  const value = process.env.JWT_SECRET;
  if (!value || Buffer.byteLength(value, 'utf8') < 32 || /dev-secret|fallback|changeme|change-me/i.test(value)) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Die sichere Adressbestätigung ist derzeit nicht verfügbar.' });
  }
  return value;
}
function assertArguments(orderId: string, actor: RecipientCorrectionActor): void {
  if (typeof orderId !== 'string' || !orderId.trim() || orderId.length > 50 || orderId !== orderId.trim()) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Ungültige Bestellnummer.' });
  }
  if (!actor || !Number.isSafeInteger(actor.id) || actor.id <= 0 || typeof actor.username !== 'string'
    || !actor.username.trim() || actor.username.length > 200) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Die Adresskorrektur benötigt einen angemeldeten Administrator.' });
  }
}

/** A complete new recipient, exclusively from this customer, supporting PG and Drizzle rows. */
export function canonicalRecipientFromCustomer(row: Row): RecipientAddress {
  if (!row) throw invalidAddress();
  // Match the existing CRM first-word/rest name convention. Explicit first/last
  // names each take priority; only absent components fall back to the aggregate.
  const parts = clean(row.name).split(' ').filter(Boolean);
  const firstName = clean(field(row, 'first_name', 'firstName')) || parts[0] || '';
  const lastName = clean(field(row, 'last_name', 'lastName')) || parts.slice(1).join(' ');
  const sourceStreet = clean(row.street);
  const stationPrefix = /^(packstation|postfiliale)\b/iu.exec(sourceStreet);
  const station = /^(packstation|postfiliale)(?:\s+(\d{1,5}))?$/iu.exec(sourceStreet);
  if (stationPrefix && !station) throw invalidAddress();
  const deliveryType: RecipientAddress['deliveryType'] = station
    ? (station[1].toLowerCase() as 'packstation' | 'postfiliale') : 'home';
  // A number embedded in the station street is authoritative: legacy CRM can
  // still contain the former home house number alongside "Packstation 121".
  const houseNumber = station?.[2] || clean(field(row, 'house_number', 'houseNumber'));
  const country = countryRoute(row.country) === 'DEU' ? 'DE' : clean(row.country);
  const dhlPostNumber = deliveryType === 'home' ? null : clean(field(row, 'dhl_post_number', 'dhlPostNumber')) || null;
  const recipient: RecipientAddress = {
    firstName, lastName,
    company: deliveryType === 'home' ? clean(row.company) || null : null,
    street: deliveryType === 'packstation' ? 'Packstation' : deliveryType === 'postfiliale' ? 'Postfiliale' : sourceStreet,
    houseNumber, zip: postalRoute(row.zip), city: clean(row.city), country, deliveryType, dhlPostNumber,
  };
  const parsed = recipientShape.safeParse({ ...recipient, company: recipient.company ?? undefined, dhlPostNumber: dhlPostNumber ?? undefined });
  if (!parsed.success || (countryRoute(country) === 'DEU' && !/^\d{5}$/.test(recipient.zip))) throw invalidAddress();
  if (deliveryType !== 'home' && (country !== 'DE' || !/^\d{5}$/.test(recipient.zip)
    || !/^\d{1,5}$/.test(houseNumber) || !/[1-9]/.test(houseNumber)
    || !dhlPostNumber || !/^\d{6,12}$/.test(dhlPostNumber))) throw invalidAddress();
  return recipient;
}

function orderRecipient(row: Row): RecipientAddress {
  // Preserve the old snapshot exactly, including an obsolete home company or
  // personal Postnummer. The before/audit value must show what was corrected.
  return {
    firstName: String(field(row, 'first_name', 'firstName') ?? ''),
    lastName: String(field(row, 'last_name', 'lastName') ?? ''),
    company: row.company == null ? null : String(row.company),
    street: String(row.street ?? ''), houseNumber: String(field(row, 'house_number', 'houseNumber') ?? ''),
    zip: String(row.zip ?? ''), city: String(row.city ?? ''), country: String(row.country ?? ''),
    deliveryType: field(row, 'delivery_type', 'deliveryType') as RecipientAddress['deliveryType'],
    dhlPostNumber: field(row, 'dhl_post_number', 'dhlPostNumber') == null ? null : String(field(row, 'dhl_post_number', 'dhlPostNumber')),
  };
}

/** Caller owns the order row lock for writes; preview may use a read-only snapshot.
 * This is recipient-only policy, NOT permission to change price/payment/inventory.
 */
export async function assertRecipientOrderEditable(client: QueryClient, orderRow: Row): Promise<void> {
  if (!['offen', 'bezahlt', 'gepackt'].includes(orderRow.status)
    || field(orderRow, 'shipped_at', 'shippedAt') || field(orderRow, 'delivered_at', 'deliveredAt')
    || field(orderRow, 'cancelled_at', 'cancelledAt')
    || field(orderRow, 'tracking_number', 'trackingNumber') || field(orderRow, 'tracking_carrier', 'trackingCarrier') || orderRow.carrier
    || field(orderRow, 'shipping_label_url', 'shippingLabelUrl') || field(orderRow, 'shipping_label_content', 'shippingLabelContent')) {
    throw conflict('Die Lieferadresse kann nur vor Versand und ohne Versandlabel geändert werden. Diese Bestellung benötigt eine manuelle Prüfung.');
  }
  const orderId = field(orderRow, 'order_id', 'orderId');
  if (!orderId) throw conflict();
  const { rows: [tables] } = await client.query(`SELECT
    to_regclass('dhl_label_generations') IS NOT NULL AS generations,
    to_regclass('dhl_label_operations') IS NOT NULL AS label_operations,
    to_regclass('dhl_operations') IS NOT NULL AS legacy_operations`);
  if (tables.generations) {
    const { rows: [result] } = await client.query(
      "SELECT EXISTS(SELECT 1 FROM dhl_label_generations WHERE order_id=$1 AND state IS DISTINCT FROM 'create_rejected') AS blocked", [orderId]);
    if (result.blocked) throw conflict('Für diese Bestellung besteht bereits ein DHL-Labelvorgang. Bitte den Versand manuell prüfen.');
  }
  // Current installations use dhl_label_operations. Older installations may
  // additionally have dhl_operations; inspect both without creating any schema.
  for (const [table, present] of [['dhl_label_operations', tables.label_operations], ['dhl_operations', tables.legacy_operations]] as const) {
    if (!present) continue;
    const { rows: [result] } = await client.query(`SELECT EXISTS(SELECT 1 FROM ${table} op WHERE order_id=$1
      AND COALESCE(to_jsonb(op)->>'state',to_jsonb(op)->>'status','unknown') NOT IN ('succeeded','rejected')) AS blocked`, [orderId]);
    if (result.blocked) throw conflict('Ein DHL-Vorgang ist noch offen oder sein Ergebnis ist unbekannt. Bitte zuerst den Versand manuell prüfen.');
  }
}

function assertSamePostalRoute(before: RecipientAddress, after: RecipientAddress): void {
  const oldCountry = countryRoute(before.country);
  if (!oldCountry || oldCountry !== countryRoute(after.country) || !postalRoute(before.zip) || postalRoute(before.zip) !== postalRoute(after.zip)) {
    throw conflict('Land oder Postleitzahl der Kundenadresse weichen von der Bestellung ab. Die Versandroute und mögliche Versandkosten oder Kühl-/Inselzuschläge müssen manuell geprüft werden.');
  }
}
function canonicalJson(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function binding(order: Row, customer: Row, before: RecipientAddress, after: RecipientAddress): string {
  // Bind raw customer recipient too: normalization must not conceal a change.
  const rawCustomer = Object.fromEntries([
    ['name', customer.name], ['firstName', field(customer, 'first_name', 'firstName')], ['lastName', field(customer, 'last_name', 'lastName')],
    ['company', customer.company], ['street', customer.street], ['houseNumber', field(customer, 'house_number', 'houseNumber')],
    ['zip', customer.zip], ['city', customer.city], ['country', customer.country],
    ['dhlPostNumber', field(customer, 'dhl_post_number', 'dhlPostNumber')],
    ['preferredDeliveryType', field(customer, 'preferred_delivery_type', 'preferredDeliveryType')],
  ].map(([key, value]) => [key, value ?? null]));
  return hash(canonicalJson({
    orderId: field(order, 'order_id', 'orderId'), orderRowId: order.id, customerId: customer.id,
    linkedCustomerId: field(order, 'customer_id', 'customerId'), before, after, rawCustomer,
    orderVersion: [order._row_version, order._updated_at_version], customerVersion: [customer._row_version, customer._updated_at_version],
  }));
}
type Envelope = {
  domain: typeof DOMAIN; version: 1; orderId: string; actorId: number; actorName: string; customerId: number;
  issuedAt: number; expiresAt: number; nonce: string; bindingHash: string;
};
function sign(envelope: Envelope, key: string): string {
  const payload = Buffer.from(JSON.stringify(envelope)).toString('base64url');
  return payload + '.' + createHmac('sha256', key).update(DOMAIN + '.' + payload).digest('base64url');
}
function verify(token: string, orderId: string, actor: RecipientCorrectionActor, key: string): Envelope {
  const invalid = () => conflict('Die Adressbestätigung ist ungültig oder abgelaufen. Bitte die Vorschau neu laden.');
  if (typeof token !== 'string' || token.length > 4096) throw invalid();
  const [payload, signature, extra] = token.split('.');
  if (extra !== undefined || !payload || !signature || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(signature)) throw invalid();
  const expected = createHmac('sha256', key).update(DOMAIN + '.' + payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || actual.toString('base64url') !== signature || !timingSafeEqual(expected, actual)) throw invalid();
  let envelope: Envelope;
  try {
    const bytes = Buffer.from(payload, 'base64url');
    if (bytes.toString('base64url') !== payload) throw invalid();
    envelope = JSON.parse(bytes.toString('utf8'));
  } catch { throw invalid(); }
  const now = Date.now();
  if (!envelope || envelope.domain !== DOMAIN || envelope.version !== 1 || envelope.orderId !== orderId
    || envelope.actorId !== actor.id || envelope.actorName !== actor.username || !Number.isSafeInteger(envelope.customerId) || envelope.customerId <= 0
    || !Number.isSafeInteger(envelope.issuedAt) || !Number.isSafeInteger(envelope.expiresAt)
    || envelope.issuedAt > now || envelope.expiresAt - envelope.issuedAt !== TTL_MS || envelope.expiresAt <= now
    || typeof envelope.nonce !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(envelope.nonce)
    || typeof envelope.bindingHash !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.bindingHash)) throw invalid();
  return envelope;
}
async function readOrder(client: QueryClient, orderId: string, lock: boolean): Promise<Row | undefined> {
  return (await client.query(`SELECT *, xmin::text AS _row_version, updated_at::text AS _updated_at_version
    FROM orders WHERE order_id=$1${lock ? ' FOR UPDATE' : ''}`, [orderId])).rows[0];
}
async function readCustomer(client: QueryClient, customerId: number, lock: boolean): Promise<Row> {
  const row = (await client.query(`SELECT *, xmin::text AS _row_version, updated_at::text AS _updated_at_version
    FROM customers WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [customerId])).rows[0];
  if (!row) throw conflict('Die verknüpfte Kundenadresse ist nicht verfügbar. Bitte die Bestellung manuell prüfen.');
  return row;
}
async function connection(): Promise<PoolClient> {
  const pool = await getPool();
  if (!pool) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Die Datenbank für die Adresskorrektur ist nicht verfügbar.' });
  return pool.connect();
}

/** GET-safe: database-enforced read-only snapshot, no DDL, audit, or receipts. */
export async function previewCustomerOrderRecipient(orderId: string, actor: RecipientCorrectionActor): Promise<{
  orderId: string; previewToken: string; expiresAt: string; changed: boolean; before: RecipientAddress; after: RecipientAddress;
}> {
  assertArguments(orderId, actor);
  const key = secret();
  const client = await connection();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='8000ms'");
    const order = await readOrder(client, orderId, false);
    if (!order) throw new TRPCError({ code: 'NOT_FOUND', message: 'Bestellung nicht gefunden.' });
    await assertRecipientOrderEditable(client, order);
    const customer = await readCustomer(client, field(order, 'customer_id', 'customerId'), false);
    const before = orderRecipient(order);
    const after = canonicalRecipientFromCustomer(customer);
    assertSamePostalRoute(before, after);
    const issuedAt = Date.now();
    const expiresAt = issuedAt + TTL_MS;
    const previewToken = sign({ domain: DOMAIN, version: 1, orderId, actorId: actor.id, actorName: actor.username,
      customerId: customer.id, issuedAt, expiresAt, nonce: randomBytes(16).toString('base64url'), bindingHash: binding(order, customer, before, after) }, key);
    await client.query('COMMIT');
    return { orderId, previewToken, expiresAt: new Date(expiresAt).toISOString(), changed: canonicalJson(before) !== canonicalJson(after), before, after };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

/** Administrator authorization and CSRF protection belong to the mutation router.
 * No financial helper is called. Order lock serializes this with label writers.
 */
export async function applyCustomerOrderRecipientCorrection(orderId: string, previewToken: string, actor: RecipientCorrectionActor): Promise<{ success: true; unchanged?: true }> {
  assertArguments(orderId, actor);
  const envelope = verify(previewToken, orderId, actor, secret());
  const receiptId = hash(previewToken);
  const client = await connection();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='8000ms'");
    const order = await readOrder(client, orderId, true);
    verify(previewToken, orderId, actor, secret());
    // Replays are acknowledgements only, even if the customer later changed or
    // the order shipped. The signed valid token and receipt must match actor/order.
    const receipt = (await client.query('SELECT order_id, customer_id, actor_id, actor_name FROM order_recipient_corrections WHERE id=$1', [receiptId])).rows[0];
    if (receipt) {
      if (receipt.order_id !== orderId || receipt.customer_id !== envelope.customerId || receipt.actor_id !== actor.id || receipt.actor_name !== actor.username) throw conflict();
      await client.query('COMMIT');
      return { success: true, unchanged: true };
    }
    if (!order) throw new TRPCError({ code: 'NOT_FOUND', message: 'Bestellung nicht gefunden.' });
    const customer = await readCustomer(client, field(order, 'customer_id', 'customerId'), true);
    await assertRecipientOrderEditable(client, order);
    const before = orderRecipient(order);
    let after: RecipientAddress;
    try { after = canonicalRecipientFromCustomer(customer); } catch { throw conflict(); }
    if (customer.id !== envelope.customerId || binding(order, customer, before, after) !== envelope.bindingHash) throw conflict();
    assertSamePostalRoute(before, after);
    verify(previewToken, orderId, actor, secret());
    const changed = canonicalJson(before) !== canonicalJson(after);
    if (changed) {
      await client.query(`UPDATE orders SET first_name=$2, last_name=$3, company=$4, street=$5, house_number=$6,
        zip=$7, city=$8, country=$9, delivery_type=$10, dhl_post_number=$11, updated_at=NOW() WHERE order_id=$1`,
      [orderId, after.firstName, after.lastName, after.company, after.street, after.houseNumber,
        after.zip, after.city, after.country, after.deliveryType, after.dhlPostNumber]);
    }
    await client.query(`INSERT INTO order_recipient_corrections(id, order_id, customer_id, actor_id, actor_name, before_snapshot, after_snapshot)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
    [receiptId, orderId, customer.id, actor.id, actor.username, JSON.stringify(before), JSON.stringify(after)]);
    await client.query('COMMIT');
    return changed ? { success: true } : { success: true, unchanged: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if ((error as any)?.code === '40001' || (error as any)?.code === '40P01') throw conflict();
    throw error;
  } finally { client.release(); }
}
