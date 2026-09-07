import { getPool } from "./db.js";

export type DatabaseReadiness = {
  ready: boolean;
};

/**
 * Verifiziert die tatsächliche Lesefähigkeit der Datenbank.
 *
 * Diese Prüfung ist bewusst zustandslos und führt ausschließlich `SELECT 1` aus.
 * Sie darf keine Produkt-, Bestell-, Bestands- oder Zahlungsdaten verändern und
 * kann deshalb gefahrlos von externen Verfügbarkeitschecks verwendet werden.
 */
export async function checkDatabaseReadiness(): Promise<DatabaseReadiness> {
  try {
    const pool = await getPool();
    if (!pool) return { ready: false };

    await pool.query("SELECT 1");
    return { ready: true };
  } catch (error) {
    console.error("[Readiness] Datenbankprüfung fehlgeschlagen", error);
    return { ready: false };
  }
}
