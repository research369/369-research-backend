import { getPool } from "./db.js";
import { markDhlRelabelSchemaUnavailable } from "./dhlRelabelSchema.js";

/** Deliberately excludes documents, tracking, addresses, snapshots and actors. */
export interface DhlLabelLifecycleSummary {
  generationId: string | null;
  state: string;
  blocked: boolean;
}

/** A null summary preserves the original behavior of unarchived legacy labels. */
export function isDhlLabelLifecycleUsable(summary: DhlLabelLifecycleSummary | null): boolean {
  return summary === null || (!summary.blocked && ["active", "cancel_rejected", "manifested"].includes(summary.state));
}

interface LifecycleRow {
  order_id: string;
  generation_id: string | null;
  state: string | null;
  blocked: boolean;
}

/**
 * One parameterized SELECT, no per-order store/lock, lazy archive or DHL call.
 * Missing entries mean no current non-rejected generation and no unresolved
 * operation: callers attach `map.get(orderId) ?? null` for legacy behavior.
 * Unreadable ledger/DB returns unknown+blocked for every requested ID without
 * failing the order list. Only schema/permission errors clear schema readiness;
 * transient DB failures do not invalidate the successful initialization marker.
 * Callers must supply only DHL/DHL_PENDING orders, not other carriers.
 */
export async function getDhlLabelLifecycleForOrders(
  orderIds: readonly string[],
): Promise<Map<string, DhlLabelLifecycleSummary>> {
  const ids = [...new Set(orderIds)];
  const summaries = new Map<string, DhlLabelLifecycleSummary>();
  if (!ids.length) return summaries;

  try {
    const pool = await getPool();
    if (!pool) throw new Error("DHL label ledger database unavailable");
    const result = await pool.query<LifecycleRow>(`
      SELECT requested.order_id, current_generation.id AS generation_id,
             current_generation.state,
             EXISTS (
               SELECT 1 FROM dhl_label_operations AS operation
               WHERE operation.order_id = requested.order_id
                 AND operation.state IN ('pending', 'unknown')
             ) AS blocked
      FROM unnest($1::varchar[]) AS requested(order_id)
      LEFT JOIN LATERAL (
        SELECT generation.id, generation.state
        FROM dhl_label_generations AS generation
        WHERE generation.order_id = requested.order_id
          AND generation.state <> 'create_rejected'
        ORDER BY generation.generation DESC
        LIMIT 1
      ) AS current_generation ON TRUE
    `, [ids]);
    for (const row of result.rows) {
      if (row.generation_id === null && !row.blocked) continue;
      summaries.set(row.order_id, {
        generationId: row.generation_id,
        state: row.state ?? "unknown",
        blocked: row.blocked,
      });
    }
    return summaries;
  } catch (error) {
    // Never serialize DB errors or accidentally restore legacy label validity.
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "42P01" || code === "3F000" || code === "42501") {
      markDhlRelabelSchemaUnavailable();
    }
    return new Map(ids.map(id => [id, { generationId: null, state: "unknown", blocked: true }]));
  }
}
