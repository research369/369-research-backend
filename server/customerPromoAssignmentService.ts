import { sql, type SQL } from "drizzle-orm";
import { getPool } from "./db.js";

/**
 * Persönliche Aktionscodes sind reguläre promo_codes mit zusätzlicher
 * Ausstellungs-Historie. Die Zuordnung dokumentiert ausschließlich, aus
 * welcher Bestellung und Kundenakte der Code vergeben wurde.
 *
 * Die Einlösung ist bewusst nicht an E-Mail, Telefonnummer, Namen oder
 * Lieferadresse gebunden: Wer einen gültigen Code besitzt, kann ihn gemäß
 * seiner allgemeinen Codebedingungen einlösen.
 */
export type PersonalPromoAssignmentSummary = {
  id: number;
  promoCodeId: number;
  customerId: number;
  customerName: string;
  originOrderId: string;
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
  "percentage" | "fixedAmount" | "minOrder" | "maxUses" | "currentUses" | "validUntilExact" | "isActive"
> & {
  percentage: string | number | null;
  fixedAmount: string | number | null;
  minOrder: string | number | null;
  maxUses: number | null;
  currentUses: number | null;
  validUntilExact: number | null;
  isActive: number | null;
};

export type NewPersonalPromoAssignment = {
  promoCodeId: number;
  customerId: number;
  originOrderId: string;
  createdBy: string;
};

/**
 * Deliberately contains provenance only. Contact fields must never be added
 * here: possession of a valid issued code is sufficient for redemption.
 */
export function buildPersonalPromoAssignment(input: NewPersonalPromoAssignment): NewPersonalPromoAssignment {
  return {
    promoCodeId: input.promoCodeId,
    customerId: input.customerId,
    originOrderId: input.originOrderId,
    createdBy: input.createdBy,
  };
}

function mapAssignment(row: PersonalPromoAssignmentRow): PersonalPromoAssignmentSummary {
  return {
    ...row,
    percentage: Number(row.percentage || 0),
    fixedAmount: Number(row.fixedAmount || 0),
    minOrder: Number(row.minOrder || 0),
    maxUses: Number(row.maxUses || 0),
    currentUses: Number(row.currentUses || 0),
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

/**
 * Additive, idempotent persistent storage for issued personal action codes.
 * Existing installations can retain legacy contact columns without using them;
 * the old CHECK constraint is removed so a current order may issue a code
 * without an e-mail address or telephone number.
 */
export async function ensureCustomerPromoAssignmentSchema(): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Datenbankverbindung für persönliche Aktionscodes nicht verfügbar");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_promo_assignments (
      id SERIAL PRIMARY KEY,
      promo_code_id INTEGER NOT NULL UNIQUE REFERENCES promo_codes(id) ON DELETE RESTRICT,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
      origin_order_id VARCHAR(32) NOT NULL REFERENCES orders(order_id) ON DELETE RESTRICT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      created_by VARCHAR(100) NOT NULL
    );

    CREATE INDEX IF NOT EXISTS customer_promo_assignments_origin_order_idx
      ON customer_promo_assignments (origin_order_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS customer_promo_assignments_customer_idx
      ON customer_promo_assignments (customer_id, created_at DESC);

    DO $$
    DECLARE
      legacy_constraint_name text;
    BEGIN
      SELECT constraint_name
        INTO legacy_constraint_name
        FROM pg_constraint
       WHERE conrelid = 'customer_promo_assignments'::regclass
         AND contype = 'c'
         AND (
           pg_get_constraintdef(oid) ILIKE '%email_normalized%'
           OR pg_get_constraintdef(oid) ILIKE '%phone_normalized%'
         )
       LIMIT 1;

      IF legacy_constraint_name IS NOT NULL THEN
        EXECUTE format(
          'ALTER TABLE customer_promo_assignments DROP CONSTRAINT %I',
          legacy_constraint_name
        );
      END IF;
    END $$;
  `);

  console.log("[CustomerPromoAssignments] Schema ready (provenance-only, no contact binding)");
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
 * Query from inside the checkout transaction. It remains available for safe
 * provenance reads, but performs no contact match or personal use-limit check.
 */
export async function getPersonalPromoAssignmentForCodeInTransaction(
  db: { execute: (query: SQL) => Promise<unknown> },
  promoCodeId: number,
): Promise<PersonalPromoAssignmentSummary | null> {
  const raw = await db.execute(sql`${sql.raw(assignmentSelect)} WHERE assignment.promo_code_id = ${promoCodeId} FOR UPDATE`) as { rows?: PersonalPromoAssignmentRow[] } | PersonalPromoAssignmentRow[];
  const rows = Array.isArray(raw) ? raw : (raw.rows || []);
  return rows.length > 0 ? mapAssignment(rows[0]) : null;
}

export async function getPersonalPromoAssignmentForCode(promoCodeId: number): Promise<PersonalPromoAssignmentSummary | null> {
  const rows = await queryAssignments(`${assignmentSelect} WHERE assignment.promo_code_id = $1 LIMIT 1`, [promoCodeId]);
  return rows[0] ?? null;
}
