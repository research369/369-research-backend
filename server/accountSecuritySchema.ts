import { readFileSync } from "node:fs";
import { getPool } from "./db.js";

// One reviewed SQL source for startup and manual migration; no historical ledger edits.
export const ACCOUNT_SECURITY_SQL = readFileSync(new URL("../drizzle/20261106_account_security.sql", import.meta.url), "utf8");
let ready = false;
export function isAccountSecuritySchemaReady(): boolean { return ready; }
export async function ensureAccountSecuritySchema(): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Database not available");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('369:account-security-schema:v1'))");
    await client.query(ACCOUNT_SECURITY_SQL);
    await client.query("COMMIT");
    ready = true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
