import { getPool } from "./db.js";

/** Public, non-sensitive provenance for the coordinated-release acceptance. */
export const softwareReleaseCheck = "joint-publication-v1";

/** Non-sensitive provenance for the server-worker release acceptance. */
export const serverSoftwareReleaseCheck = "server-joint-publication-20261018-v1";

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
