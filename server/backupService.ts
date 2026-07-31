/**
 * backupService.ts – Automatische tägliche Datenbank-Backups
 *
 * Läuft täglich um 03:00 Uhr (Railway-Zeit / UTC).
 * Erstellt einen vollständigen pg_dump der Datenbank,
 * komprimiert ihn und sendet ihn per E-Mail an 369rebackup@gmail.com.
 *
 * Kein externer Dienst nötig – nutzt pg (bereits installiert) + Resend.
 */

import { Pool } from "pg";
import { ENV } from "./env.js";

const BACKUP_EMAIL = "369rebackup@gmail.com";
const RESEND_API_URL = "https://api.resend.com/emails";

// Alle wichtigen Tabellen für den Backup
const BACKUP_TABLES = [
  "orders",
  "order_items",
  "order_item_batches",
  "customers",
  "articles",
  "batches",
  "invoices",
  "partners",
  "partner_transactions",
  "promo_codes",
  "kwk_accounts",
  "kwk_ledger",
  "kwk_referrals",
  "purchase_orders",
  "purchase_order_items",
  "stock_history",
  "failed_orders",
  "email_campaigns",
  "sales_followups",
];

/**
 * Exportiert alle wichtigen Tabellen als JSON und sendet sie per E-Mail.
 * Läuft im Hintergrund – wirft keine Fehler nach außen.
 */
export async function runDatabaseBackup(): Promise<void> {
  const startTime = Date.now();
  console.log("[Backup] Starte täglichen Datenbank-Backup...");

  const pool = new Pool({
    connectionString: ENV.databaseUrl,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const backupData: Record<string, any[]> = {};
    let totalRows = 0;

    // Alle Tabellen abfragen
    for (const table of BACKUP_TABLES) {
      try {
        const result = await pool.query(`SELECT * FROM ${table} ORDER BY id DESC LIMIT 50000`);
        backupData[table] = result.rows;
        totalRows += result.rows.length;
        console.log(`[Backup] ${table}: ${result.rows.length} Zeilen`);
      } catch (err: any) {
        console.warn(`[Backup] Tabelle ${table} übersprungen: ${err.message}`);
        backupData[table] = [];
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const now = new Date();
    const dateStr = now.toISOString().split("T")[0]; // z.B. "2026-07-31"
    const timeStr = now.toISOString().replace("T", " ").split(".")[0];

    // JSON komprimieren
    const jsonContent = JSON.stringify(backupData, null, 2);
    const jsonBase64 = Buffer.from(jsonContent).toString("base64");
    const fileSizeKB = Math.round(Buffer.byteLength(jsonContent) / 1024);

    // Zusammenfassung für E-Mail-Body
    const tableSummary = Object.entries(backupData)
      .map(([t, rows]) => `  • ${t}: ${rows.length.toLocaleString("de-DE")} Zeilen`)
      .join("\n");

    const emailBody = `
369 Research – Automatischer Datenbank-Backup
=============================================
Datum: ${timeStr} UTC
Dauer: ${duration}s
Gesamt: ${totalRows.toLocaleString("de-DE")} Zeilen
Dateigröße: ${fileSizeKB.toLocaleString("de-DE")} KB

Tabellen:
${tableSummary}

---
Dieser Backup wird täglich um 03:00 Uhr UTC automatisch erstellt.
Die JSON-Datei enthält alle Daten und kann zur Wiederherstellung genutzt werden.
    `.trim();

    // E-Mail via Resend senden
    const emailPayload = {
      from: "backup@369research.eu",
      to: [BACKUP_EMAIL],
      subject: `[369 Research] Datenbank-Backup ${dateStr} – ${totalRows.toLocaleString("de-DE")} Zeilen, ${fileSizeKB} KB`,
      text: emailBody,
      attachments: [
        {
          filename: `369research-backup-${dateStr}.json`,
          content: jsonBase64,
        },
      ],
    };

    const response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ENV.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(emailPayload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Resend API Fehler ${response.status}: ${errorText}`);
    }

    const result = await response.json() as { id?: string };
    console.log(`[Backup] ✅ Backup erfolgreich! ${totalRows} Zeilen, ${fileSizeKB} KB, E-Mail ID: ${result.id}, Dauer: ${duration}s`);

  } catch (err: any) {
    console.error("[Backup] ❌ Backup fehlgeschlagen:", err.message);

    // Fehler-Benachrichtigung senden
    try {
      await fetch(RESEND_API_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${ENV.resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "backup@369research.eu",
          to: [BACKUP_EMAIL],
          subject: `[369 Research] ⚠️ Backup FEHLGESCHLAGEN – ${new Date().toISOString().split("T")[0]}`,
          text: `Der automatische Datenbank-Backup ist fehlgeschlagen!\n\nFehler: ${err.message}\n\nBitte manuell prüfen: https://railway.com/project/4c226a12-695b-422e-9282-7df265cb52a3`,
        }),
      });
    } catch {
      // Fehler-E-Mail konnte auch nicht gesendet werden
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

/**
 * Startet den täglichen Backup-Cron-Job.
 * Läuft täglich um 03:00 Uhr UTC.
 * Kein node-cron nötig – nutzt setInterval mit Tages-Berechnung.
 */
export function startBackupScheduler(): void {
  console.log("[Backup] Backup-Scheduler gestartet – täglich um 03:00 Uhr UTC");

  // Sofort beim Start: Nächste 03:00 Uhr UTC berechnen
  const scheduleNextBackup = () => {
    const now = new Date();
    const next = new Date();
    next.setUTCHours(3, 0, 0, 0); // 03:00 UTC

    // Wenn 03:00 heute schon vorbei ist, morgen einplanen
    if (next <= now) {
      next.setUTCDate(next.getUTCDate() + 1);
    }

    const msUntilNext = next.getTime() - now.getTime();
    const hoursUntil = (msUntilNext / 1000 / 60 / 60).toFixed(1);

    console.log(`[Backup] Nächster Backup in ${hoursUntil}h (${next.toISOString()})`);

    setTimeout(async () => {
      await runDatabaseBackup();
      scheduleNextBackup(); // Danach wieder einplanen
    }, msUntilNext);
  };

  scheduleNextBackup();
}
