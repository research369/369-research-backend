import { readFileSync } from "node:fs";
import { getPool } from "./db.js";
let ready = false;
export const isPermissionsSchemaReady = () => ready;
export const permissionsSchemaSql = readFileSync(new URL("../drizzle/migrations/20261106_permissions_hardening.sql", import.meta.url), "utf8");
export const campaignAccountPermissionsSchemaSql = readFileSync(new URL("../drizzle/migrations/20261112_campaign_account_permissions.sql", import.meta.url), "utf8");
export async function ensurePermissionsSchema(): Promise<void> {
  ready = false;
  const pool = await getPool();
  if (!pool) throw new Error("Permissions database unavailable");
  await pool.query(permissionsSchemaSql);
  await pool.query(campaignAccountPermissionsSchemaSql);
  ready = true;
}
