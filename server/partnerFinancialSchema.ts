import { readFile } from "node:fs/promises";
import { getPool } from "./db.js";
import type { PartnerCreditQueryClient } from "./partnerCreditService.js";
let ready = false;
export function isPartnerFinancialSchemaReady(): boolean { return ready; }
export async function ensurePartnerFinancialSchema(supplied?: PartnerCreditQueryClient): Promise<void> {
  ready = false;
  const migration = await readFile(new URL("../drizzle/migrations/0034_partner_financial_hardening.sql", import.meta.url), "utf8");
  if (supplied) { await supplied.query(migration); ready = true; return; }
  const pool = await getPool();
  if (!pool) throw new Error("Database not available");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('partner-financial-schema-v1'))");
    await client.query(migration);
    await client.query("COMMIT");
    ready = true;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
