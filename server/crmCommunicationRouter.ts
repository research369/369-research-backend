import { TRPCError } from "@trpc/server";
import { composeExplicitOrderMessage } from "./orderDiscountMessageService.js";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { router, adminProcedure } from "./trpc.js";
import { getDb } from "./db.js";
import { customerCommunications, customers } from "../drizzle/schema.js";
import { sendAndArchiveCrmEmail } from "./crmCommunicationService.js";
import { readCrmOrderContext, linkCrmExistingOrder } from "./crmOrderCustomerService.js";

export const crmCommunicationRouter = router({
  getByCustomer: adminProcedure
    .input(z.object({ customerId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Datenbank nicht verfügbar");
      return db.select().from(customerCommunications)
        .where(eq(customerCommunications.customerId, input.customerId))
        .orderBy(desc(customerCommunications.createdAt));
    }),
  getByOrder: adminProcedure
    .input(z.object({ orderId: z.string().min(1) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Datenbank nicht verfügbar");
      const context = await readCrmOrderContext(db, input.orderId);
      return db.select().from(customerCommunications)
        .where(eq(customerCommunications.orderId, context.canonicalOrderId))
        .orderBy(desc(customerCommunications.createdAt));
    }),
  getOrderContext: adminProcedure
    .input(z.object({ orderId: z.string().min(1) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Datenbank nicht verfügbar");
      return readCrmOrderContext(db, input.orderId);
    }),
  previewMessage: adminProcedure
    .input(z.object({
      customerId: z.number().int().positive().optional(), orderId: z.string().min(1).optional(),
      channel: z.enum(["email", "whatsapp"]), subject: z.string().optional(), body: z.string(),
      plainText: z.string().optional(), communicationLanguage: z.enum(["de", "en"]).optional(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Datenbank nicht verfügbar");
      return composeExplicitOrderMessage(db, { ...input, bodyIsHtml: input.channel === "email" && /<[a-z][\s\S]*>/i.test(input.body) });
    }),
  sendEmail: adminProcedure
    .input(z.object({
      customerId: z.number().int().positive().optional(),
      orderId: z.string().min(1).optional(),
      subject: z.string().trim().min(1).max(500),
      htmlBody: z.string().min(1),
      plainText: z.string().optional(),
      communicationLanguage: z.enum(["de", "en"]).optional(),
      financialFingerprint: z.string().optional(),
      idempotencyKey: z.string().min(8).max(200).optional(),
    }).refine(value => Boolean(value.customerId || value.orderId), {
      message: "Kunde oder Bestellung muss angegeben werden",
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Datenbank nicht verfügbar");
      let customerId: number | null = input.customerId || null;
      let recipientEmail = "";
      let canonicalOrderId = input.orderId;
      if (input.orderId) {
        const context = await readCrmOrderContext(db, input.orderId);
        if (input.customerId && input.customerId !== context.customerId) throw new Error("Kunde und Bestellung stimmen nicht überein");
        customerId = context.customerId;
        recipientEmail = context.email;
        canonicalOrderId = context.canonicalOrderId;
      } else if (customerId) {
        const [customer] = await db.select().from(customers).where(eq(customers.id, customerId)).limit(1);
        if (!customer) throw new Error("Kunde nicht gefunden");
        recipientEmail = customer.email || "";
      }
      // Preserve existing archived replay semantics before re-rendering or drift checks.
      if (input.idempotencyKey) {
        const [record] = await db.select().from(customerCommunications).where(eq(customerCommunications.idempotencyKey, input.idempotencyKey)).limit(1);
        if (record) {
          if (record.status !== "sent") throw new Error(record.errorMessage || "E-Mail konnte nicht versendet werden");
          return { sent: true, communicationId: record.id, resendEmailId: record.resendEmailId || undefined };
        }
      }
      const composed = await composeExplicitOrderMessage(db, { ...input, orderId: canonicalOrderId, channel: "email", body: input.htmlBody, bodyIsHtml: true });
      if (input.financialFingerprint && input.financialFingerprint !== composed.financialFingerprint) {
        throw new TRPCError({ code: "CONFLICT", message: "Rabattdaten geändert. Bitte Vorschau erneut bestätigen." });
      }
      // Unlinked order mail remains possible for admins; it is archived only
      // against the order, marked for review, never under a guessed customer.
      const result = await sendAndArchiveCrmEmail({
        customerId, recipientEmail, subject: input.subject, htmlBody: composed.htmlBody,
        plainText: composed.plainText, orderId: canonicalOrderId || null,
        createdBy: ctx.user.name || ctx.user.username, source: "manual",
        idempotencyKey: input.idempotencyKey,
      });
      if (!result.sent) throw new Error(result.error || "E-Mail konnte nicht versendet werden");
      return result;
    }),
  linkExistingOrder: adminProcedure
    .input(z.object({ orderId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Datenbank nicht verfügbar");
      return linkCrmExistingOrder(db, input.orderId);
    }),
});
