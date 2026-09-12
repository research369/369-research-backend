/**
 * backupService.ts – automatische, speichersichere PostgreSQL-Backups
 *
 * Der frühere Export sammelte bis zu 50.000 Zeilen mehrerer Tabellen in einem
 * Objekt und serialisierte dieses als eine JSON-Zeichenkette. Große Packfotos,
 * Label-PDFs oder Rechnungstexte können so die V8-Zeichenkettenobergrenze
 * überschreiten. Der Export arbeitet daher tabellenweise, paginiert und in
 * kleinen gzip-komprimierten, wiederherstellbaren JSON-Teilen.
 */

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { Pool, type PoolClient } from "pg";
import { ENV } from "./env.js";

const BACKUP_EMAIL = "369rebackup@gmail.com";
const RESEND_API_URL = "https://api.resend.com/emails";

// Der JSON-Teil bleibt absichtlich weit unter der Resend-Anhangsgrenze. Auch
// Base64-Kodierung und der E-Mail-Request bleiben damit speicherschonend.
const MAX_JSON_PART_BYTES = 6 * 1024 * 1024;
const PAGE_SIZE = 10;
const BACKUP_FORMAT = "369-research-postgres-json";
const BACKUP_FORMAT_VERSION = 2;

// E-Mail-Anhänge sind kein tragfähiges Langzeitarchiv für große Binärnachweise.
// Der Export bleibt nur mit expliziter Betriebsfreigabe aktiv; die robuste
// Standardsicherung erfolgt über die konfigurierte PostgreSQL-Volumesicherung.
const EMAIL_ARCHIVE_EXPORT_ENABLED = process.env.DATABASE_BACKUP_EMAIL_EXPORT === "true";

interface BackupGroup {
  name: string;
  tables: string[];
}

// Alle aktuellen Fach-Tabellen werden explizit einer Gruppe zugeordnet. Neu
// auftauchende öffentliche Tabellen landen zusätzlich sicher in "System".
const BACKUP_GROUPS: BackupGroup[] = [
  {
    name: "Bestellungen & Versand",
    tables: [
      "orders", "order_items", "order_item_batches", "packing_photo_history",
      "invoices", "customer_communications", "customer_issue_cases",
      "communication_events", "sales_followups", "sales_followup_products",
    ],
  },
  {
    name: "Kunden, Partner & Kommunikation",
    tables: [
      "customers", "customer_tag_definitions", "partners", "partner_transactions",
      "partner_code_usage", "partner_order_credit_overrides", "duplicate_check_runs",
      "duplicate_findings", "communication_templates", "communication_template_audit",
      "email_campaigns", "email_templates",
    ],
  },
  {
    name: "Artikel, Lager & Inhalte",
    tables: [
      "articles", "article_bundle_items", "article_bundles", "article_comparisons",
      "article_faq", "article_merchant", "article_seo", "article_studies", "article_tags",
      "article_translations", "article_use_cases", "batches", "stock_history",
      "purchase_orders", "purchase_order_items", "categories", "category_translations",
      "use_cases", "use_case_translations",
    ],
  },
  {
    name: "System & Konfiguration",
    tables: ["promo_codes", "shop_settings", "users", "product_audit_log"],
  },
];

interface BackupPartPayload {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_FORMAT_VERSION;
  generatedAt: string;
  group: string;
  part: number;
  tables: Record<string, unknown[]>;
}

interface BackupPartBuilder {
  tables: Record<string, unknown[]>;
  approximateRowBytes: number;
  rowCount: number;
}

interface BackupRunResult {
  success: boolean;
  parts: number;
  rows: number;
  errors: string[];
  durationSeconds: number;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) {
    throw new Error(`Ungültiger Tabellenname im Backup: ${identifier}`);
  }
  return `"${identifier}"`;
}

function createPartBuilder(): BackupPartBuilder {
  return { tables: {}, approximateRowBytes: 0, rowCount: 0 };
}

function hasRows(builder: BackupPartBuilder): boolean {
  return builder.rowCount > 0;
}

/**
 * Baut bewusst kleine, eigenständige JSON-Archive. Ein Teil enthält eine
 * Tabellenmappe und kann nach gunzip + JSON.parse ohne Spezialformat gelesen
 * oder wiederhergestellt werden.
 */
export function buildBackupPart(
  generatedAt: string,
  group: string,
  part: number,
  tables: Record<string, unknown[]>
): { gzippedBase64: string; jsonBytes: number; gzipBytes: number; checksum: string } {
  const payload: BackupPartPayload = {
    format: BACKUP_FORMAT,
    version: BACKUP_FORMAT_VERSION,
    generatedAt,
    group,
    part,
    tables,
  };
  const json = JSON.stringify(payload);
  const jsonBytes = Buffer.byteLength(json, "utf8");
  const gzipped = gzipSync(Buffer.from(json, "utf8"), { level: 9 });
  return {
    gzippedBase64: gzipped.toString("base64"),
    jsonBytes,
    gzipBytes: gzipped.byteLength,
    checksum: createHash("sha256").update(gzipped).digest("hex"),
  };
}

async function sendEmail(payload: {
  subject: string;
  text: string;
  attachment?: { filename: string; content: string };
}): Promise<void> {
  const response = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ENV.resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "backup@369research.eu",
      to: [BACKUP_EMAIL],
      subject: payload.subject,
      text: payload.text,
      ...(payload.attachment ? { attachments: [payload.attachment] } : {}),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Resend API Fehler ${response.status}: ${errorText.slice(0, 300)}`);
  }
}

async function listPublicTables(client: PoolClient): Promise<string[]> {
  const result = await client.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name ASC
  `);
  return result.rows.map((row) => row.table_name);
}

function groupTables(tableNames: string[]): Array<BackupGroup & { tables: string[] }> {
  const assigned = new Set<string>();
  const groups = BACKUP_GROUPS.map((group) => {
    const tables = group.tables.filter((table) => tableNames.includes(table));
    tables.forEach((table) => assigned.add(table));
    return { ...group, tables };
  }).filter((group) => group.tables.length > 0);

  // Beispiele: __drizzle_migrations oder eine künftige, noch nicht klassifizierte
  // App-Tabelle. Damit wird eine neue Tabelle niemals stillschweigend ausgelassen.
  const unassigned = tableNames.filter((table) => !assigned.has(table));
  if (unassigned.length > 0) groups.push({ name: "System & nicht zugeordnete Tabellen", tables: unassigned });
  return groups;
}

async function sendPart(
  builder: BackupPartBuilder,
  generatedAt: string,
  group: string,
  part: number,
  dateStr: string
): Promise<void> {
  const archive = buildBackupPart(generatedAt, group, part, builder.tables);
  const tableSummary = Object.entries(builder.tables)
    .map(([table, rows]) => `  • ${table}: ${rows.length.toLocaleString("de-DE")} Zeilen`)
    .join("\n");
  const displayGroup = group.replace(/[^a-zA-Z0-9]/g, "_");
  const jsonSizeMB = (archive.jsonBytes / 1024 / 1024).toFixed(2);
  const gzipSizeMB = (archive.gzipBytes / 1024 / 1024).toFixed(2);

  await sendEmail({
    subject: `[369 Research] Backup ${dateStr} – ${group}, Teil ${part} (${gzipSizeMB} MB gzip)`,
    text: [
      `369 Research – Datenbank-Backup ${dateStr}`,
      `Gruppe: ${group}`,
      `Teil: ${part}`,
      `Format: ${BACKUP_FORMAT} v${BACKUP_FORMAT_VERSION}`,
      `Zeilen: ${builder.rowCount.toLocaleString("de-DE")}`,
      `JSON-Größe: ${jsonSizeMB} MB`,
      `gzip-Größe: ${gzipSizeMB} MB`,
      `SHA-256 (gzip): ${archive.checksum}`,
      "",
      "Tabellen in diesem Teil:",
      tableSummary,
      "",
      "Wiederherstellung: .json.gz entpacken und den JSON-Teil anhand von format/version/tables einlesen.",
      "Der Archivteil ist eigenständig und enthält keine Zugangsdaten.",
    ].join("\n"),
    attachment: {
      filename: `369research-backup-${dateStr}-${displayGroup}-part-${String(part).padStart(3, "0")}.json.gz`,
      content: archive.gzippedBase64,
    },
  });
}

/**
 * Exportiert alle öffentlichen Tabellen in einer konsistenten PostgreSQL-
 * Snapshot-Transaktion. Gelesen wird in kleinen CTID-Seiten; dadurch entsteht
 * nie wieder eine gruppenweite JSON-Zeichenkette im Arbeitsspeicher.
 */
export async function runDatabaseBackup(): Promise<BackupRunResult> {
  const startTime = Date.now();
  const generatedAt = new Date().toISOString();
  const dateStr = generatedAt.split("T")[0];
  const pool = new Pool({ connectionString: ENV.databaseUrl, ssl: { rejectUnauthorized: false } });
  const errors: string[] = [];
  let totalRows = 0;
  let totalParts = 0;

  if (!EMAIL_ARCHIVE_EXPORT_ENABLED) {
    const message = "E-Mail-Archivexport ist deaktiviert; verwende die geplante PostgreSQL-Volumesicherung statt großer E-Mail-Anhänge";
    console.warn(`[Backup] ${message}`);
    return { success: false, parts: 0, rows: 0, errors: [message], durationSeconds: 0 };
  }

  console.log("[Backup] Starte speichersicheren Datenbank-Backup...");

  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const databaseTables = await listPublicTables(client);
      const groups = groupTables(databaseTables);
      console.log(`[Backup] ${databaseTables.length} öffentliche Tabellen in ${groups.length} Gruppen erkannt`);

      for (const group of groups) {
        let builder = createPartBuilder();
        let part = 0;
        let groupRows = 0;

        const flush = async () => {
          if (!hasRows(builder)) return;
          part += 1;
          totalParts += 1;
          await sendPart(builder, generatedAt, group.name, part, dateStr);
          console.log(`[Backup] ✅ ${group.name}, Teil ${part}: ${builder.rowCount} Zeilen versendet`);
          builder = createPartBuilder();
          // Kleine Pause reduziert Rate-Limits ohne die DB-Snapshot-Konsistenz zu verlieren.
          await new Promise((resolve) => setTimeout(resolve, 750));
        };

        for (const table of group.tables) {
          const quotedTable = quoteIdentifier(table);
          let cursor: string | null = null;
          let tableRows = 0;

          while (true) {
            const pageRows = (await client.query(
              `SELECT ctid::text AS backup_cursor, to_jsonb(source) AS backup_row
               FROM ${quotedTable} AS source
               ${cursor ? "WHERE ctid > $1::tid" : ""}
               ORDER BY ctid ASC
               LIMIT $${cursor ? 2 : 1}`,
              cursor ? [cursor, PAGE_SIZE] : [PAGE_SIZE]
            )).rows as Array<{ backup_cursor: string; backup_row: Record<string, unknown> }>;

            if (pageRows.length === 0) break;

            for (const resultRow of pageRows) {
              const rowJson = JSON.stringify(resultRow.backup_row);
              const rowBytes = Buffer.byteLength(rowJson, "utf8");
              if (rowBytes > MAX_JSON_PART_BYTES) {
                throw new Error(`Einzelzeile in ${table} ist ${Math.ceil(rowBytes / 1024 / 1024)} MB groß und überschreitet die sichere Archivteilgröße`);
              }
              if (hasRows(builder) && builder.approximateRowBytes + rowBytes > MAX_JSON_PART_BYTES) {
                await flush();
              }
              (builder.tables[table] ??= []).push(resultRow.backup_row);
              builder.approximateRowBytes += rowBytes;
              builder.rowCount += 1;
              tableRows += 1;
              groupRows += 1;
              totalRows += 1;
            }

            cursor = pageRows[pageRows.length - 1].backup_cursor;
            if (pageRows.length < PAGE_SIZE) break;
          }
          console.log(`[Backup] ${table}: ${tableRows.toLocaleString("de-DE")} Zeilen erfasst`);
        }

        await flush();
        console.log(`[Backup] Gruppe "${group.name}" abgeschlossen: ${groupRows.toLocaleString("de-DE")} Zeilen, ${part} Teile`);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    const durationSeconds = Number(((Date.now() - startTime) / 1000).toFixed(1));
    await sendEmail({
      subject: `[369 Research] ✅ Backup vollständig – ${dateStr}`,
      text: [
        "Der tägliche Datenbank-Backup wurde vollständig erstellt.",
        `Zeitpunkt: ${generatedAt}`,
        `Tabellenzeilen: ${totalRows.toLocaleString("de-DE")}`,
        `Archivteile: ${totalParts}`,
        `Dauer: ${durationSeconds}s`,
        "",
        "Die JSON-gzip-Teile sind eigenständige, checksummierte Wiederherstellungsarchive.",
      ].join("\n"),
    });
    console.log(`[Backup] ✅ Vollständig: ${totalRows} Zeilen in ${totalParts} Teilen, ${durationSeconds}s`);
    return { success: true, parts: totalParts, rows: totalRows, errors, durationSeconds };
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    const durationSeconds = Number(((Date.now() - startTime) / 1000).toFixed(1));
    console.error("[Backup] ❌ Kritisch fehlgeschlagen:", message);
    await sendEmail({
      subject: `[369 Research] ⚠️ Backup FEHLGESCHLAGEN – ${dateStr}`,
      text: `Der automatische Datenbank-Backup ist fehlgeschlagen.\n\nFehler: ${message}\n\nBitte prüfen: https://railway.com/project/4c226a12-695b-422e-9282-7df265cb52a3`,
    }).catch(() => {});
    return { success: false, parts: totalParts, rows: totalRows, errors, durationSeconds };
  } finally {
    await pool.end().catch(() => {});
  }
}

/** Startet den täglichen Backup-Job um 03:00 Uhr UTC (05:00 Uhr MESZ). */
export function startBackupScheduler(): void {
  if (!EMAIL_ARCHIVE_EXPORT_ENABLED) {
    console.log("[Backup] E-Mail-Archivscheduler deaktiviert – PostgreSQL-Volumesicherung ist der vorgesehene Betriebsweg");
    return;
  }

  console.log("[Backup] Backup-Scheduler gestartet – täglich um 03:00 Uhr UTC");
  const scheduleNextBackup = () => {
    const now = new Date();
    const next = new Date();
    next.setUTCHours(3, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    const msUntilNext = next.getTime() - now.getTime();
    console.log(`[Backup] Nächster Backup in ${(msUntilNext / 3_600_000).toFixed(1)}h (${next.toISOString()})`);
    setTimeout(async () => {
      await runDatabaseBackup();
      scheduleNextBackup();
    }, msUntilNext);
  };
  scheduleNextBackup();
}
