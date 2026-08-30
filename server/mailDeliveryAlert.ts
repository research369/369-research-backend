import { ENV } from "./env.js";

const RESEND_EMAILS_URL = "https://api.resend.com/emails";
const OPERATOR_DELIVERY_ALERT_TO = "369rebackup@gmail.com";

export const DELIVERY_FAILURE_EVENT_TYPES = new Set([
  "email.bounced",
  "email.failed",
  "email.suppressed",
  "email.delivery_delayed",
]);

export interface DeliveryFailureAlertInput {
  providerEventId: string;
  eventType: string;
  occurredAt: Date;
  orderId: string | null;
  recipientEmail: string;
  subject: string;
  errorMessage?: string | null;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  }[character] || character));
}

export function shouldAlertOnDeliveryEvent(eventType: string): boolean {
  return DELIVERY_FAILURE_EVENT_TYPES.has(eventType);
}

export function buildDeliveryFailureAlert(input: DeliveryFailureAlertInput): { subject: string; text: string; html: string } {
  const eventLabel: Record<string, string> = {
    "email.bounced": "dauerhaft unzustellbar",
    "email.failed": "Versand fehlgeschlagen",
    "email.suppressed": "Versand unterdrückt",
    "email.delivery_delayed": "Zustellung verzögert",
  };
  const status = eventLabel[input.eventType] || input.eventType;
  const orderReference = input.orderId || "ohne Auftragsbezug";
  const diagnostic = input.errorMessage || "Kein weiterer Providerhinweis verfügbar";
  const subject = `Zustellfehler Kundenmail · ${orderReference}`;
  const text = [
    "Eine Kundenmail benötigt Prüfung.",
    `Auftrag: ${orderReference}`,
    `Status: ${status}`,
    `Empfänger: ${input.recipientEmail}`,
    `Mailtyp: ${input.subject}`,
    `Zeitpunkt: ${input.occurredAt.toISOString()}`,
    `Hinweis: ${diagnostic}`,
    "Bitte Kundendaten prüfen und bei Bedarf manuell Kontakt aufnehmen. Es erfolgt kein automatischer Neuversand.",
  ].join("\n");
  const html = `<!doctype html><html lang="de"><body style="margin:0;padding:24px;background:#f6f7f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#17212b;"><section style="max-width:620px;margin:0 auto;background:#fff;border:1px solid #dce1e5;border-radius:14px;overflow:hidden;"><header style="padding:22px 26px;background:#7f1d1d;color:#fff;"><p style="margin:0 0 6px;font-size:12px;letter-spacing:.08em;">BETRIEBSHINWEIS</p><h1 style="margin:0;font-size:22px;">Kundenmail benötigt Prüfung</h1></header><main style="padding:24px 26px;"><p style="margin:0 0 18px;line-height:1.5;">Die Zustellung einer Kundenmail wurde von Resend als <strong>${escapeHtml(status)}</strong> gemeldet.</p><table style="border-collapse:collapse;width:100%;font-size:14px;"><tbody><tr><td style="padding:9px 0;color:#64748b;width:34%;">Auftrag</td><td style="padding:9px 0;font-weight:700;">${escapeHtml(orderReference)}</td></tr><tr><td style="padding:9px 0;color:#64748b;">Empfänger</td><td style="padding:9px 0;font-weight:700;">${escapeHtml(input.recipientEmail)}</td></tr><tr><td style="padding:9px 0;color:#64748b;">Mailtyp</td><td style="padding:9px 0;">${escapeHtml(input.subject)}</td></tr><tr><td style="padding:9px 0;color:#64748b;vertical-align:top;">Hinweis</td><td style="padding:9px 0;line-height:1.45;">${escapeHtml(diagnostic)}</td></tr></tbody></table><p style="margin:20px 0 0;padding:14px;background:#fef2f2;border-radius:9px;color:#7f1d1d;font-size:13px;line-height:1.5;">Bitte Kundendaten prüfen und bei Bedarf manuell Kontakt aufnehmen. Es erfolgt kein automatischer Neuversand.</p></main></section></body></html>`;
  return { subject, text, html };
}

export async function sendOperatorDeliveryFailureAlert(input: DeliveryFailureAlertInput): Promise<{ sent: boolean; error?: string }> {
  if (!ENV.resendApiKey) return { sent: false, error: "RESEND_API_KEY nicht konfiguriert" };
  const message = buildDeliveryFailureAlert(input);
  try {
    const response = await fetch(RESEND_EMAILS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ENV.resendApiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `delivery-alert-${input.providerEventId}`,
      },
      body: JSON.stringify({
        from: "369 Research <noreply@coreversand.de>",
        reply_to: "support@369research.eu",
        to: [OPERATOR_DELIVERY_ALERT_TO],
        subject: message.subject,
        html: message.html,
        text: message.text,
        tags: [{ name: "kind", value: "customer_email_delivery_alert" }],
      }),
    });
    if (!response.ok) return { sent: false, error: `Resend HTTP ${response.status}` };
    return { sent: true };
  } catch (error: any) {
    return { sent: false, error: error?.message || "Netzwerkfehler beim Betreiberalarm" };
  }
}
