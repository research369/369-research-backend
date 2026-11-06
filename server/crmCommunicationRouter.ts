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
  sendEmail: adminProcedure
    .input(z.object({
      customerId: z.number().int().positive().optional(),
      orderId: z.string().min(1).optional(),
      subject: z.string().trim().min(1).max(500),
      htmlBody: z.string().min(1),
      plainText: z.string().optional(),
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
      // Unlinked order mail remains possible for admins; it is archived only
      // against the order, marked for review, never under a guessed customer.
      const result = await sendAndArchiveCrmEmail({
        customerId, recipientEmail, subject: input.subject, htmlBody: input.htmlBody,
        plainText: input.plainText, orderId: canonicalOrderId || null,
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
