import { eq } from "drizzle-orm";
import { z } from "zod";
import { router, adminProcedure } from "./trpc.js";
import { getDb, getPool } from "./db.js";
import { communicationTemplates, customers, orderItems, orders, shopSettings } from "../drizzle/schema.js";

const channelSchema = z.enum(["email", "whatsapp"]);
const languageSchema = z.enum(["de", "en"]);

const ALLOWED_PLACEHOLDERS = new Set([
  "firstName", "lastName", "customerName", "orderId", "total", "orderDate", "items",
  "trackingNumber", "trackingUrl", "carrier", "penCalculatorUrl", "plugAndPlayUrl",
  "whatsappChannelUrl", "supportEmail", "paymentDetails",
]);

function assertValidPlaceholders(value: string | null | undefined): void {
  if (!value) return;
  const unknown = Array.from(value.matchAll(/{{\s*([^{}\s]+)\s*}}/g))
    .map((match) => match[1])
    .filter((key) => !ALLOWED_PLACEHOLDERS.has(key));
  if (unknown.length > 0) {
    throw new Error(`Unzulässige Platzhalter: ${Array.from(new Set(unknown)).join(", ")}`);
  }
}

function renderText(template: string | null | undefined, variables: Record<string, string>): string {
  return (template || "").replace(/{{\s*([^{}\s]+)\s*}}/g, (_match, key) => variables[key] ?? "");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function textToHtml(value: string): string {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#172033;white-space:normal">${escapeHtml(value).replace(/\n/g, "<br />")}</div>`;
}

function trackingUrl(carrier: string, trackingNumber: string): string {
  if (!trackingNumber) return "";
  const encoded = encodeURIComponent(trackingNumber);
  switch (carrier.toUpperCase()) {
    case "DPD": return `https://tracking.dpd.de/status/de_DE/parcel/${encoded}`;
    case "HERMES": return `https://www.myhermes.de/empfangen/sendungsverfolgung/sendungsinformation/#${encoded}`;
    case "GLS": return `https://gls-group.eu/DE/de/paketverfolgung?match=${encoded}`;
    case "UPS": return `https://www.ups.com/track?tracknum=${encoded}&loc=de_DE`;
    default: return `https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=${encoded}`;
  }
}

async function buildVariables(input: { customerId?: number; orderId?: string }): Promise<Record<string, string>> {
  const db = await getDb();
  if (!db) throw new Error("Datenbank nicht verfügbar");

  let customer: typeof customers.$inferSelect | undefined;
  let order: typeof orders.$inferSelect | undefined;
  let items: Array<typeof orderItems.$inferSelect> = [];

  if (input.orderId) {
    [order] = await db.select().from(orders).where(eq(orders.orderId, input.orderId)).limit(1);
    if (!order) throw new Error("Bestellung nicht gefunden");
    items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.orderId));
  }
  const effectiveCustomerId = input.customerId || order?.customerId || undefined;
  if (effectiveCustomerId) {
    [customer] = await db.select().from(customers).where(eq(customers.id, effectiveCustomerId)).limit(1);
  }

  const settingsRows = await db.select().from(shopSettings);
  const settings = Object.fromEntries(settingsRows.map((row) => [row.key, row.value]));
  const firstName = customer?.firstName || order?.firstName || customer?.name?.split(/\s+/)[0] || "";
  const lastName = customer?.lastName || order?.lastName || "";
  const customerName = customer?.name || `${order?.firstName || ""} ${order?.lastName || ""}`.trim();
  const total = order ? `${Number(order.total || 0).toFixed(2).replace(".", ",")} €` : "";
  const carrier = order?.trackingCarrier || "DHL";
  const trackingNumber = order?.trackingNumber || "";
  const orderItemsText = items.map((item) => `• ${item.quantity}× ${item.name}${item.dosage ? ` (${item.dosage})` : ""}`).join("\n");
  const paymentDetails = [
    settings.communication_payment_iban ? `IBAN: ${settings.communication_payment_iban}` : "",
    settings.communication_payment_bic ? `BIC: ${settings.communication_payment_bic}` : "",
    settings.communication_payment_recipient ? `Empfänger: ${settings.communication_payment_recipient}` : "",
  ].filter(Boolean).join("\n");

  return {
    firstName,
    lastName,
    customerName,
    orderId: order?.orderId || input.orderId || "",
    total,
    orderDate: order?.orderDate ? new Date(order.orderDate).toLocaleDateString("de-DE") : "",
    items: orderItemsText,
    trackingNumber,
    trackingUrl: trackingUrl(carrier, trackingNumber),
    carrier,
    penCalculatorUrl: settings.communication_pen_calculator_url || "",
    plugAndPlayUrl: settings.communication_plug_and_play_url || "",
    whatsappChannelUrl: settings.communication_whatsapp_channel_url || "",
    supportEmail: settings.communication_support_email || "",
    paymentDetails,
  };
}

export const communicationTemplateRouter = router({
  list: adminProcedure
    .input(z.object({
      channel: channelSchema.optional(),
      language: languageSchema.optional(),
      activeOnly: z.boolean().optional().default(true),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Datenbank nicht verfügbar");
      const rows = await db.select().from(communicationTemplates);
      return rows
        .filter((row) => (!input?.channel || row.channel === input.channel)
          && (!input?.language || row.language === input.language)
          && (!input?.activeOnly || row.isActive === 1))
        .sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title));
    }),

  render: adminProcedure
    .input(z.object({
      templateId: z.number().int().positive(),
      customerId: z.number().int().positive().optional(),
      orderId: z.string().min(1).optional(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Datenbank nicht verfügbar");
      const [template] = await db.select().from(communicationTemplates)
        .where(eq(communicationTemplates.id, input.templateId)).limit(1);
      if (!template || template.isActive !== 1) throw new Error("Vorlage nicht verfügbar");

      assertValidPlaceholders(template.subjectTemplate);
      assertValidPlaceholders(template.bodyTemplate);
      const variables = await buildVariables(input);
      const body = renderText(template.bodyTemplate, variables);
      const subject = renderText(template.subjectTemplate, variables);
      const missing = Array.from(new Set(
        Array.from((template.subjectTemplate || "").matchAll(/{{\s*([^{}\s]+)\s*}}/g))
          .concat(Array.from(template.bodyTemplate.matchAll(/{{\s*([^{}\s]+)\s*}}/g)))
          .map((match) => match[1])
          .filter((key) => !variables[key]),
      ));

      return {
        template: { id: template.id, key: template.templateKey, title: template.title, channel: template.channel, language: template.language, version: template.version },
        subject,
        body,
        htmlBody: template.channel === "email" ? textToHtml(body) : null,
        missing,
      };
    }),

  update: adminProcedure
    .input(z.object({
      id: z.number().int().positive(),
      title: z.string().trim().min(1).max(200),
      subjectTemplate: z.string().max(2000).nullable().optional(),
      bodyTemplate: z.string().trim().min(1).max(20000),
      isActive: z.number().int().min(0).max(1),
      sortOrder: z.number().int().min(0).max(10000),
    }))
    .mutation(async ({ input, ctx }) => {
      assertValidPlaceholders(input.subjectTemplate);
      assertValidPlaceholders(input.bodyTemplate);
      const db = await getDb();
      if (!db) throw new Error("Datenbank nicht verfügbar");
      const [previous] = await db.select().from(communicationTemplates).where(eq(communicationTemplates.id, input.id)).limit(1);
      if (!previous) throw new Error("Vorlage nicht gefunden");
      const [updated] = await db.update(communicationTemplates).set({
        title: input.title,
        subjectTemplate: input.subjectTemplate ?? null,
        bodyTemplate: input.bodyTemplate,
        isActive: input.isActive,
        sortOrder: input.sortOrder,
        version: previous.version + 1,
        updatedAt: new Date(),
      }).where(eq(communicationTemplates.id, input.id)).returning();
      const pool = await getPool();
      if (pool) {
        await pool.query(
          `INSERT INTO communication_template_audit (template_id, action, previous_value, next_value, changed_by)
           VALUES ($1, 'updated', $2::jsonb, $3::jsonb, $4)`,
          [updated.id, JSON.stringify(previous), JSON.stringify(updated), String((ctx.user as any)?.username || "admin")],
        );
      }
      return updated;
    }),
});
