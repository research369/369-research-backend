import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { getPool } from "./db.js";

/**
 * A customer data change is only recognised through a unique, real e-mail
 * address or a unique normalized phone number. Names and addresses are never
 * identity keys and can therefore never cause an automatic customer match.
 */
const PLACEHOLDER_EMAILS = new Set([
  "",
  "keine@angabe.de",
  "noemail@noemail.de",
  "no@email.de",
  "noreply@noreply.de",
  "placeholder@placeholder.de",
  "test@test.de",
  "info@info.de",
  "otc@369research.eu",
]);

export const CUSTOMER_DATA_CHANGE_RECONFIRMATION_CODE = "CUSTOMER_DATA_CHANGE_RECONFIRMATION_REQUIRED";
export const CUSTOMER_DATA_CHANGE_CONFIRMATION_TTL_MS = 15 * 60 * 1000;

export type CheckoutCustomerIdentity = {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  street?: string | null;
  houseNumber?: string | null;
  zip?: string | null;
  city?: string | null;
  country?: string | null;
  dhlPostNumber?: string | null;
};

export type CustomerIdentityRecord = CheckoutCustomerIdentity & {
  id: number;
  name?: string | null;
  customerNumber?: string | null;
};

export type CustomerDataSnapshot = {
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  company: string;
  street: string;
  houseNumber: string;
  zip: string;
  city: string;
  country: string;
  dhlPostNumber: string;
};

export type CustomerDataChangeField = keyof CustomerDataSnapshot;
export type CustomerMatchMethod = "email" | "phone" | "email_and_phone";

export type CheckoutCustomerDataChangeResolution =
  | { kind: "no_unique_match"; reason: "none" | "ambiguous"; requiresConfirmation: false }
  | { kind: "conflict"; requiresConfirmation: false }
  | {
    kind: "matched";
    customer: CustomerIdentityRecord;
    matchedBy: CustomerMatchMethod;
    previousSnapshot: CustomerDataSnapshot;
    submittedSnapshot: CustomerDataSnapshot;
    changedFields: CustomerDataChangeField[];
    requiresConfirmation: boolean;
  };

function clean(value?: string | null): string {
  return (value || "").trim().replace(/\s+/g, " ");
}

function comparisonText(value?: string | null): string {
  return clean(value).toLocaleLowerCase("de-DE");
}

export function normalizeCustomerMatchEmail(value?: string | null): string | null {
  const normalized = clean(value).toLowerCase();
  return normalized && !PLACEHOLDER_EMAILS.has(normalized) ? normalized : null;
}

/**
 * Normalizes common German local forms as well as international numbers.
 * It intentionally does not use a name or an address as a fallback.
 */
export function normalizeCustomerMatchPhone(value?: string | null): string | null {
  let digits = (value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `49${digits.replace(/^0+/, "")}`;
  return digits.length >= 8 ? digits : null;
}

export function toCustomerDataSnapshot(source: CheckoutCustomerIdentity | CustomerIdentityRecord): CustomerDataSnapshot {
  const firstName = clean(source.firstName);
  const lastName = clean(source.lastName);
  return {
    name: clean((source as CustomerIdentityRecord).name) || `${firstName} ${lastName}`.trim(),
    firstName,
    lastName,
    email: clean(source.email).toLowerCase(),
    phone: clean(source.phone),
    company: clean(source.company),
    street: clean(source.street),
    houseNumber: clean(source.houseNumber),
    zip: clean(source.zip),
    city: clean(source.city),
    country: clean(source.country),
    dhlPostNumber: clean(source.dhlPostNumber),
  };
}

function comparableSnapshot(snapshot: CustomerDataSnapshot): Record<CustomerDataChangeField, string> {
  return {
    name: comparisonText(snapshot.name),
    firstName: comparisonText(snapshot.firstName),
    lastName: comparisonText(snapshot.lastName),
    email: normalizeCustomerMatchEmail(snapshot.email) || "",
    phone: normalizeCustomerMatchPhone(snapshot.phone) || comparisonText(snapshot.phone),
    company: comparisonText(snapshot.company),
    street: comparisonText(snapshot.street),
    houseNumber: comparisonText(snapshot.houseNumber),
    zip: comparisonText(snapshot.zip),
    city: comparisonText(snapshot.city),
    country: comparisonText(snapshot.country),
    dhlPostNumber: comparisonText(snapshot.dhlPostNumber),
  };
}

export function getChangedCustomerDataFields(previous: CustomerDataSnapshot, submitted: CustomerDataSnapshot): CustomerDataChangeField[] {
  const before = comparableSnapshot(previous);
  const after = comparableSnapshot(submitted);
  // `name` is an aggregate of first/last name and would otherwise create a
  // duplicate entry for the same visible change.
  return (Object.keys(before) as CustomerDataChangeField[])
    .filter((field) => field !== "name" && before[field] !== after[field]);
}

/**
 * Resolves only a unique contact-based identity. If e-mail and phone point to
 * different records, or a contact is duplicated, no existing customer record
 * is selected and no record may be changed.
 */
export function resolveCheckoutCustomerDataChange(
  allCustomers: CustomerIdentityRecord[],
  submittedCustomer: CheckoutCustomerIdentity,
): CheckoutCustomerDataChangeResolution {
  const email = normalizeCustomerMatchEmail(submittedCustomer.email);
  const phone = normalizeCustomerMatchPhone(submittedCustomer.phone);
  const emailCandidates = email
    ? allCustomers.filter((customer) => normalizeCustomerMatchEmail(customer.email) === email)
    : [];
  const phoneCandidates = phone
    ? allCustomers.filter((customer) => normalizeCustomerMatchPhone(customer.phone) === phone)
    : [];
  const emailCustomer = emailCandidates.length === 1 ? emailCandidates[0] : null;
  const phoneCustomer = phoneCandidates.length === 1 ? phoneCandidates[0] : null;

  if (emailCustomer && phoneCustomer && emailCustomer.id !== phoneCustomer.id) {
    return { kind: "conflict", requiresConfirmation: false };
  }

  const customer = emailCustomer || phoneCustomer;
  if (!customer) {
    const hasAmbiguity = emailCandidates.length > 1 || phoneCandidates.length > 1;
    return { kind: "no_unique_match", reason: hasAmbiguity ? "ambiguous" : "none", requiresConfirmation: false };
  }

  const matchedBy: CustomerMatchMethod = emailCustomer && phoneCustomer
    ? "email_and_phone"
    : emailCustomer
      ? "email"
      : "phone";
  const previousSnapshot = toCustomerDataSnapshot(customer);
  const submittedSnapshot = toCustomerDataSnapshot(submittedCustomer);
  // These optional fields are not always rendered by the checkout (for
  // example DHL Post Number on a home-delivery order). An omitted value is not
  // evidence that a customer wants to erase an existing value.
  if (!submittedSnapshot.company) submittedSnapshot.company = previousSnapshot.company;
  if (!submittedSnapshot.dhlPostNumber) submittedSnapshot.dhlPostNumber = previousSnapshot.dhlPostNumber;
  const changedFields = getChangedCustomerDataFields(previousSnapshot, submittedSnapshot);
  return {
    kind: "matched",
    customer,
    matchedBy,
    previousSnapshot,
    submittedSnapshot,
    changedFields,
    requiresConfirmation: changedFields.length > 0,
  };
}

function snapshotJson(snapshot: CustomerDataSnapshot): string {
  return JSON.stringify(snapshot);
}

function fieldsJson(fields: CustomerDataChangeField[]): string {
  return JSON.stringify(fields);
}

function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function throwReconfirmationRequired(): never {
  throw new Error(CUSTOMER_DATA_CHANGE_RECONFIRMATION_CODE);
}

/** Additive, idempotent tables for short-lived confirmations and immutable history. */
export async function ensureCustomerDataChangeSchema(): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Datenbankverbindung für Kundendatenänderungen nicht verfügbar");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_data_change_confirmations (
      token_hash VARCHAR(64) PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      match_method VARCHAR(24) NOT NULL CHECK (match_method IN ('email', 'phone', 'email_and_phone')),
      previous_snapshot_json TEXT NOT NULL,
      submitted_snapshot_json TEXT NOT NULL,
      changed_fields_json TEXT NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      consumed_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS customer_data_change_confirmations_customer_idx
      ON customer_data_change_confirmations (customer_id, expires_at DESC);
    CREATE INDEX IF NOT EXISTS customer_data_change_confirmations_expiry_idx
      ON customer_data_change_confirmations (expires_at);

    CREATE TABLE IF NOT EXISTS customer_data_change_events (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      order_id VARCHAR(32) NOT NULL,
      match_method VARCHAR(24) NOT NULL CHECK (match_method IN ('email', 'phone', 'email_and_phone')),
      previous_snapshot_json TEXT NOT NULL,
      submitted_snapshot_json TEXT NOT NULL,
      changed_fields_json TEXT NOT NULL,
      customer_confirmed_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS customer_data_change_events_customer_idx
      ON customer_data_change_events (customer_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS customer_data_change_events_order_idx
      ON customer_data_change_events (order_id, created_at DESC);
  `);
  console.log("[CustomerDataChange] Confirmation and immutable history schema ready");
}

/**
 * Returns a random short-lived confirmation token. The token itself is never
 * stored, only its SHA-256 hash. A newer preview supersedes a previous token
 * for the same customer to keep the one-action checkout flow deterministic.
 */
export async function createCustomerDataChangeConfirmation(
  db: any,
  resolution: Extract<CheckoutCustomerDataChangeResolution, { kind: "matched" }>,
): Promise<{ confirmationToken: string; expiresAt: Date }> {
  if (!resolution.requiresConfirmation) throw new Error("Keine Kundendatenbestätigung erforderlich");
  const confirmationToken = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + CUSTOMER_DATA_CHANGE_CONFIRMATION_TTL_MS);
  await db.execute(sql`
    DELETE FROM customer_data_change_confirmations
    WHERE expires_at < NOW() OR customer_id = ${resolution.customer.id}
  `);
  await db.execute(sql`
    INSERT INTO customer_data_change_confirmations (
      token_hash, customer_id, match_method, previous_snapshot_json,
      submitted_snapshot_json, changed_fields_json, expires_at
    ) VALUES (
      ${tokenHash(confirmationToken)}, ${resolution.customer.id}, ${resolution.matchedBy},
      ${snapshotJson(resolution.previousSnapshot)}, ${snapshotJson(resolution.submittedSnapshot)},
      ${fieldsJson(resolution.changedFields)}, ${expiresAt}
    )
  `);
  return { confirmationToken, expiresAt };
}

/**
 * Locks and consumes a confirmation inside the order transaction. The current
 * resolution must exactly match the preview snapshot; stale, replayed or
 * manipulated browser tokens are rejected before order persistence.
 */
export async function consumeCustomerDataChangeConfirmation(
  db: any,
  confirmationToken: string | null | undefined,
  resolution: Extract<CheckoutCustomerDataChangeResolution, { kind: "matched" }>,
): Promise<void> {
  if (!resolution.requiresConfirmation) return;
  if (!confirmationToken) throwReconfirmationRequired();

  const expectedPrevious = snapshotJson(resolution.previousSnapshot);
  const expectedSubmitted = snapshotJson(resolution.submittedSnapshot);
  const expectedFields = fieldsJson(resolution.changedFields);
  const locked = await db.execute(sql`
    SELECT token_hash, customer_id, match_method, previous_snapshot_json,
           submitted_snapshot_json, changed_fields_json, expires_at, consumed_at
    FROM customer_data_change_confirmations
    WHERE token_hash = ${tokenHash(confirmationToken)}
    FOR UPDATE
  `);
  const row = locked.rows?.[0];
  if (!row
    || Number(row.customer_id) !== resolution.customer.id
    || row.match_method !== resolution.matchedBy
    || row.previous_snapshot_json !== expectedPrevious
    || row.submitted_snapshot_json !== expectedSubmitted
    || row.changed_fields_json !== expectedFields
    || row.consumed_at
    || new Date(row.expires_at).getTime() <= Date.now()) {
    throwReconfirmationRequired();
  }

  const consumed = await db.execute(sql`
    UPDATE customer_data_change_confirmations
       SET consumed_at = NOW()
     WHERE token_hash = ${tokenHash(confirmationToken)}
       AND consumed_at IS NULL
  `);
  if ((consumed.rowCount ?? 0) !== 1) throwReconfirmationRequired();
}

/** Writes the immutable event after the order exists and updates only the matched customer. */
export async function persistConfirmedCustomerDataChange(
  db: any,
  input: {
    customerId: number;
    orderId: string;
    matchedBy: CustomerMatchMethod;
    previousSnapshot: CustomerDataSnapshot;
    submittedSnapshot: CustomerDataSnapshot;
    changedFields: CustomerDataChangeField[];
  },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO customer_data_change_events (
      customer_id, order_id, match_method, previous_snapshot_json,
      submitted_snapshot_json, changed_fields_json, customer_confirmed_at
    ) VALUES (
      ${input.customerId}, ${input.orderId}, ${input.matchedBy},
      ${snapshotJson(input.previousSnapshot)}, ${snapshotJson(input.submittedSnapshot)},
      ${fieldsJson(input.changedFields)}, NOW()
    )
  `);
}

export function toCustomerUpdateFromSnapshot(snapshot: CustomerDataSnapshot) {
  return {
    name: snapshot.name,
    firstName: snapshot.firstName || null,
    lastName: snapshot.lastName || null,
    email: snapshot.email || null,
    phone: snapshot.phone || null,
    company: snapshot.company || null,
    street: snapshot.street || null,
    houseNumber: snapshot.houseNumber || null,
    zip: snapshot.zip || null,
    city: snapshot.city || null,
    country: snapshot.country || null,
    dhlPostNumber: snapshot.dhlPostNumber || null,
    updatedAt: new Date(),
  };
}
