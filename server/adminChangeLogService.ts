import { getPool } from "./db.js";

const SENSITIVE_FIELD =
  /(?:pass(?:word)?|secret|token|api[_-]?key|authorization|cookie|email|phone|iban|bic|address|street|house|zip|city|body|html|message|note|reason|content)/i;
const IDENTITY_FIELD =
  /(?:^|_)(?:id|orderId|articleId|customerId|partnerId|templateId|kwkId|promoCodeId|requestId)(?:$|_)/i;

export type AdminChangeEvent = {
  id: number;
  source: "admin_input" | "product" | "stock" | "template" | "kwk";
  area: string;
  action: string;
  summary: string;
  changedFields: string[];
  actor: string;
  createdAt: Date;
};

/**
 * Additive audit trail for admin mutations. It deliberately keeps no submitted
 * values: values can include customer data, password material or message text.
 * The event records only the protected procedure path and safe field names.
 */
export async function ensureAdminChangeLogSchema(): Promise<void> {
  const pool = await getPool();
  if (!pool)
    throw new Error("Datenbankverbindung für Änderungsverlauf nicht verfügbar");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_change_events (
      id BIGSERIAL PRIMARY KEY,
      action VARCHAR(180) NOT NULL,
      area VARCHAR(80) NOT NULL,
      changed_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
      actor VARCHAR(100) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS admin_change_events_created_at_idx
      ON admin_change_events (created_at DESC);
    CREATE INDEX IF NOT EXISTS admin_change_events_area_created_at_idx
      ON admin_change_events (area, created_at DESC);
  `);
  console.log("[AdminChangeLog] Schema ready");
}

function flattenInputKeys(value: unknown, prefix = "", depth = 0): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 1)
    return [];
  const source = value as Record<string, unknown>;
  return Object.entries(source).flatMap(([key, child]) => {
    const name = prefix ? `${prefix}.${key}` : key;
    if (SENSITIVE_FIELD.test(key)) return [];
    if (IDENTITY_FIELD.test(key)) return [name];
    if (child && typeof child === "object" && !Array.isArray(child))
      return flattenInputKeys(child, name, depth + 1);
    return [name];
  });
}

export function safeChangedFieldNames(input: unknown): string[] {
  return [...new Set(flattenInputKeys(input))].slice(0, 30);
}

function areaForPath(path: string): string {
  const root = path.split(".")[0] || "admin";
  const labels: Record<string, string> = {
    article: "Artikel & Lager",
    bundle: "Bundles",
    customer: "Kunden",
    customerDossier: "Kundenakte",
    customerDataChange: "Kundendaten",
    communicationTemplate: "Vorlagen",
    crmCommunication: "Kommunikation",
    dashboard: "Dashboard",
    followUp: "Follow-ups",
    goodie: "Goodies",
    invoice: "Rechnungen",
    kwk: "Kunden werben Kunden",
    label: "Versandlabels",
    order: "Bestellungen",
    partner: "Partner",
    promoCode: "Aktionscodes",
    purchaseOrder: "Wareneingang",
    qrCampaign: "QR-Kampagnen",
    shopSettings: "Shop-Einstellungen",
    substitution: "Smart Substitution",
    totp: "Sicherheit",
  };
  return labels[root] || "Administration";
}

function humanizeAction(path: string, fields: string[]): string {
  const action = path.split(".").slice(1).join(".") || path;
  const actionText = action
    .replace(/([A-Z])/g, " $1")
    .replace(/[._-]/g, " ")
    .trim();
  return fields.length > 0
    ? `${actionText}: ${fields.join(", ")}`
    : actionText || "Änderung gespeichert";
}

/**
 * Never throws so a successful operational mutation can never be turned into a
 * failed business action because the audit journal is temporarily unavailable.
 */
export async function recordAdminMutation(input: {
  path: string;
  actor: string;
  input: unknown;
}): Promise<void> {
  try {
    const pool = await getPool();
    if (!pool) return;
    const changedFields = safeChangedFieldNames(input);
    await pool.query(
      `INSERT INTO admin_change_events (action, area, changed_fields, actor)
       VALUES ($1, $2, $3::jsonb, $4)`,
      [
        input.path,
        areaForPath(input.path),
        JSON.stringify(changedFields),
        input.actor.slice(0, 100),
      ],
    );
  } catch (error) {
    console.warn(
      "[AdminChangeLog] Event could not be stored (non-fatal):",
      error,
    );
  }
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function formatAction(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export async function listAdminChanges(input: {
  limit: number;
  source?: AdminChangeEvent["source"];
}): Promise<AdminChangeEvent[]> {
  const pool = await getPool();
  if (!pool)
    throw new Error("Datenbankverbindung für Änderungsverlauf nicht verfügbar");

  const queryLimit = Math.max(1, Math.min(input.limit, 200));
  const result = await pool.query<{
    id: number;
    source: AdminChangeEvent["source"];
    area: string;
    action: string;
    summary: string;
    changedFields: unknown;
    actor: string;
    createdAt: Date;
  }>(
    `
    SELECT * FROM (
      SELECT id,
             'admin_input'::text AS source,
             area,
             action,
             CASE
               WHEN jsonb_array_length(changed_fields) > 0
                 THEN replace(replace(action, '.', ' › '), '_', ' ') || ': ' || array_to_string(ARRAY(SELECT jsonb_array_elements_text(changed_fields)), ', ')
               ELSE replace(replace(action, '.', ' › '), '_', ' ')
             END AS summary,
             changed_fields AS "changedFields",
             actor,
             created_at AS "createdAt"
        FROM admin_change_events
      UNION ALL
      SELECT pal.id,
             'product'::text,
             'Artikel & Produktdaten',
             pal.action,
             COALESCE(a.name, 'Artikel #' || pal.article_id::text) || ': ' || replace(pal.action, '_', ' ')
               || CASE WHEN pal.field_name IS NULL THEN '' ELSE ' (' || pal.field_name || ')' END,
             CASE WHEN pal.field_name IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(pal.field_name) END,
             pal.changed_by,
             pal.changed_at
        FROM product_audit_log pal
        LEFT JOIN articles a ON a.id = pal.article_id
      UNION ALL
      SELECT sh.id,
             'stock'::text,
             'Lagerbestand',
             sh.change_type::text,
             COALESCE(a.name, 'Artikel #' || sh.article_id::text) || ': Bestand ' ||
               CASE WHEN sh.quantity_change >= 0 THEN '+' ELSE '' END || sh.quantity_change::text ||
               ' → ' || sh.quantity_after::text,
             jsonb_build_array('Bestand'),
             COALESCE(NULLIF(sh.user_name, ''), 'system'),
             sh.created_at
        FROM stock_history sh
        LEFT JOIN articles a ON a.id = sh.article_id
      UNION ALL
      SELECT cta.id,
             'template'::text,
             'E-Mail & WhatsApp Vorlagen',
             cta.action,
             COALESCE(ct.title, 'Vorlage #' || cta.template_id::text) || ': ' || replace(cta.action, '_', ' '),
             jsonb_build_array('Vorlagentext'),
             cta.changed_by,
             cta.created_at
        FROM communication_template_audit cta
        LEFT JOIN communication_templates ct ON ct.id = cta.template_id
      UNION ALL
      SELECT kal.id,
             'kwk'::text,
             'Kunden werben Kunden',
             kal.action,
             'KWK: ' || replace(kal.action, '_', ' ') ||
               CASE WHEN kal.kwk_id IS NULL THEN '' ELSE ' (Account #' || kal.kwk_id::text || ')' END,
             jsonb_build_array('KWK-Einstellung'),
             kal.admin_user,
             kal.created_at
        FROM kwk_audit_log kal
    ) events
    WHERE ($1::text IS NULL OR source = $1)
    ORDER BY "createdAt" DESC, id DESC
    LIMIT $2
  `,
    [input.source ?? null, queryLimit],
  );

  return result.rows.map((row) => ({
    ...row,
    changedFields: Array.isArray(row.changedFields)
      ? row.changedFields.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
    actor: row.actor || "system",
    createdAt: toDate(row.createdAt),
    summary: row.summary || formatAction(row.action),
  }));
}
