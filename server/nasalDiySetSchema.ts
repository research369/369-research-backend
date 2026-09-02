import { getPool } from "./db.js";

/**
 * Additive, idempotente Persistenz für die Kennzeichnung des Nasenspray Kits.
 * Der Konfigurationswert wird durch eine versionierte Datenmigration angelegt
 * und danach ausschließlich als WaWi-Einstellung gepflegt. So bleiben
 * Produktfreigaben und Komponenten außerhalb des Anwendungscodes führend.
 */
export async function ensureNasalDiySetSchema(): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Datenbankverbindung für Nasenspray Kit nicht verfügbar");

  await pool.query(`
    ALTER TABLE order_items
      ADD COLUMN IF NOT EXISTS is_nasal_diy_set BOOLEAN NOT NULL DEFAULT FALSE;
  `);

}
