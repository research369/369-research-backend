import { readFileSync } from "node:fs";
import { getPool } from "./db.js";
let ready = false;
export const isPermissionsSchemaReady = () => ready;
export const permissionsSchemaSql = readFileSync(new URL("../drizzle/migrations/20261106_permissions_hardening.sql", import.meta.url), "utf8");
export async function ensurePermissionsSchema(): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Permissions database unavailable");
  await pool.query(permissionsSchemaSql);
  ready = true;
}
