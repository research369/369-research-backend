import { sql, type SQL } from "drizzle-orm";
import { getPool } from "./db.js";
import { normalizeBlockedEmail, normalizeBlockedPhone } from "./customerOrderBlockService.js";

/**
 * Persönliche Aktionscodes sind immer zusätzlich zu promo_codes verknüpft.
 * Allgemeine Aktionscodes erhalten keinen Eintrag in dieser Tabelle und
 * behalten dadurch unverändert ihr bisheriges Verhalten.
 */
export const PERSONAL_PROMO_CODE_NOT_AUTHORIZED = "AKTIONSCODE_UNGUELTIG";

export type PersonalPromoContact = {
  email?: string | null;
  phone?: string | null;
};

export type PersonalPromoAssignmentSummary = {
  id: number;
  promoCodeId: number;
  customerId: number;
  customerName: string;
  originOrderId: string;
  emailNormalized: string | null;
  phoneNormalized: string | null;
  maxUsesPerCustomer: number;
  createdAt: Date;
  createdBy: string;
  code: string;
  discountType: "percent" | "fixed";
  percentage: number;
  fixedAmount: number;
  minOrder: number;
  maxUses: number;
  currentUses: number;
  validFrom: Date | null;
  validUntil: Date | null;
  validUntilExact: number;
  isActive: number;
  description: string | null;
};

type PersonalPromoAssignmentRow = Omit<PersonalPromoAssignmentSummary,
  "percentage" | "fixedAmount" | "minOrder" | "maxUses" | "currentUses" | "maxUsesPerCustomer" | "validUntilExact" | "isActive"
> & {
  percentage: string | number | null;
  fixedAmount: string | number | null;
  minOrder: string | number | null;
  maxUses: number | null;
  currentUses: number | null;
  maxUsesPerCustomer: number | null;
  validUntilExact: number | null;
  isActive: number | null;
};

export function getPersonalPromoContact(input: PersonalPromoContact) {
  return {
    emailNormalized: normalizeBlockedEmail(input.email),
    phoneNormalized: normalizeBlockedPhone(input.phone),
  };
}

export function hasPersonalPromoContact(input: PersonalPromoContact): boolean {
  const contact = getPersonalPromoContact(input);
  return Boolean(contact.emailNormalized || contact.phoneNormalized);
}

/**
 * A code is personal when any contact identifier captured during issuance
 * matches the checkout contact. Names and delivery addresses are intentionally
 * never used; neither may broaden an assignment.
 */
export function matchesPersonalPromoContact(
  assignment: Pick<PersonalPromoAssignmentSummary, "emailNormalized" | "phoneNormalized">,
  input: PersonalPromoContact,
): boolean {
  const contact = getPersonalPromoContact(input);
  return Boolean(
    (contact.emailNormalized && assignment.emailNormalized === contact.emailNormalized)
    || (contact.phoneNormalized && assignment.phoneNormalized === contact.phoneNormalized),
  );
}

/** 0 means unlimited. For a personal code, both configured limits must hold. */
export function getEffectivePersonalPromoUseLimit(maxUses: number | null | undefined, maxUsesPerCustomer: number | null | undefined): number {
  const limits = [maxUses, maxUsesPerCustomer]
    .map((value) => Number(value || 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  return limits.length > 0 ? Math.min(...limits) : 0;
}

function mapAssignment(row: PersonalPromoAssignmentRow): PersonalPromoAssignmentSummary {
  return {
    ...row,
    percentage: Number(row.percentage || 0),
    fixedAmount: Number(row.fixedAmount || 0),
    minOrder: Number(row.minOrder || 0),
    maxUses: Number(row.maxUses || 0),
    currentUses: Number(row.currentUses || 0),
    maxUsesPerCustomer: Number(row.maxUsesPerCustomer || 0),
    validUntilExact: Number(row.validUntilExact || 0),
    isActive: Number(row.isActive || 0),
  };
}

const assignmentSelect = `
  SELECT assignment.id,
         assignment.promo_code_id AS "promoCodeId",
         assignment.customer_id AS "customerId",
         customers.name AS "customerName",
         assignment.origin_order_id AS "originOrderId",
         assignment.email_normalized AS "emailNormalized",
         assignment.phone_normalized AS "phoneNormalized",
         assignment.max_uses_per_customer AS "maxUsesPerCustomer",
         assignment.created_at AS "createdAt",
         assignment.created_by AS "createdBy",
         promo.code,
         promo.discount_type AS "discountType",
         promo.percentage,
         promo.fixed_amount AS "fixedAmount",
         promo.min_order AS "minOrder",
         promo.max_uses AS "maxUses",
         promo.current_uses AS "currentUses",
         promo.valid_from AS "validFrom",
         promo.valid_until AS "validUntil",
         promo.valid_until_exact AS "validUntilExact",
         promo.is_active AS "isActive",
         promo.description
    FROM customer_promo_assignments assignment
    JOIN customers ON customers.id = assignment.customer_id
    JOIN promo_codes promo ON promo.id = assignment.promo_code_id
`;

/** Additive, idempotent persistent storage for issued personal action codes. */
export async function ensureCustomerPromoAssignmentSchema(): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Datenbankverbindung für persönliche Aktionscodes nicht verfügbar");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_promo_assignments (
      id SERIAL PRIMARY KEY,
      promo_code_id INTEGER NOT NULL UNIQUE REFERENCES promo_codes(id) ON DELETE RESTRICT,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
      origin_order_id VARCHAR(32) NOT NULL REFERENCES orders(order_id) ON DELETE RESTRICT,
      email_normalized VARCHAR(320),
      phone_normalized VARCHAR(32),
      max_uses_per_customer INTEGER NOT NULL DEFAULT 0 CHECK (max_uses_per_customer >= 0),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      created_by VARCHAR(100) NOT NULL,
      CHECK (email_normalized IS NOT NULL OR phone_normalized IS NOT NULL)
    );

    CREATE INDEX IF NOT EXISTS customer_promo_assignments_origin_order_idx
      ON customer_promo_assignments (origin_order_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS customer_promo_assignments_customer_idx
      ON customer_promo_assignments (customer_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS customer_promo_assignments_email_idx
      ON customer_promo_assignments (email_normalized)
      WHERE email_normalized IS NOT NULL;

    CREATE INDEX IF NOT EXISTS customer_promo_assignments_phone_idx
      ON customer_promo_assignments (phone_normalized)
      WHERE phone_normalized IS NOT NULL;
  `);

  console.log("[CustomerPromoAssignments] Schema ready");
}

async function queryAssignments(query: string, values: unknown[]): Promise<PersonalPromoAssignmentSummary[]> {
  const pool = await getPool();
  if (!pool) throw new Error("Datenbankverbindung für persönliche Aktionscodes nicht verfügbar");
  const result = await pool.query<PersonalPromoAssignmentRow>(query, values);
  return result.rows.map(mapAssignment);
}

export async function getPersonalPromoAssignmentsForOrderIds(orderIds: string[]): Promise<Map<string, PersonalPromoAssignmentSummary[]>> {
  if (orderIds.length === 0) return new Map();
  const rows = await queryAssignments(
    `${assignmentSelect} WHERE assignment.origin_order_id = ANY($1::varchar[]) ORDER BY assignment.created_at DESC`,
    [orderIds],
  );
  const result = new Map<string, PersonalPromoAssignmentSummary[]>();
  for (const row of rows) {
    const entries = result.get(row.originOrderId) || [];
    entries.push(row);
    result.set(row.originOrderId, entries);
  }
  return result;
}

export async function getPersonalPromoAssignmentsForCustomerIds(customerIds: number[]): Promise<Map<number, PersonalPromoAssignmentSummary[]>> {
  if (customerIds.length === 0) return new Map();
  const rows = await queryAssignments(
    `${assignmentSelect} WHERE assignment.customer_id = ANY($1::int[]) ORDER BY assignment.created_at DESC`,
    [customerIds],
  );
  const result = new Map<number, PersonalPromoAssignmentSummary[]>();
  for (const row of rows) {
    const entries = result.get(row.customerId) || [];
    entries.push(row);
    result.set(row.customerId, entries);
  }
  return result;
}

export async function getPersonalPromoAssignmentsForPromoCodeIds(promoCodeIds: number[]): Promise<Map<number, PersonalPromoAssignmentSummary>> {
  if (promoCodeIds.length === 0) return new Map();
  const rows = await queryAssignments(
    `${assignmentSelect} WHERE assignment.promo_code_id = ANY($1::int[])`,
    [promoCodeIds],
  );
  return new Map(rows.map((row) => [row.promoCodeId, row]));
}

/**
 * Query from inside the checkout transaction. FOR UPDATE serializes a personal
 * code's validation and its guarded consumption with a concurrent checkout.
 */
export async function getPersonalPromoAssignmentForCodeInTransaction(
  db: { execute: (query: SQL) => Promise<unknown> },
  promoCodeId: number,
): Promise<PersonalPromoAssignmentSummary | null> {
  const raw = await db.execute(sql`${sql.raw(assignmentSelect)} WHERE assignment.promo_code_id = ${promoCodeId} FOR UPDATE`) as { rows?: PersonalPromoAssignmentRow[] } | PersonalPromoAssignmentRow[];
  const rows = Array.isArray(raw) ? raw : (raw.rows || []);
  return rows.length > 0 ? mapAssignment(rows[0]) : null;
}

/**
 * Public preview uses the same contact match as checkout. It never exposes the
 * identity that owns the code, only the neutral validity result.
 */
export async function getPersonalPromoAssignmentForCode(promoCodeId: number): Promise<PersonalPromoAssignmentSummary | null> {
  const rows = await queryAssignments(`${assignmentSelect} WHERE assignment.promo_code_id = $1 LIMIT 1`, [promoCodeId]);
  return rows[0] ?? null;
}
