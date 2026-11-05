import { readFile } from "node:fs/promises";
import { getPool } from "./db.js";

let schemaReady = false;

/** Startup readiness marker; only successful ensure may promote it to true. */
export function isDhlRelabelSchemaReady(): boolean {
  return schemaReady;
}

/** @internal A confirmed schema/permission failure invalidates initialization. */
export function markDhlRelabelSchemaUnavailable(): void {
  schemaReady = false;
}

/** Same SQL at startup and for manual migration; never backfills or rewrites orders. */
export async function ensureDhlRelabelSchema(): Promise<void> {
  schemaReady = false;
  const pool = await getPool();
  if (!pool) throw new Error("Datenbank für DHL-Labelhistorie nicht verfügbar");
  await pool.query(await readFile(new URL("../drizzle/migrations/0031_dhl_label_generations.sql", import.meta.url), "utf8"));
  schemaReady = true;
}
