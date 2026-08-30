import { z } from "zod";
import { and, desc, eq, ilike, or } from "drizzle-orm";
import { router, adminProcedure } from "./trpc.js";
import { getDb } from "./db.js";
import { customerCommunications, customers, orders } from "../drizzle/schema.js";
import { sendAndArchiveCrmEmail } from "./crmCommunicationService.js";

async function resolveCustomerForOrder(orderId: string): Promise<{ customerId: number; email: string; name: string; canonicalOrderId: string }> {
  const db = await getDb();
  if (!db) throw new Error("Datenbank nicht verfügbar");

  const [order] = await db.select().from(orders).where(or(
    eq(orders.orderId, orderId),
    eq(orders.externalOrderReference, orderId),
  )).limit(1);
  if (!order) throw new Error("Bestellung nicht gefunden");

  if (order.customerId) {
    const [customer] = await db.select().from(customers).where(eq(customers.id, order.customerId)).limit(1);
    if (customer) return { customerId: customer.id, email: customer.email || order.email, name: customer.name, canonicalOrderId: order.orderId };
  }

  const [matchingCustomer] = await db.select().from(customers)
    .where(ilike(customers.email, order.email))
    .limit(1);
  if (matchingCustomer) {
    await db.update(orders).set({ customerId: matchingCustomer.id, updatedAt: new Date() })
      .where(eq(orders.id, order.id));
    return { customerId: matchingCustomer.id, email: matchingCustomer.email || order.email, name: matchingCustomer.name, canonicalOrderId: order.orderId };
  }

  // An order without a customer record cannot have a durable CRM history. Create one
  // exactly once and link it back to the order for all future communication.
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

  await db.update(orders).set({ customerId: createdCustomer.id, updatedAt: new Date() })
    .where(eq(orders.id, order.id));
  return { customerId: createdCustomer.id, email: createdCustomer.email || order.email, name: createdCustomer.name, canonicalOrderId: order.orderId };
}

export const crmCommunicationRouter = router({
  getByCustomer: adminProcedure
    .input(z.object({ customerId: z.number() }))
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
      const [order] = await db.select({ orderId: orders.orderId }).from(orders).where(or(
        eq(orders.orderId, input.orderId),
        eq(orders.externalOrderReference, input.orderId),
      )).limit(1);
      if (!order) return [];
      return db.select().from(customerCommunications)
        .where(eq(customerCommunications.orderId, order.orderId))
        .orderBy(desc(customerCommunications.createdAt));
    }),

  getOrderContext: adminProcedure
    .input(z.object({ orderId: z.string().min(1) }))
    .query(async ({ input }) => {
      const context = await resolveCustomerForOrder(input.orderId);
      return context;
    }),

  sendEmail: adminProcedure
    .input(z.object({
      customerId: z.number().optional(),
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

      let customerId = input.customerId;
      let recipientEmail = "";
      let canonicalOrderId = input.orderId;
      if (input.orderId) {
        const context = await resolveCustomerForOrder(input.orderId);
        customerId = context.customerId;
        recipientEmail = context.email;
        canonicalOrderId = context.canonicalOrderId;
      } else if (customerId) {
        const [customer] = await db.select().from(customers).where(eq(customers.id, customerId)).limit(1);
        if (!customer) throw new Error("Kunde nicht gefunden");
        recipientEmail = customer.email || "";
      }

      if (!customerId) throw new Error("Kundenverknüpfung konnte nicht ermittelt werden");
      const result = await sendAndArchiveCrmEmail({
        customerId,
        recipientEmail,
        subject: input.subject,
        htmlBody: input.htmlBody,
        plainText: input.plainText,
        orderId: canonicalOrderId || null,
        createdBy: ctx.user.name || ctx.user.username,
        source: "manual",
        idempotencyKey: input.idempotencyKey,
      });

      if (!result.sent) throw new Error(result.error || "E-Mail konnte nicht versendet werden");
      return result;
    }),

  linkExistingOrder: adminProcedure
    .input(z.object({ orderId: z.string().min(1) }))
    .mutation(async ({ input }) => resolveCustomerForOrder(input.orderId)),
});
