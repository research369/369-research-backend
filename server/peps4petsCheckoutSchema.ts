import { getPool } from "./db.js";

let peps4petsCheckoutSchemaReady = false;

export function isPeps4petsCheckoutSchemaReady(): boolean {
  return peps4petsCheckoutSchemaReady;
}

/**
 * Additive P4P order metadata. The canonical WaWi order ID remains untouched;
 * P4P gets a separate external customer reference and an evidence-bound key.
 */
export async function ensurePeps4petsCheckoutSchema(): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Datenbank nicht verfügbar");

  await pool.query(`
    ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "store_key" varchar(32) NOT NULL DEFAULT '369research';
    ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "external_order_reference" varchar(32);
    ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "checkout_idempotency_key" varchar(128);
    CREATE UNIQUE INDEX IF NOT EXISTS "orders_external_order_reference_unique"
      ON "orders" ("external_order_reference")
      WHERE "external_order_reference" IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS "orders_checkout_idempotency_key_unique"
      ON "orders" ("checkout_idempotency_key")
      WHERE "checkout_idempotency_key" IS NOT NULL;
    CREATE INDEX IF NOT EXISTS "orders_store_key_idx" ON "orders" ("store_key");
    CREATE SEQUENCE IF NOT EXISTS "peps4pets_order_reference_seq" START WITH 1101;
  `);

  const { rows } = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'orders'
      AND column_name IN ('store_key', 'external_order_reference', 'checkout_idempotency_key')
  `);
  if (rows.length !== 3) throw new Error("Peps4pets-Auftragsschema unvollständig");
  peps4petsCheckoutSchemaReady = true;
}
