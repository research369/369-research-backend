import { sql, type SQL } from "drizzle-orm";
import { getPool } from "./db.js";

/**
 * A checkout refusal is deliberately based only on explicit, active records in
 * customer_order_blocks. Names and addresses are never matched: they are too
 * ambiguous and must not cause a different customer to be rejected.
 */
export const CUSTOMER_ORDER_BLOCKED_CODE = "CUSTOMER_ORDER_BLOCKED";

const PLACEHOLDER_EMAILS = new Set([
  "",
  "keine@angabe.de",
  "noemail@noemail.de",
  "no@email.de",
  "otc@369research.eu",
]);

export type CustomerOrderBlock = {
  id: number;
  customerId: number;
  status: "active" | "revoked";
  reason: string;
  emailNormalized: string | null;
  phoneNormalized: string | null;
  createdAt: Date;
  createdBy: string;
  revokedAt: Date | null;
  revokedBy: string | null;
};

export type CustomerOrderBlockSummary = Pick<
  CustomerOrderBlock,
  "id" | "customerId" | "status" | "reason" | "createdAt" | "createdBy"
>;

export function normalizeBlockedEmail(value: string | null | undefined): string | null {
  const normalized = (value || "").trim().toLowerCase();
  if (!normalized || PLACEHOLDER_EMAILS.has(normalized)) return null;
  return normalized;
}

/**
 * Accepts normal international formats and normalizes common German local
 * spellings so 017x and +49 17x identify the same explicitly blocked person.
 */
export function normalizeBlockedPhone(value: string | null | undefined): string | null {
  let digits = (value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `49${digits.replace(/^0+/, "")}`;
  if (digits.length < 8) return null;
  return digits;
}

export function getBlockIdentifiers(input: { email?: string | null; phone?: string | null }) {
  return {
    emailNormalized: normalizeBlockedEmail(input.email),
    phoneNormalized: normalizeBlockedPhone(input.phone),
  };
}

export function hasUsableBlockIdentifier(input: { email?: string | null; phone?: string | null }): boolean {
  const identifiers = getBlockIdentifiers(input);
  return Boolean(identifiers.emailNormalized || identifiers.phoneNormalized);
}

function advisoryKeys(input: { email?: string | null; phone?: string | null }): string[] {
  const identifiers = getBlockIdentifiers(input);
  return [
    ...(identifiers.emailNormalized ? [`customer-order-block:email:${identifiers.emailNormalized}`] : []),
    ...(identifiers.phoneNormalized ? [`customer-order-block:phone:${identifiers.phoneNormalized}`] : []),
  ];
}

export function isActiveBlockMatch(
  block: Pick<CustomerOrderBlock, "status" | "emailNormalized" | "phoneNormalized">,
  input: { email?: string | null; phone?: string | null },
): boolean {
  if (block.status !== "active") return false;
  const identifiers = getBlockIdentifiers(input);
  return Boolean(
    (identifiers.emailNormalized && block.emailNormalized === identifiers.emailNormalized)
    || (identifiers.phoneNormalized && block.phoneNormalized === identifiers.phoneNormalized),
  );
}

/** Additive, idempotent persistent storage for explicit customer blocks. */
export async function ensureCustomerOrderBlockSchema(): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Datenbankverbindung für Kundensperren nicht verfügbar");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_order_blocks (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
      reason TEXT NOT NULL,
      email_normalized VARCHAR(320),
      phone_normalized VARCHAR(32),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      created_by VARCHAR(100) NOT NULL,
      revoked_at TIMESTAMP,
      revoked_by VARCHAR(100),
      CHECK (email_normalized IS NOT NULL OR phone_normalized IS NOT NULL)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS customer_order_blocks_one_active_customer_idx
      ON customer_order_blocks (customer_id)
      WHERE status = 'active';

    CREATE INDEX IF NOT EXISTS customer_order_blocks_active_email_idx
      ON customer_order_blocks (email_normalized)
      WHERE status = 'active' AND email_normalized IS NOT NULL;

    CREATE INDEX IF NOT EXISTS customer_order_blocks_active_phone_idx
      ON customer_order_blocks (phone_normalized)
      WHERE status = 'active' AND phone_normalized IS NOT NULL;
  `);

  console.log("[CustomerOrderBlocks] Schema ready");
}

export async function getActiveCustomerOrderBlocksForCustomers(customerIds: number[]): Promise<Map<number, CustomerOrderBlockSummary>> {
  if (customerIds.length === 0) return new Map();
  const pool = await getPool();
  if (!pool) throw new Error("Datenbankverbindung für Kundensperren nicht verfügbar");

  const result = await pool.query<CustomerOrderBlockSummary>(
    `SELECT id,
            customer_id AS "customerId",
            status,
            reason,
            created_at AS "createdAt",
            created_by AS "createdBy"
       FROM customer_order_blocks
      WHERE status = 'active' AND customer_id = ANY($1::int[])`,
    [customerIds],
  );
  return new Map(result.rows.map((block) => [block.customerId, block]));
}

export async function getActiveCustomerOrderBlockForCustomer(customerId: number): Promise<CustomerOrderBlockSummary | null> {
  const blocks = await getActiveCustomerOrderBlocksForCustomers([customerId]);
  return blocks.get(customerId) ?? null;
}

export async function activateCustomerOrderBlock(input: {
  customerId: number;
  email?: string | null;
  phone?: string | null;
  reason: string;
  actor: string;
}): Promise<CustomerOrderBlockSummary> {
  const identifiers = getBlockIdentifiers(input);
  if (!identifiers.emailNormalized && !identifiers.phoneNormalized) {
    throw new Error("Kundensperre benötigt eine gültige E-Mail-Adresse oder Telefonnummer");
  }

  const pool = await getPool();
  if (!pool) throw new Error("Datenbankverbindung für Kundensperren nicht verfügbar");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const key of advisoryKeys(input)) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
    }
    const result = await client.query<CustomerOrderBlockSummary>(
      `INSERT INTO customer_order_blocks
         (customer_id, status, reason, email_normalized, phone_normalized, created_by)
       VALUES ($1, 'active', $2, $3, $4, $5)
       ON CONFLICT (customer_id) WHERE status = 'active'
       DO UPDATE SET
         reason = EXCLUDED.reason,
         email_normalized = EXCLUDED.email_normalized,
         phone_normalized = EXCLUDED.phone_normalized,
         created_by = EXCLUDED.created_by,
         created_at = NOW(),
         revoked_at = NULL,
         revoked_by = NULL
       RETURNING id,
                 customer_id AS "customerId",
                 status,
                 reason,
                 created_at AS "createdAt",
                 created_by AS "createdBy"`,
      [
        input.customerId,
        input.reason.trim(),
        identifiers.emailNormalized,
        identifiers.phoneNormalized,
        input.actor,
      ],
    );
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function revokeCustomerOrderBlock(input: {
  customerId: number;
  actor: string;
}): Promise<boolean> {
  const pool = await getPool();
  if (!pool) throw new Error("Datenbankverbindung für Kundensperren nicht verfügbar");
  const result = await pool.query(
    `UPDATE customer_order_blocks
        SET status = 'revoked',
            revoked_at = NOW(),
            revoked_by = $2
      WHERE customer_id = $1 AND status = 'active'`,
    [input.customerId, input.actor],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Server-side checkout guard. It intentionally compares only values persisted
 * when an operator explicitly enabled a block. A missing field can never match.
 */
export async function findActiveCheckoutBlock(input: {
  email?: string | null;
  phone?: string | null;
}): Promise<Pick<CustomerOrderBlock, "id" | "customerId"> | null> {
  const identifiers = getBlockIdentifiers(input);
  if (!identifiers.emailNormalized && !identifiers.phoneNormalized) return null;

  const pool = await getPool();
  if (!pool) throw new Error("Datenbankverbindung für Kundensperren nicht verfügbar");

  const result = await pool.query<Pick<CustomerOrderBlock, "id" | "customerId">>(
    `SELECT id, customer_id AS "customerId"
       FROM customer_order_blocks
      WHERE status = 'active'
        AND (
          ($1::varchar IS NOT NULL AND email_normalized = $1)
          OR ($2::varchar IS NOT NULL AND phone_normalized = $2)
        )
      LIMIT 1`,
    [identifiers.emailNormalized, identifiers.phoneNormalized],
  );
  return result.rows[0] ?? null;
}

/**
 * Must run in the same transaction that writes the order. The same advisory
 * keys are acquired while an operator creates a block, closing the race between
 * the initial pre-check and order persistence.
 */
export async function assertNoActiveCheckoutBlock(
  db: { execute: (query: SQL) => Promise<unknown> },
  input: { email?: string | null; phone?: string | null },
): Promise<void> {
  const identifiers = getBlockIdentifiers(input);
  if (!identifiers.emailNormalized && !identifiers.phoneNormalized) return;

  for (const key of advisoryKeys(input)) {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
  }
  const raw = await db.execute(sql`
    SELECT id, customer_id AS "customerId"
      FROM customer_order_blocks
     WHERE status = 'active'
       AND (
         (${identifiers.emailNormalized}::varchar IS NOT NULL AND email_normalized = ${identifiers.emailNormalized})
         OR (${identifiers.phoneNormalized}::varchar IS NOT NULL AND phone_normalized = ${identifiers.phoneNormalized})
       )
     LIMIT 1
  `) as { rows?: Array<{ id: number; customerId: number }> } | Array<{ id: number; customerId: number }>;
  const rows = Array.isArray(raw) ? raw : (raw.rows ?? []);
  if (rows.length > 0) throw new Error(CUSTOMER_ORDER_BLOCKED_CODE);
}
