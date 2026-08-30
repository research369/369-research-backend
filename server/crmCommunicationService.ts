import { nanoid } from "nanoid";
import { eq, ilike } from "drizzle-orm";
import { getDb } from "./db.js";
import { ENV } from "./env.js";
import { customerCommunications, customers, orders } from "../drizzle/schema.js";

export const CRM_EMAIL_FROM = "369 Research <noreply@coreversand.de>";
export const CRM_EMAIL_FROM_ADDRESS = "noreply@coreversand.de";
export const CRM_EMAIL_REPLY_TO = "support@369research.eu";
const RESEND_EMAILS_URL = "https://api.resend.com/emails";

export type CrmEmailSource = "manual" | "automatic";

export interface SendCrmEmailInput {
  customerId: number;
  recipientEmail: string;
  subject: string;
  htmlBody: string;
  plainText?: string;
  orderId?: string | null;
  createdBy: string;
  source: CrmEmailSource;
  idempotencyKey?: string;
  bcc?: string[];
  senderName?: string;
  senderEmail?: string;
  from?: string;
  replyTo?: string;
}

export interface SendCrmEmailResult {
  sent: boolean;
  communicationId: number;
  resendEmailId?: string;
  error?: string;
}

async function resolveOrCreateOrderCustomer(orderId: string, email: string): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Datenbank nicht verfügbar");
  const [order] = await db.select().from(orders).where(eq(orders.orderId, orderId)).limit(1);
  if (!order) throw new Error(`Bestellung ${orderId} nicht gefunden`);

  if (order.customerId) return order.customerId;
  const [existingCustomer] = await db.select().from(customers).where(ilike(customers.email, email)).limit(1);
  if (existingCustomer) {
    await db.update(orders).set({ customerId: existingCustomer.id, updatedAt: new Date() }).where(eq(orders.id, order.id));
    return existingCustomer.id;
  }

  const [createdCustomer] = await db.insert(customers).values({
    name: `${order.firstName} ${order.lastName}`.trim(),
    firstName: order.firstName,
    lastName: order.lastName,
    phone: order.phone,
    email: order.email,
    company: order.company,
    street: order.street,
    houseNumber: order.houseNumber,
    zip: order.zip,
    city: order.city,
    country: order.country,
    source: "order_crm",
    notes: "Automatisch für die CRM-Kommunikationsakte aus bestehender Bestellung verknüpft.",
  }).returning();
  await db.update(orders).set({ customerId: createdCustomer.id, updatedAt: new Date() }).where(eq(orders.id, order.id));
  return createdCustomer.id;
}

export function isValidCustomerEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  const placeholders = ["keine@angabe.de", "noreply@", "placeholder", "test@test", "example@", "otc@369research.eu"];
  if (placeholders.some(value => normalized.includes(value))) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalized);
}

export async function sendAndArchiveAutomaticOrderEmail(input: {
  orderId: string;
  recipientEmail: string;
  subject: string;
  htmlBody: string;
  bcc?: string[];
  idempotencyKey?: string;
  senderName?: string;
  senderEmail?: string;
  from?: string;
  replyTo?: string;
}): Promise<SendCrmEmailResult> {
  const customerId = await resolveOrCreateOrderCustomer(input.orderId, input.recipientEmail);
  return sendAndArchiveCrmEmail({
    customerId,
    recipientEmail: input.recipientEmail,
    subject: input.subject,
    htmlBody: input.htmlBody,
    orderId: input.orderId,
    createdBy: "system",
    source: "automatic",
    bcc: input.bcc,
    idempotencyKey: input.idempotencyKey || `automatic-${input.orderId}-${nanoid(20)}`,
    senderName: input.senderName,
    senderEmail: input.senderEmail,
    from: input.from,
    replyTo: input.replyTo,
  });
}

export function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The one supported outbound CRM email path. It archives a draft before the
 * external call, uses an idempotency key for retry safety, and stores the
 * Resend email ID on the same immutable communication record afterwards.
 */
export async function sendAndArchiveCrmEmail(input: SendCrmEmailInput): Promise<SendCrmEmailResult> {
  const db = await getDb();
  if (!db) throw new Error("Datenbank nicht verfügbar");
  if (!ENV.resendApiKey) throw new Error("RESEND_API_KEY nicht konfiguriert");
  if (!isValidCustomerEmail(input.recipientEmail)) {
    throw new Error("Keine gültige Kunden-E-Mail-Adresse hinterlegt");
  }

  const recipientEmail = input.recipientEmail.trim().toLowerCase();
  const idempotencyKey = input.idempotencyKey || `crm-${nanoid(24)}`;
  const existing = await db.select()
    .from(customerCommunications)
    .where(eq(customerCommunications.idempotencyKey, idempotencyKey))
    .limit(1);

  if (existing.length > 0) {
    const record = existing[0];
    return {
      sent: record.status === "sent",
      communicationId: record.id,
      resendEmailId: record.resendEmailId || undefined,
      error: record.errorMessage || undefined,
    };
  }

  const [communication] = await db.insert(customerCommunications).values({
    customerId: input.customerId,
    type: "email",
    status: "draft",
    subject: input.subject.trim(),
    body: input.plainText || htmlToPlainText(input.htmlBody),
    htmlBody: input.htmlBody,
    recipientEmail,
    senderName: input.senderName || "369 Research",
    senderEmail: input.senderEmail || CRM_EMAIL_FROM_ADDRESS,
    replyTo: input.replyTo || CRM_EMAIL_REPLY_TO,
    orderId: input.orderId || null,
    createdBy: input.createdBy,
    idempotencyKey,
    direction: "outbound",
    source: input.source,
    deliveryStatus: "prepared",
  }).returning();

  const payload: Record<string, unknown> = {
    from: input.from || CRM_EMAIL_FROM,
    to: [recipientEmail],
    reply_to: input.replyTo || CRM_EMAIL_REPLY_TO,
    subject: input.subject.trim(),
    html: input.htmlBody,
    text: input.plainText || htmlToPlainText(input.htmlBody),
    tags: [
      { name: "crm_communication_id", value: String(communication.id) },
      { name: "customer_id", value: String(input.customerId) },
      ...(input.orderId ? [{ name: "order_id", value: input.orderId }] : []),
    ],
  };
  if (input.bcc && input.bcc.length > 0) payload.bcc = input.bcc;

  let responseBody = "";
  let responseStatus = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(RESEND_EMAILS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ENV.resendApiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
      responseStatus = response.status;
      responseBody = await response.text();
      if (response.ok) break;
    } catch (error: any) {
      responseBody = error?.message || "Netzwerkfehler beim E-Mail-Versand";
    }

    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1200));
  }

  if (responseStatus >= 200 && responseStatus < 300) {
    let parsed: { id?: string } = {};
    try { parsed = JSON.parse(responseBody); } catch { /* Resend ID remains empty only if response was malformed */ }
    await db.update(customerCommunications).set({
      status: "sent",
      resendEmailId: parsed.id || null,
      deliveryStatus: "sent",
      deliveryStatusAt: new Date(),
      errorMessage: null,
    }).where(eq(customerCommunications.id, communication.id));

    return { sent: true, communicationId: communication.id, resendEmailId: parsed.id };
  }

  const errorMessage = `Resend HTTP ${responseStatus || 0}: ${responseBody || "Unbekannter Versandfehler"}`;
  await db.update(customerCommunications).set({
    status: "failed",
    deliveryStatus: "failed",
    deliveryStatusAt: new Date(),
    errorMessage,
  }).where(eq(customerCommunications.id, communication.id));

  return { sent: false, communicationId: communication.id, error: errorMessage };
}
