/*
 * Checkout failure recovery endpoint
 *
 * Receives an immutable checkout-attempt snapshot only after the regular
 * order.create request has failed. The snapshot is written idempotently to
 * failed_orders and produces one operational alert per failure reference.
 * No order, stock position, customer record or payment status is changed here.
 */

import { Router, type Request, type Response } from "express";
import { ENV } from "./env.js";
import { getPool } from "./db.js";

const RESEND_EMAILS_URL = "https://api.resend.com/emails";
const MAX_FAILURE_PAYLOAD_BYTES = 160 * 1024;
const MAX_FAILURE_ITEMS = 80;

export const checkoutErrorRouter = Router();

type CheckoutFailurePayload = {
  timestamp?: string;
  orderId?: string;
  customer?: Record<string, unknown>;
  items?: Array<Record<string, unknown>>;
  total?: number;
  subtotal?: number;
  discount?: number;
  discountCode?: string;
  shipping?: number;
  paymentMethod?: string;
  error?: string;
  errorCode?: string;
};

type StoredCheckoutFailure = {
  orderId: string;
  customer: Record<string, unknown>;
  items: Array<Record<string, unknown>>;
  total: number;
  inputJson: string;
  errorMessage: string;
};

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  }[character] || character));
}

function stringValue(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function numericValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeCheckoutFailurePayload(payload: unknown): StoredCheckoutFailure {
  const data = (payload && typeof payload === "object" ? payload : {}) as CheckoutFailurePayload;
  const orderId = stringValue(data.orderId, 64);
  const customer = data.customer && typeof data.customer === "object" && !Array.isArray(data.customer)
    ? data.customer
    : {};
  const items = Array.isArray(data.items)
    ? data.items.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)).slice(0, MAX_FAILURE_ITEMS)
    : [];
  const inputJson = JSON.stringify({
    timestamp: stringValue(data.timestamp, 64) || new Date().toISOString(),
    orderId,
    customer,
    items,
    total: numericValue(data.total),
    subtotal: numericValue(data.subtotal),
    discount: numericValue(data.discount),
    discountCode: stringValue(data.discountCode, 120),
    shipping: numericValue(data.shipping),
    paymentMethod: stringValue(data.paymentMethod, 40),
    error: stringValue(data.error, 4000),
    errorCode: stringValue(data.errorCode, 160),
  });

  if (!orderId) throw new Error("Eine Fehlerreferenz ist erforderlich.");
  if (!orderId.startsWith("FEHLER-")) throw new Error("Die Fehlerreferenz ist ungültig.");
  if (!customer.firstName && !customer.lastName && !customer.email) {
    throw new Error("Kundendaten für den Fehlerfall fehlen.");
  }
  if (Buffer.byteLength(inputJson, "utf8") > MAX_FAILURE_PAYLOAD_BYTES) {
    throw new Error("Der Fehlerbericht ist zu groß.");
  }

  return {
    orderId,
    customer,
    items,
    total: numericValue(data.total),
    inputJson,
    errorMessage: stringValue(data.error, 4000) || "Unbekannter Fehler bei order.create",
  };
}

export async function ensureCheckoutFailureSchema(): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Produktionsdatenbank nicht verfügbar.");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS failed_orders (
      id SERIAL PRIMARY KEY,
      attempted_order_id VARCHAR(64),
      customer_name VARCHAR(200),
      customer_email VARCHAR(320),
      customer_phone VARCHAR(50),
      total DECIMAL(10,2),
      items_json TEXT,
      input_json TEXT,
      error_message TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS checkout_failure_alerts (
      id SERIAL PRIMARY KEY,
      attempted_order_id VARCHAR(64) NOT NULL UNIQUE,
      alert_status VARCHAR(24) NOT NULL DEFAULT 'pending',
      alert_attempts INTEGER NOT NULL DEFAULT 0,
      provider_message_id VARCHAR(128),
      last_error TEXT,
      last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
      alert_sent_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT checkout_failure_alert_status_check
        CHECK (alert_status IN ('pending', 'sending', 'sent', 'failed'))
    )
  `);
}

async function persistCheckoutFailure(payload: StoredCheckoutFailure): Promise<{ shouldAlert: boolean }> {
  const pool = await getPool();
  if (!pool) throw new Error("Produktionsdatenbank nicht verfügbar.");
  const customerName = `${stringValue(payload.customer.firstName, 100)} ${stringValue(payload.customer.lastName, 100)}`.trim();
  const customerEmail = stringValue(payload.customer.email, 320);
  const customerPhone = stringValue(payload.customer.phone, 50);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // The existing failed_orders table predates this workflow and can contain
    // historical duplicate references. A per-reference advisory lock avoids
    // both a risky unique migration and concurrent duplicate recovery rows.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [payload.orderId]);
    const existingFailure = await client.query<{ id: number }>(
      `SELECT id FROM failed_orders
       WHERE attempted_order_id = $1
       ORDER BY id DESC
       LIMIT 1
       FOR UPDATE`,
      [payload.orderId]
    );
    const failureValues = [
      payload.orderId,
      customerName,
      customerEmail,
      customerPhone,
      payload.total,
      JSON.stringify(payload.items),
      payload.inputJson,
      payload.errorMessage,
    ];
    if (existingFailure.rowCount === 1) {
      await client.query(
        `UPDATE failed_orders
         SET customer_name = $2, customer_email = $3, customer_phone = $4,
             total = $5, items_json = $6, input_json = $7, error_message = $8
         WHERE id = $9`,
        [...failureValues, existingFailure.rows[0].id]
      );
    } else {
      await client.query(
        `INSERT INTO failed_orders (
           attempted_order_id, customer_name, customer_email, customer_phone,
           total, items_json, input_json, error_message
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        failureValues
      );
    }
    await client.query(
      `INSERT INTO checkout_failure_alerts (attempted_order_id, last_seen_at)
       VALUES ($1, NOW())
       ON CONFLICT (attempted_order_id)
       DO UPDATE SET last_seen_at = NOW(), updated_at = NOW()`,
      [payload.orderId]
    );
    const alertClaim = await client.query<{ id: number }>(
      `UPDATE checkout_failure_alerts
       SET alert_status = 'sending',
           alert_attempts = alert_attempts + 1,
           last_error = NULL,
           updated_at = NOW()
       WHERE attempted_order_id = $1
         AND alert_status IN ('pending', 'failed')
       RETURNING id`,
      [payload.orderId]
    );
    await client.query("COMMIT");
    return { shouldAlert: alertClaim.rowCount === 1 };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function buildCheckoutFailureAlert(payload: StoredCheckoutFailure): { subject: string; text: string; html: string } {
  const customerName = `${stringValue(payload.customer.firstName, 100)} ${stringValue(payload.customer.lastName, 100)}`.trim() || "Unbekannt";
  const customerEmail = stringValue(payload.customer.email, 320) || "nicht hinterlegt";
  const customerPhone = stringValue(payload.customer.phone, 50) || "nicht hinterlegt";
  const street = stringValue(payload.customer.street, 160);
  const houseNumber = stringValue(payload.customer.houseNumber, 32);
  const zip = stringValue(payload.customer.zip, 20);
  const city = stringValue(payload.customer.city, 120);
  const address = [street, houseNumber].filter(Boolean).join(" ") + ([zip, city].filter(Boolean).join(" ") ? `, ${[zip, city].filter(Boolean).join(" ")}` : "");
  const itemsText = payload.items.length > 0
    ? payload.items.map((item) => `${numericValue(item.quantity) || 1}× ${stringValue(item.name, 160)} ${stringValue(item.dosage, 64)}`).join(", ")
    : "Keine Artikelpositionen übermittelt";
  const subject = `⚠️ Checkout nicht angelegt · ${payload.orderId}`;
  const text = [
    "Ein Checkout wurde nicht als Bestellung angelegt.",
    `Fehlerreferenz: ${payload.orderId}`,
    `Kunde: ${customerName}`,
    `E-Mail: ${customerEmail}`,
    `Telefon: ${customerPhone}`,
    `Adresse: ${address || "nicht vollständig"}`,
    `Betrag: ${payload.total.toFixed(2)} €`,
    `Artikel: ${itemsText}`,
    `Fehler: ${payload.errorMessage}`,
    "Die Daten sind revisionssicher unter failed_orders gespeichert.",
    "Es wurde keine Bestellung, kein Bestand und kein Zahlungsstatus verändert.",
  ].join("\n");
  const html = `<!doctype html><html lang="de"><body style="margin:0;padding:24px;background:#f6f7f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#17212b;"><section style="max-width:660px;margin:0 auto;background:#fff;border:1px solid #dce1e5;border-radius:14px;overflow:hidden;"><header style="padding:22px 26px;background:#7f1d1d;color:#fff;"><p style="margin:0 0 6px;font-size:12px;letter-spacing:.08em;">BETRIEBSHINWEIS</p><h1 style="margin:0;font-size:22px;">Checkout nicht angelegt</h1></header><main style="padding:24px 26px;"><p style="margin:0 0 18px;line-height:1.5;">Ein Checkout wurde abgewiesen. Der vollständige Versuch ist gespeichert und muss geprüft werden.</p><table style="border-collapse:collapse;width:100%;font-size:14px;"><tbody><tr><td style="padding:9px 0;color:#64748b;width:34%;">Fehlerreferenz</td><td style="padding:9px 0;font-weight:700;">${escapeHtml(payload.orderId)}</td></tr><tr><td style="padding:9px 0;color:#64748b;">Kunde</td><td style="padding:9px 0;font-weight:700;">${escapeHtml(customerName)}</td></tr><tr><td style="padding:9px 0;color:#64748b;">Kontakt</td><td style="padding:9px 0;">${escapeHtml(customerEmail)}<br>${escapeHtml(customerPhone)}</td></tr><tr><td style="padding:9px 0;color:#64748b;">Adresse</td><td style="padding:9px 0;">${escapeHtml(address || "nicht vollständig")}</td></tr><tr><td style="padding:9px 0;color:#64748b;">Betrag</td><td style="padding:9px 0;font-size:18px;color:#0040C1;font-weight:700;">${escapeHtml(payload.total.toFixed(2))} €</td></tr><tr><td style="padding:9px 0;color:#64748b;vertical-align:top;">Artikel</td><td style="padding:9px 0;line-height:1.45;">${escapeHtml(itemsText)}</td></tr><tr><td style="padding:9px 0;color:#64748b;vertical-align:top;">Fehler</td><td style="padding:9px 0;color:#991b1b;line-height:1.45;">${escapeHtml(payload.errorMessage)}</td></tr></tbody></table><p style="margin:20px 0 0;padding:14px;background:#fef2f2;border-radius:9px;color:#7f1d1d;font-size:13px;line-height:1.5;">Es wurde ausdrücklich <strong>keine</strong> Bestellung, kein Bestand und kein Zahlungsstatus verändert. Bitte den gespeicherten Vorgang prüfen und nur bei Bedarf manuell weiterbearbeiten.</p></main></section></body></html>`;
  return { subject, text, html };
}

async function sendCheckoutFailureAlert(payload: StoredCheckoutFailure): Promise<{ sent: true; messageId: string | null } | { sent: false; error: string }> {
  if (!ENV.resendApiKey) return { sent: false, error: "RESEND_API_KEY nicht konfiguriert" };
  const message = buildCheckoutFailureAlert(payload);
  try {
    const response = await fetch(RESEND_EMAILS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ENV.resendApiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `checkout-failure-${payload.orderId}`,
      },
      body: JSON.stringify({
        from: "369 Research <noreply@coreversand.de>",
        reply_to: "support@369research.eu",
        to: [ENV.operatorAlertEmail],
        subject: message.subject,
        text: message.text,
        html: message.html,
        tags: [{ name: "kind", value: "checkout_failure_alert" }],
      }),
    });
    if (!response.ok) return { sent: false, error: `Resend HTTP ${response.status}` };
    const result = await response.json().catch(() => ({})) as { id?: string };
    return { sent: true, messageId: result.id || null };
  } catch (error: any) {
    return { sent: false, error: error?.message || "Netzwerkfehler beim Betreiberalarm" };
  }
}

async function updateCheckoutFailureAlert(
  orderId: string,
  result: Awaited<ReturnType<typeof sendCheckoutFailureAlert>>
): Promise<void> {
  const pool = await getPool();
  if (!pool) return;
  if (result.sent) {
    await pool.query(
      `UPDATE checkout_failure_alerts
       SET alert_status = 'sent', provider_message_id = $2, alert_sent_at = NOW(), updated_at = NOW()
       WHERE attempted_order_id = $1`,
      [orderId, result.messageId]
    );
    return;
  }
  await pool.query(
    `UPDATE checkout_failure_alerts
     SET alert_status = 'failed', last_error = $2, updated_at = NOW()
     WHERE attempted_order_id = $1`,
    [orderId, result.error]
  );
}

checkoutErrorRouter.post("/api/checkout-error", async (req: Request, res: Response) => {
  let payload: StoredCheckoutFailure;
  try {
    payload = normalizeCheckoutFailurePayload(req.body);
  } catch (error: any) {
    return res.status(400).json({ success: false, error: error?.message || "Ungültiger Fehlerbericht" });
  }

  try {
    await ensureCheckoutFailureSchema();
    const { shouldAlert } = await persistCheckoutFailure(payload);
    if (!shouldAlert) {
      return res.status(200).json({ success: true, stored: true, alert: "already_sent_or_in_progress" });
    }

    const alertResult = await sendCheckoutFailureAlert(payload);
    await updateCheckoutFailureAlert(payload.orderId, alertResult);
    if (!alertResult.sent) {
      return res.status(503).json({ success: false, stored: true, error: alertResult.error });
    }

    return res.status(201).json({ success: true, stored: true, alert: "sent" });
  } catch (error: any) {
    console.error("[checkout-error] recovery failure:", error?.message || error);
    return res.status(503).json({ success: false, error: "Checkout-Fehlerbericht konnte nicht sicher gespeichert werden." });
  }
});
