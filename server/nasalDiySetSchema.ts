import { getPool } from "./db.js";
import {
  NASAL_DIY_SET_COMPONENTS,
  NASAL_DIY_SET_ELIGIBLE_PRODUCT_IDS,
  NASAL_DIY_SET_SURCHARGE,
} from "./nasalDiySetConfig.js";

/**
 * Additive, idempotent persistence for DIY-nasal-set order flags.
 * The setting is documentation/configuration for future maintenance; order creation
 * continues to validate server-side against the same centrally maintained contract.
 */
export async function ensureNasalDiySetSchema(): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Datenbankverbindung für DIY-Nasenspray-Set nicht verfügbar");

  await pool.query(`
    ALTER TABLE order_items
      ADD COLUMN IF NOT EXISTS is_nasal_diy_set BOOLEAN NOT NULL DEFAULT FALSE;
  `);

  const config = JSON.stringify({
    version: 1,
    surcharge: NASAL_DIY_SET_SURCHARGE,
    eligibleProductIds: [...NASAL_DIY_SET_ELIGIBLE_PRODUCT_IDS],
    components: NASAL_DIY_SET_COMPONENTS,
  });
  await pool.query(
    `INSERT INTO shop_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO NOTHING`,
    ["nasal_diy_set_config_v1", config],
  );
}
