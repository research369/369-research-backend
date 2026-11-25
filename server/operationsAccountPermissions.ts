import { TRPCError } from "@trpc/server";
import { getPool } from "./db.js";
import { isPermissionsSchemaReady } from "./permissionsSchema.js";

export const OPERATIONS_CAPABILITIES = {
  read: "operations_read",
  partnerCredit: "partner_credit_adjust",
  orderCleanup: "order_cleanup",
  campaignSettings: "campaign_settings",
} as const;
export type OperationsCapability = typeof OPERATIONS_CAPABILITIES[keyof typeof OPERATIONS_CAPABILITIES];
type OperationsPrincipal = { id: number; username: string; role: string } | null;

/** Pakko's 2026-11-09 authorization is for one existing account, never a role-wide grant. */
export async function assertOperationsAccountCapability(user: OperationsPrincipal, capability: OperationsCapability): Promise<void> {
  if (!user) throw new TRPCError({ code: "UNAUTHORIZED", message: "Bitte anmelden" });
  // Existing admin access is unchanged, including its startup/readiness contract.
  if (user.role === "admin") return;
  if (user.id !== 2 || user.username !== "product_manager" || user.role !== "product_manager") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Keine kontogebundene Berechtigung" });
  }
  // A flag alone never grants access: the successfully executed mandatory migration
  // and an actual, unrevoked record joined to the current account are both required.
  if (!isPermissionsSchemaReady()) throw new TRPCError({ code: "FORBIDDEN", message: "Berechtigungsschema nicht bereit" });
  const pool = await getPool();
  if (!pool) throw new TRPCError({ code: "FORBIDDEN", message: "Berechtigungsdatenbank nicht verfügbar" });
  try {
    const result = await pool.query(`
      SELECT 1 FROM operations_account_capability_grants AS grant_record
      JOIN users AS account ON account.id = grant_record.user_id
      WHERE grant_record.user_id = $1 AND grant_record.username = $2
        AND grant_record.required_role = $3 AND grant_record.capability = $4
        AND grant_record.revoked_at IS NULL
        AND account.username = $2 AND account.role::text = $3
      LIMIT 1
    `, [user.id, user.username, user.role, capability]);
    if (result.rows.length === 1) return;
  } catch {
    // Never fall back to role access, cache a grant, or expose DB errors.
    throw new TRPCError({ code: "FORBIDDEN", message: "Kontoberechtigung nicht verfügbar" });
  }
  throw new TRPCError({ code: "FORBIDDEN", message: "Keine kontogebundene Berechtigung" });
}
