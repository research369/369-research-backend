import { Router } from "express";
import { Resend } from "resend";
import { eq } from "drizzle-orm";
import { getDb } from "./db.js";
import { ENV } from "./env.js";
import { communicationEvents, customerCommunications } from "../drizzle/schema.js";

export const resendWebhookRouter = Router();

const EVENT_STATUS: Record<string, string> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.delivery_delayed": "delayed",
  "email.bounced": "bounced",
  "email.failed": "failed",
  "email.suppressed": "suppressed",
  "email.complained": "complained",
};

/**
 * Receives Resend events only after the raw Svix signature has been verified.
 * This route is mounted with express.raw() before the global JSON parser.
 */
resendWebhookRouter.post("/api/webhooks/resend", async (req, res) => {
  if (!ENV.resendWebhookSecret) {
    console.error("[CRM] Resend webhook rejected: RESEND_WEBHOOK_SECRET is missing");
    return res.status(503).json({ error: "Webhook nicht konfiguriert" });
  }

  const rawPayload = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  if (!rawPayload) {
    return res.status(400).json({ error: "Ungültiger Webhook-Payload" });
  }

  let event: any;
  try {
    const resend = new Resend(ENV.resendApiKey);
    event = resend.webhooks.verify({
      payload: rawPayload,
      headers: {
        id: String(req.header("svix-id") || ""),
        timestamp: String(req.header("svix-timestamp") || ""),
        signature: String(req.header("svix-signature") || ""),
      },
      webhookSecret: ENV.resendWebhookSecret,
    });
  } catch (error: any) {
    console.warn("[CRM] Resend webhook signature rejected:", error?.message || error);
    return res.status(400).json({ error: "Ungültige Webhook-Signatur" });
  }

  const providerEventId = String(req.header("svix-id") || "");
  const emailId = event?.data?.email_id ? String(event.data.email_id) : "";
  const eventType = String(event?.type || "unknown");
  const occurredAt = event?.created_at ? new Date(event.created_at) : new Date();

  if (!providerEventId || !emailId) {
    return res.status(400).json({ error: "Webhook enthält keine Referenz" });
  }

  try {
    const db = await getDb();
    if (!db) throw new Error("Datenbank nicht verfügbar");

    const existingEvent = await db.select({ id: communicationEvents.id })
      .from(communicationEvents)
      .where(eq(communicationEvents.providerEventId, providerEventId))
      .limit(1);
    if (existingEvent.length > 0) {
      return res.status(200).json({ ok: true, duplicate: true });
    }

    const communication = await db.select()
      .from(customerCommunications)
      .where(eq(customerCommunications.resendEmailId, emailId))
      .limit(1);

    // A valid event for a historical/non-CRM message must be acknowledged but is not attached to an unrelated record.
    if (communication.length === 0) {
      console.info(`[CRM] Resend event ${eventType} for untracked email ${emailId} acknowledged`);
      return res.status(200).json({ ok: true, tracked: false });
    }

    const comm = communication[0];
    const status = EVENT_STATUS[eventType] || "unknown";
    const bounceMessage = eventType === "email.bounced"
      ? (event?.data?.bounce?.message || event?.data?.bounce?.diagnosticCode?.join("\n") || "Unzustellbar")
      : eventType === "email.failed"
        ? (event?.data?.error?.message || "Versandfehler")
        : null;

    await db.insert(communicationEvents).values({
      communicationId: comm.id,
      provider: "resend",
      providerEventId,
      eventType,
      occurredAt,
      payload: rawPayload,
    });

    await db.update(customerCommunications)
      .set({
        deliveryStatus: status,
        deliveryStatusAt: occurredAt,
        status: (status === "bounced" || status === "failed" || status === "suppressed") ? "failed" : "sent",
        errorMessage: bounceMessage,
      })
      .where(eq(customerCommunications.id, comm.id));

    console.info(`[CRM] Resend event ${eventType} stored for communication ${comm.id}`);
    return res.status(200).json({ ok: true, tracked: true });
  } catch (error: any) {
    console.error("[CRM] Resend webhook processing failed:", error?.message || error);
    return res.status(500).json({ error: "Webhook konnte nicht verarbeitet werden" });
  }
});
