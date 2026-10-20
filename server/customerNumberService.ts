import { sql } from "drizzle-orm";
/** No MAX+1 fallback. Migration must precede every upgraded writer. Sequence gaps are intentional. */
export async function nextCustomerNumber(db: any): Promise<string> {
  const result =
    typeof db.execute === "function"
      ? await db.execute(sql`SELECT next_customer_number() AS number`)
      : await db.query("SELECT next_customer_number() AS number");
  const value = result.rows?.[0]?.number ?? result[0]?.number;
  if (!/^\d+$/.test(String(value)) || BigInt(value) < 1210n)
    throw Error("customer_number_unavailable");
  return String(value);
}

/** Preflight before maintenance loops that otherwise deliberately skip individual duplicates. */
export async function requireCustomerNumberMigration(db: any): Promise<void> {
  const result =
    typeof db.execute === "function"
      ? await db.execute(
          sql`SELECT to_regprocedure('next_customer_number()') IS NOT NULL AS ready`,
        )
      : await db.query(
          "SELECT to_regprocedure('next_customer_number()') IS NOT NULL AS ready",
        );
  if ((result.rows?.[0]?.ready ?? result[0]?.ready) !== true)
    throw Error("customer_number_migration_required");
}
