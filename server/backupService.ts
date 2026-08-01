/**
 * backupService.ts – Automatische tägliche Datenbank-Backups
 *
 * Läuft täglich um 03:00 Uhr UTC.
 * Teilt den Backup in mehrere E-Mails auf (je Gruppe < 5MB Anhang),
 * um das Resend-Limit von 40MB zu umgehen.
 *
 * Gruppen:
 *  1. Bestellungen (orders, order_items, order_item_batches, failed_orders)
 *  2. Kunden & Partner (customers, partners, partner_transactions, kwk_*)
 *  3. Artikel & Lager (articles, batches, stock_history, purchase_orders, purchase_order_items)
 *  4. Sonstiges (invoices, promo_codes, email_campaigns, sales_followups)
 */

import { Pool } from "pg";
import { ENV } from "./env.js";

const BACKUP_EMAIL = "369rebackup@gmail.com";
const RESEND_API_URL = "https://api.resend.com/emails";

// Tabellengruppen – jede Gruppe wird als eigene E-Mail gesendet
const BACKUP_GROUPS: { name: string; tables: string[] }[] = [
  {
    name: "Bestellungen",
    tables: ["orders", "order_items", "order_item_batches", "failed_orders"],
  },
  {
    name: "Kunden & Partner",
    tables: ["customers", "partners", "partner_transactions", "kwk_accounts", "kwk_ledger", "kwk_referrals"],
  },
  {
    name: "Artikel & Lager",
    tables: ["articles", "batches", "stock_history", "purchase_orders", "purchase_order_items"],
  },
  {
    name: "Sonstiges",
    tables: ["invoices", "promo_codes", "email_campaigns", "sales_followups"],
  },
];

/** Sendet eine einzelne Backup-E-Mail mit Anhang */
async function sendBackupEmail(
  subject: string,
  body: string,
  filename: string,
  jsonBase64: string
): Promise<void> {
  const response = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ENV.resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "backup@369research.eu",
      to: [BACKUP_EMAIL],
      subject,
      text: body,
      attachments: [
        {
          filename,
          content: jsonBase64,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Resend API Fehler ${response.status}: ${errorText.slice(0, 300)}`);
  }
}

/**
 * Exportiert alle Tabellen in Gruppen und sendet je eine E-Mail pro Gruppe.
 */
export async function runDatabaseBackup(): Promise<void> {
  const startTime = Date.now();
  console.log("[Backup] Starte täglichen Datenbank-Backup...");

  const pool = new Pool({
    connectionString: ENV.databaseUrl,
    ssl: { rejectUnauthorized: false },
  });

  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];
  const timeStr = now.toISOString().replace("T", " ").split(".")[0];

  let totalRows = 0;
  let successGroups = 0;
  const errors: string[] = [];

  try {
    for (let i = 0; i < BACKUP_GROUPS.length; i++) {
      const group = BACKUP_GROUPS[i];
      const groupData: Record<string, any[]> = {};
      let groupRows = 0;

      for (const table of group.tables) {
        try {
          const result = await pool.query(`SELECT * FROM ${table} ORDER BY id DESC LIMIT 50000`);
          groupData[table] = result.rows;
          groupRows += result.rows.length;
          console.log(`[Backup] ${table}: ${result.rows.length} Zeilen`);
        } catch (err: any) {
          console.warn(`[Backup] Tabelle ${table} übersprungen: ${err.message}`);
          groupData[table] = [];
        }
      }

      totalRows += groupRows;

      const jsonContent = JSON.stringify(groupData, null, 2);
      const jsonBase64 = Buffer.from(jsonContent, "utf-8").toString("base64");
      const fileSizeMB = (Buffer.byteLength(jsonContent, "utf-8") / 1024 / 1024).toFixed(1);

      const tableSummary = Object.entries(groupData)
        .map(([t, rows]) => `  • ${t}: ${rows.length.toLocaleString("de-DE")} Zeilen`)
        .join("\n");

      const body = `
369 Research – Datenbank-Backup ${dateStr}
Gruppe ${i + 1}/${BACKUP_GROUPS.length}: ${group.name}
=============================================
Datum: ${timeStr} UTC
Zeilen in dieser Gruppe: ${groupRows.toLocaleString("de-DE")}
Dateigröße: ${fileSizeMB} MB

Tabellen:
${tableSummary}

---
Dieser Backup wird täglich um 03:00 Uhr UTC automatisch erstellt.
      `.trim();

      try {
        await sendBackupEmail(
          `[369 Research] Backup ${dateStr} – ${i + 1}/${BACKUP_GROUPS.length}: ${group.name} (${fileSizeMB} MB)`,
          body,
          `369research-backup-${dateStr}-${i + 1}-${group.name.replace(/[^a-zA-Z0-9]/g, "_")}.json`,
          jsonBase64
        );
        console.log(`[Backup] ✅ Gruppe "${group.name}" gesendet: ${groupRows} Zeilen, ${fileSizeMB} MB`);
        successGroups++;
      } catch (emailErr: any) {
        const msg = `Gruppe "${group.name}": ${emailErr.message}`;
        console.error(`[Backup] ❌ E-Mail fehlgeschlagen – ${msg}`);
        errors.push(msg);
      }

      // Kurze Pause zwischen E-Mails (Rate-Limiting)
      if (i < BACKUP_GROUPS.length - 1) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Backup] ✅ Backup abgeschlossen: ${successGroups}/${BACKUP_GROUPS.length} Gruppen, ${totalRows} Zeilen, ${duration}s`);

    if (errors.length > 0) {
      console.error(`[Backup] ⚠️ ${errors.length} Fehler aufgetreten:`, errors.join("; "));
    }

  } catch (err: any) {
    console.error("[Backup] ❌ Backup kritisch fehlgeschlagen:", err.message);

    // Fehler-Benachrichtigung senden
    try {
      await fetch(RESEND_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ENV.resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "backup@369research.eu",
          to: [BACKUP_EMAIL],
          subject: `[369 Research] ⚠️ Backup FEHLGESCHLAGEN – ${dateStr}`,
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
 */
export function startBackupScheduler(): void {
  console.log("[Backup] Backup-Scheduler gestartet – täglich um 03:00 Uhr UTC");

  const scheduleNextBackup = () => {
    const now = new Date();
    const next = new Date();
    next.setUTCHours(3, 0, 0, 0);

    if (next <= now) {
      next.setUTCDate(next.getUTCDate() + 1);
    }

    const msUntilNext = next.getTime() - now.getTime();
    const hoursUntil = (msUntilNext / 1000 / 60 / 60).toFixed(1);

    console.log(`[Backup] Nächster Backup in ${hoursUntil}h (${next.toISOString()})`);

    setTimeout(async () => {
      await runDatabaseBackup();
      scheduleNextBackup();
    }, msUntilNext);
  };

  scheduleNextBackup();
}
